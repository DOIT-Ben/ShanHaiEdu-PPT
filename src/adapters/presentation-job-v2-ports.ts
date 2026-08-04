import PptxGenJS from 'pptxgenjs'
import type {
  PresentationJobV2BudgetPolicy,
  PresentationJobV2ProviderPort,
  PresentationJobV2ProviderResult,
} from '../core/presentation-job-v2-ports'

export class FixedServicePresentationJobBudgetPolicy implements PresentationJobV2BudgetPolicy {
  readonly authorizations: Parameters<PresentationJobV2BudgetPolicy['authorize']>[0][] = []

  constructor(private readonly maximumProviderOperations: number) {
    if (!Number.isSafeInteger(maximumProviderOperations) || maximumProviderOperations < 1) {
      throw new Error('PRESENTATION_JOB_SERVICE_CAP_INVALID')
    }
  }

  async authorize(input: Parameters<PresentationJobV2BudgetPolicy['authorize']>[0]) {
    this.authorizations.push(structuredClone(input))
    return { allowed: input.priorProviderOperations < this.maximumProviderOperations }
  }
}

type Operation = Readonly<{
  idempotencyKey: string
  operationId: string
  source: Parameters<PresentationJobV2ProviderPort['submit']>[0]['source']
  inspections: number
  result: PresentationJobV2ProviderResult
}>

export class DeterministicPresentationJobV2Provider implements PresentationJobV2ProviderPort {
  readonly submitRequests: Parameters<PresentationJobV2ProviderPort['submit']>[0][] = []
  readonly inspectRequests: Parameters<PresentationJobV2ProviderPort['inspect']>[0][] = []
  readonly #operations = new Map<string, Operation>()

  get submitCalls() {
    return this.submitRequests.length
  }

  async submit(input: Parameters<PresentationJobV2ProviderPort['submit']>[0]) {
    this.submitRequests.push(structuredClone(input))
    const existing = this.#operations.get(input.idempotencyKey)
    if (existing) return { operationId: existing.operationId }
    const operationId = `presentation-operation-${this.#operations.size + 1}`
    this.#operations.set(input.idempotencyKey, {
      idempotencyKey: input.idempotencyKey,
      operationId,
      source: structuredClone(input.source),
      inspections: 0,
      result: await this.completedResult(input.source, 'PASSED', 'SETTLED'),
    })
    return { operationId }
  }

  async inspect(input: Parameters<PresentationJobV2ProviderPort['inspect']>[0]) {
    this.inspectRequests.push(structuredClone(input))
    const entry = [...this.#operations.values()].find((candidate) => candidate.operationId === input.operationId)
    if (!entry) throw new Error('PRESENTATION_OPERATION_NOT_FOUND')
    this.#operations.set(entry.idempotencyKey, { ...entry, inspections: entry.inspections + 1 })
    return structuredClone(entry.result)
  }

  async complete(
    idempotencyKey: string,
    quality: 'PASSED' | 'BEST_EFFORT' | 'BLOCKING_FAILURE' = 'PASSED',
    billingStatus: 'SETTLED' | 'UNKNOWN' = 'SETTLED',
  ) {
    const entry = this.#operations.get(idempotencyKey)
    if (!entry) throw new Error('PRESENTATION_OPERATION_NOT_FOUND')
    this.#operations.set(entry.idempotencyKey, {
      ...entry,
      inspections: 1,
      result: await this.completedResult(entry.source, quality, billingStatus),
    })
  }

  async fail(idempotencyKey: string, errorCode = 'PROVIDER_FAILURE', billingStatus: 'SETTLED' | 'UNKNOWN' = 'SETTLED') {
    const entry = this.#operations.get(idempotencyKey)
    if (!entry) throw new Error('PRESENTATION_OPERATION_NOT_FOUND')
    this.#operations.set(entry.idempotencyKey, {
      ...entry,
      inspections: 1,
      result: { state: 'FAILED', errorCode, billingStatus },
    })
  }

  async resolveBilling(idempotencyKey: string) {
    const entry = this.#operations.get(idempotencyKey)
    if (!entry || entry.result.state !== 'COMPLETED') throw new Error('PRESENTATION_OPERATION_NOT_COMPLETED')
    this.#operations.set(entry.idempotencyKey, {
      ...entry,
      result: { ...entry.result, billingStatus: 'SETTLED' },
    })
  }

  private async completedResult(
    source: Parameters<PresentationJobV2ProviderPort['submit']>[0]['source'],
    quality: 'PASSED' | 'BEST_EFFORT' | 'BLOCKING_FAILURE',
    billingStatus: 'SETTLED' | 'UNKNOWN',
  ): Promise<Extract<PresentationJobV2ProviderResult, { state: 'COMPLETED' }>> {
    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_WIDE'
    for (const page of source.snapshot.pages) {
      pptx.addSlide().addText(page.title, { x: 0.8, y: 0.8, w: 10, h: 0.8, fontSize: 28 })
    }
    const output = await pptx.write({ outputType: 'uint8array', compression: true })
    if (!(output instanceof Uint8Array)) throw new Error('PRESENTATION_PPTX_OUTPUT_INVALID')
    return {
      state: 'COMPLETED',
      artifact: {
        bytes: new Uint8Array(output),
        name: 'presentation.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
      quality,
      billingStatus,
    }
  }
}

export class MockPresentationJobV2Provider extends DeterministicPresentationJobV2Provider {}
