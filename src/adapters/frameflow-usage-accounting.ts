import type { UsageAccountingPort } from '../core/ports'
import type { UsageOperationEventV2, UsagePermit, UsageRunBill } from '../usage-accounting-contracts'

export interface FrameFlowUsageBackendClient {
  authorizeUsageOperation(input: Readonly<{
    externalUserId: string
    runId: string
    operationIdempotencyKey: string
    pageNumber: number
    revisionRound: number
    model: string
  }>): Promise<UsagePermit>

  ingestUsageEvent(input: Readonly<{
    externalUserId: string
    event: UsageOperationEventV2
  }>): Promise<Readonly<{ replayed: boolean; bill: UsageRunBill }>>

  getUsageRunBill(input: Readonly<{
    externalUserId: string
    runId: string
  }>): Promise<UsageRunBill>

  finalizeUsageRun(input: Readonly<{
    externalUserId: string
    runId: string
    idempotencyKey: string
  }>): Promise<UsageRunBill>
}

function externalUserId(host: Parameters<UsageAccountingPort['getRunBill']>[0]['host']) {
  if (host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')
  return host.externalUserId
}

export class FrameFlowUsageAccountingAdapter implements UsageAccountingPort {
  constructor(private readonly client: FrameFlowUsageBackendClient) {}

  async authorizeOperation(input: Parameters<UsageAccountingPort['authorizeOperation']>[0]) {
    return await this.client.authorizeUsageOperation({
      externalUserId: externalUserId(input.host),
      runId: input.runId,
      operationIdempotencyKey: input.operationIdempotencyKey,
      pageNumber: input.pageNumber,
      revisionRound: input.revisionRound,
      model: input.model,
    })
  }

  async ingestEvent(input: Parameters<UsageAccountingPort['ingestEvent']>[0]) {
    return await this.client.ingestUsageEvent({
      externalUserId: externalUserId(input.host),
      event: input.event,
    })
  }

  async getRunBill(input: Parameters<UsageAccountingPort['getRunBill']>[0]) {
    return await this.client.getUsageRunBill({
      externalUserId: externalUserId(input.host),
      runId: input.runId,
    })
  }

  async finalizeRun(input: Parameters<UsageAccountingPort['finalizeRun']>[0]) {
    return await this.client.finalizeUsageRun({
      externalUserId: externalUserId(input.host),
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
    })
  }
}
