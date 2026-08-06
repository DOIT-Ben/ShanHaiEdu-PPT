import type { QuickDeckEvaluationRepository } from '../core/quick-deck-evaluation-ports'
import type { QuickDeckEvaluationEvent } from '../quick-deck-evaluation-contracts'

export const DEFAULT_QUICK_DECK_EVENT_BATCH_LIMIT = 100

type Subscriber = {
  cursor: number
  onEvent: (event: QuickDeckEvaluationEvent) => boolean
  onClose: () => void
}

type Channel = {
  cursor: number
  terminalSequence: number | null
  subscribers: Set<Subscriber>
  timer: ReturnType<typeof setTimeout> | null
  polling: boolean
}

export class QuickDeckEvaluationEventBroker {
  readonly #channels = new Map<string, Channel>()

  constructor(private readonly input: Readonly<{
    repository: QuickDeckEvaluationRepository
    pollMs: number
  }>) {}

  async subscribe(input: Readonly<{
    jobId: string
    after: number
    onEvent: Subscriber['onEvent']
    onClose: Subscriber['onClose']
  }>) {
    let channel = this.#channels.get(input.jobId)
    if (!channel) {
      channel = { cursor: input.after, terminalSequence: null, subscribers: new Set(), timer: null, polling: false }
      this.#channels.set(input.jobId, channel)
    }
    let cursor = input.after
    while (cursor < channel.cursor) {
      const page = await this.read(input.jobId, cursor)
      channel.terminalSequence = page.terminalSequence
      if (channel.terminalSequence !== null && channel.terminalSequence <= cursor) {
        input.onClose()
        return () => {}
      }
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
        if (channel.terminalSequence !== null && event.sequence === channel.terminalSequence) {
          input.onClose()
          return () => {}
        }
      }
      if (!page.hasMore || page.events.length === 0) break
    }
    const subscriber: Subscriber = { cursor, onEvent: input.onEvent, onClose: input.onClose }
    channel.subscribers.add(subscriber)
    this.schedule(input.jobId, channel, 0)
    return () => this.remove(input.jobId, channel!, subscriber)
  }

  private schedule(jobId: string, channel: Channel, delay: number) {
    if (channel.timer || channel.polling || channel.subscribers.size === 0) return
    channel.timer = setTimeout(() => {
      channel.timer = null
      void this.poll(jobId, channel)
    }, delay)
  }

  private async poll(jobId: string, channel: Channel) {
    if (channel.polling || channel.subscribers.size === 0) return
    channel.polling = true
    try {
      const page = await this.read(jobId, channel.cursor)
      channel.terminalSequence = page.terminalSequence
      if (channel.terminalSequence !== null && channel.terminalSequence <= channel.cursor) {
        for (const subscriber of [...channel.subscribers]) subscriber.onClose()
        this.stop(jobId, channel)
        return
      }
      let terminal = false
      for (const event of page.events) {
        if (channel.terminalSequence !== null && event.sequence > channel.terminalSequence) break
        channel.cursor = event.sequence
        for (const subscriber of [...channel.subscribers]) {
          if (event.sequence <= subscriber.cursor) continue
          if (!subscriber.onEvent(event)) {
            subscriber.onClose()
            this.remove(jobId, channel, subscriber)
          } else {
            subscriber.cursor = event.sequence
          }
        }
        if (channel.terminalSequence !== null && event.sequence === channel.terminalSequence) {
          terminal = true
          break
        }
      }
      if (terminal) {
        for (const subscriber of [...channel.subscribers]) subscriber.onClose()
        this.stop(jobId, channel)
        return
      }
      this.schedule(jobId, channel, page.hasMore ? 0 : this.input.pollMs)
    } catch {
      for (const subscriber of [...channel.subscribers]) subscriber.onClose()
      this.stop(jobId, channel)
    } finally {
      channel.polling = false
      if (this.#channels.get(jobId) === channel && channel.subscribers.size > 0 && !channel.timer) {
        this.schedule(jobId, channel, this.input.pollMs)
      }
    }
  }

  private read(jobId: string, afterSequence: number) {
    return this.input.repository.readEvents({
      jobId,
      afterSequence,
      limit: DEFAULT_QUICK_DECK_EVENT_BATCH_LIMIT,
    })
  }

  private remove(jobId: string, channel: Channel, subscriber: Subscriber) {
    channel.subscribers.delete(subscriber)
    if (channel.subscribers.size === 0) this.stop(jobId, channel)
  }

  private stop(jobId: string, channel: Channel) {
    if (channel.timer) clearTimeout(channel.timer)
    channel.timer = null
    channel.subscribers.clear()
    if (this.#channels.get(jobId) === channel) this.#channels.delete(jobId)
  }
}
