import type { KnownAgentEvent as AgentEvent } from '../contracts'
import type { AgentRepository } from '../core/ports'
import { isTerminalStatus } from '../core/policy'

type Subscriber = {
  cursor: number
  onEvent: (event: AgentEvent) => boolean
  onClose: () => void
}

type RunChannel = {
  cursor: number
  terminalSequence: number | null
  terminalReady: Promise<void>
  subscribers: Set<Subscriber>
  timer: ReturnType<typeof setTimeout> | null
  polling: boolean
}

export const DEFAULT_EVENT_BATCH_LIMIT = 100
export const DEFAULT_EVENT_BATCH_BYTES = 256 * 1024

export class RunEventBroker {
  private readonly channels = new Map<string, RunChannel>()

  constructor(private readonly input: Readonly<{
    repository: AgentRepository
    pollMs: number
    eventLimit?: number
    maxBytes?: number
  }>) {}

  async subscribe(input: Readonly<{
    runId: string
    after: number
    onEvent: Subscriber['onEvent']
    onClose: Subscriber['onClose']
  }>) {
    let channel = this.channels.get(input.runId)
    if (!channel) {
      channel = {
        cursor: input.after,
        terminalSequence: null,
        terminalReady: Promise.resolve(),
        subscribers: new Set(),
        timer: null,
        polling: false,
      }
      this.channels.set(input.runId, channel)
      const initializingChannel = channel
      channel.terminalReady = this.input.repository.getTerminalEvent(input.runId).then((terminal) => {
        initializingChannel.terminalSequence = terminal?.sequence ?? null
      })
    }
    try {
      await channel.terminalReady
    } catch {
      input.onClose()
      if (channel.subscribers.size === 0) this.stop(input.runId, channel)
      return () => {}
    }
    if (channel.terminalSequence !== null && input.after >= channel.terminalSequence) {
      input.onClose()
      if (channel.subscribers.size === 0) this.stop(input.runId, channel)
      return () => {}
    }
    let cursor = input.after
    while (cursor < channel.cursor) {
      const page = await this.read(input.runId, cursor)
      for (const event of page.events) {
        if (channel.terminalSequence !== null && event.sequence > channel.terminalSequence) {
          input.onClose()
          return () => {}
        }
        if (!input.onEvent(event)) {
          input.onClose()
          return () => {}
        }
        cursor = event.sequence
        if (this.isTerminalEvent(event)) {
          input.onClose()
          return () => {}
        }
      }
      if (!page.hasMore || page.events.length === 0) break
    }
    const subscriber: Subscriber = { cursor, onEvent: input.onEvent, onClose: input.onClose }
    channel.subscribers.add(subscriber)
    this.schedule(input.runId, channel, 0)
    return () => this.remove(input.runId, channel!, subscriber)
  }

  activePollers() { return this.channels.size }

  private schedule(runId: string, channel: RunChannel, delay: number) {
    if (channel.timer || channel.polling || channel.subscribers.size === 0) return
    channel.timer = setTimeout(() => {
      channel.timer = null
      void this.poll(runId, channel)
    }, delay)
  }

  private async poll(runId: string, channel: RunChannel) {
    if (channel.polling || channel.subscribers.size === 0) return
    channel.polling = true
    try {
      const page = await this.read(runId, channel.cursor)
      let terminal = false
      for (const event of page.events) {
        if (channel.terminalSequence !== null && event.sequence > channel.terminalSequence) break
        channel.cursor = event.sequence
        for (const subscriber of [...channel.subscribers]) {
          if (event.sequence <= subscriber.cursor) continue
          if (!subscriber.onEvent(event)) {
            subscriber.onClose()
            this.remove(runId, channel, subscriber)
          }
          else subscriber.cursor = event.sequence
        }
        if (this.isTerminalEvent(event)) {
          channel.terminalSequence = event.sequence
          terminal = true
          break
        }
      }
      if (!terminal && page.events.length === 0) {
        const run = await this.input.repository.getRun(runId)
        terminal = Boolean(run && isTerminalStatus(run.status)
          && !(run.status === 'FAILED'
            && run.terminalAccounting?.accountingStatus === 'RECONCILIATION_REQUIRED'))
      }
      if (terminal) {
        for (const subscriber of [...channel.subscribers]) subscriber.onClose()
        this.stop(runId, channel)
        return
      }
      this.schedule(runId, channel, page.hasMore ? 0 : this.input.pollMs)
    } catch {
      for (const subscriber of [...channel.subscribers]) subscriber.onClose()
      this.stop(runId, channel)
    } finally {
      channel.polling = false
      if (this.channels.get(runId) === channel && channel.subscribers.size > 0 && !channel.timer) {
        this.schedule(runId, channel, this.input.pollMs)
      }
    }
  }

  private read(runId: string, afterSequence: number) {
    return this.input.repository.readEvents(runId, {
      afterSequence,
      limit: this.input.eventLimit ?? DEFAULT_EVENT_BATCH_LIMIT,
      maxBytes: this.input.maxBytes ?? DEFAULT_EVENT_BATCH_BYTES,
    })
  }

  private isTerminalEvent(event: AgentEvent) {
    if (event.type === 'run.accounting.finalized') return true
    if (event.type === 'run.failed') {
      return !('terminalAccounting' in event.payload)
        || event.payload.terminalAccounting?.accountingStatus !== 'RECONCILIATION_REQUIRED'
    }
    return event.type === 'run.completed' || event.type === 'run.cancelled'
  }

  private remove(runId: string, channel: RunChannel, subscriber: Subscriber) {
    channel.subscribers.delete(subscriber)
    if (channel.subscribers.size === 0) this.stop(runId, channel)
  }

  private stop(runId: string, channel: RunChannel) {
    if (channel.timer) clearTimeout(channel.timer)
    channel.timer = null
    channel.subscribers.clear()
    if (this.channels.get(runId) === channel) this.channels.delete(runId)
  }
}
