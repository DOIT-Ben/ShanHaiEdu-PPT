import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  KNOWN_AGENT_EVENT_TYPES,
  deliveryUnavailableReasonSchema,
  publicErrorActionSchema,
  publicErrorCategorySchema,
  runStatusSchema,
} from '../src/contracts'

const filename = new URL('../docs/openapi-v1.json', import.meta.url)

describe('OpenAPI v1 contract', () => {
  test('keeps the OpenAPI known event enum in parity with the Zod discriminated union', async () => {
    const document = JSON.parse(await readFile(filename, 'utf8')) as {
      components: {
        schemas: Record<string, {
          enum?: string[]
          oneOf?: Array<{ $ref?: string }>
          allOf?: Array<{
            oneOf?: Array<{
              properties?: {
                type?: { const?: string }
                payload?: {
                  $ref?: string
                  additionalProperties?: boolean
                  required?: string[]
                  properties?: Record<string, Record<string, unknown>>
                }
              }
            }>
          }>
        }>
      }
    }
    const zodKnownTypes = [...KNOWN_AGENT_EVENT_TYPES].sort()

    const openApiKnownTypes = document.components.schemas.KnownAgentEventType?.enum
    expect(openApiKnownTypes ? [...openApiKnownTypes].sort() : undefined).toEqual(zodKnownTypes)
    const runtimeVariantContracts = document.components.schemas.RuntimeAgentEvent?.allOf
      ?.flatMap((item) => item.oneOf ?? [])
      ?? []
    const runtimeVariants = runtimeVariantContracts
      .map((variant) => variant.properties?.type?.const)
      .filter((type): type is string => type !== undefined)
      .sort()
    expect(runtimeVariants).toEqual([
      'approval.required',
      'approval.resolved',
      'budget.updated',
      'issue.detected',
      'issue.resolved',
      'phase.changed',
      'run.resumed',
      'run.started',
      'tool.completed',
      'tool.failed',
      'tool.progress',
      'tool.started',
    ])
    const expectedRequiredFields: Record<string, string[]> = {
      'run.started': ['status'],
      'phase.changed': ['from', 'to'],
      'approval.required': ['kind', 'summary'],
      'approval.resolved': ['kind', 'actionType'],
      'tool.started': ['stepId', 'tool', 'label'],
      'tool.progress': ['stepId', 'completed', 'total'],
      'tool.completed': ['stepId', 'summary'],
      'tool.failed': ['stepId', 'errorCode', 'retryable'],
      'issue.resolved': ['issueId', 'resolution'],
      'budget.updated': ['budgetUnits', 'committedBudgetUnits'],
      'run.resumed': ['status'],
    }
    for (const [type, required] of Object.entries(expectedRequiredFields)) {
      const payload = runtimeVariantContracts.find((variant) => variant.properties?.type?.const === type)
        ?.properties?.payload
      expect(payload?.additionalProperties).toBe(false)
      expect(payload?.required).toEqual(required)
    }
    const payloadFor = (type: string) => runtimeVariantContracts
      .find((variant) => variant.properties?.type?.const === type)?.properties?.payload
    expect(payloadFor('issue.detected')?.$ref).toBe('#/components/schemas/IssueSummary')
    expect(payloadFor('phase.changed')?.properties?.from?.$ref).toBe('#/components/schemas/RunStatus')
    expect(payloadFor('tool.progress')?.properties?.total?.minimum).toBe(1)
    expect(payloadFor('approval.resolved')?.properties?.reason?.minLength).toBe(10)
    expect(payloadFor('run.resumed')?.properties?.status?.$ref).toBe('#/components/schemas/RunStatus')
    expect(document.components.schemas.AgentEvent?.oneOf?.map((item) => item.$ref)).toEqual([
      '#/components/schemas/KnownAgentEvent',
      '#/components/schemas/ForwardCompatibleAgentEvent',
    ])
    const explicitKnownTypes = new Set<string>()
    const collectExplicitEventTypes = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collectExplicitEventTypes)
        return
      }
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      const properties = record.properties as Record<string, unknown> | undefined
      const typeContract = properties?.type as { const?: unknown; enum?: unknown } | undefined
      if (typeof typeContract?.const === 'string') explicitKnownTypes.add(typeContract.const)
      if (Array.isArray(typeContract?.enum)) {
        typeContract.enum.forEach((type) => {
          if (typeof type === 'string') explicitKnownTypes.add(type)
        })
      }
      Object.values(record).forEach(collectExplicitEventTypes)
    }
    for (const component of [
      'RuntimeAgentEvent',
      'V4LifecycleEvent',
      'GenerationBatchEvent',
      'TechnicalRecoveryEvent',
      'LegacyTerminalAgentEvent',
    ]) collectExplicitEventTypes(document.components.schemas[component])
    expect([...explicitKnownTypes].sort()).toEqual(zodKnownTypes)
    expect(JSON.stringify(document.components.schemas.ForwardCompatibleAgentEvent))
      .toContain('#/components/schemas/KnownAgentEventType')
  })

  test('publishes the implemented versioned resources and security boundary', async () => {
    const document = JSON.parse(await readFile(filename, 'utf8')) as {
      openapi: string
      info: { version: string }
      security: unknown[]
      paths: Record<string, Record<string, unknown>>
      components: {
        parameters: Record<string, { name?: string; required?: boolean }>
        responses: Record<string, { headers?: Record<string, unknown> }>
        securitySchemes: Record<string, { description?: string }>
        schemas: Record<string, {
          required?: string[]
          oneOf?: Array<{ $ref?: string; properties?: Record<string, { const?: string }> }>
          properties?: Record<string, { enum?: Array<string | null>; description?: string; const?: string }>
          allOf?: Array<{
            if?: { properties?: Record<string, { const?: string }> }
            then?: {
              required?: string[]
              properties?: Record<string, { const?: string; type?: string }>
            }
          }>
        }>
      }
    }

    expect(document.openapi).toBe('3.1.0')
    expect(document.info.version).toBe('4.3.1')
    expect(document.security).toEqual([{ bearerAuth: [] }])
    expect(Object.keys(document.paths).sort()).toEqual([
      '/health/live',
      '/health/ready',
      '/openapi/v1.json',
      '/v1/admin/operations',
      '/v1/admin/operations/{runId}/actions',
      '/v1/admin/planning-failures',
      '/v1/admin/settings/revision-rounds',
      '/v1/runs',
      '/v1/runs/{runId}',
      '/v1/runs/{runId}/actions',
      '/v1/runs/{runId}/deliveries/{deliveryId}/content',
      '/v1/runs/{runId}/events',
      '/v1/runs/{runId}/events/history',
    ])
    expect(document.paths['/v1/runs/{runId}/events']?.get).toBeDefined()
    expect(document.paths['/v1/runs/{runId}/events/history']?.get).toBeDefined()
    expect(JSON.stringify(document.paths['/v1/runs/{runId}/events'])).toContain('100 events')
    expect(JSON.stringify(document.paths['/v1/runs/{runId}/events'])).toContain('terminal')
    expect(JSON.stringify(document.paths['/v1/runs/{runId}/events'])).toContain('same AgentEvent structure')
    expect(JSON.stringify(document.paths['/v1/runs/{runId}/events/history']))
      .toContain('#/components/schemas/AgentEvent')
    expect(document.paths['/v1/admin/planning-failures']?.get).toBeDefined()
    expect(document.paths['/v1/admin/operations']?.get).toBeDefined()
    expect(document.paths['/v1/admin/operations/{runId}/actions']?.post).toBeDefined()
    expect(document.paths['/v1/admin/settings/revision-rounds']?.get).toBeDefined()
    expect(document.paths['/v1/admin/settings/revision-rounds']?.patch).toBeDefined()
    expect(document.paths['/health/live']?.get).toBeDefined()
    expect(document.paths['/health/ready']?.get).toBeDefined()
    const healthResponseHeaders = (path: '/health/live' | '/health/ready', status: '200' | '503') => {
      const operation = document.paths[path]?.get as {
        responses?: Record<string, { headers?: Record<string, unknown> }>
      } | undefined
      return operation?.responses?.[status]?.headers
    }
    for (const [path, status] of [
      ['/health/live', '200'],
      ['/health/ready', '200'],
      ['/health/ready', '503'],
    ] as const) {
      expect(healthResponseHeaders(path, status)?.Link).toBeDefined()
      expect(healthResponseHeaders(path, status)?.['X-PPT-Agent-Contract-Version']).toBeDefined()
      expect(healthResponseHeaders(path, status)?.['X-Request-ID']).toBeDefined()
    }
    const discoveryResponse = (document.paths['/openapi/v1.json']?.get as any)?.responses?.['200']
    expect(discoveryResponse?.headers?.['X-Request-ID']).toBeDefined()
    expect(JSON.stringify(document.paths['/openapi/v1.json'])).toContain('application/vnd.oai.openapi+json')
    expect(JSON.stringify(document.paths['/openapi/v1.json'])).toContain('service-desc')
    expect(document.components.schemas.BuildIdentity).toBeDefined()
    expect(document.components.schemas.Liveness?.required).toEqual(expect.arrayContaining(['release']))
    expect(document.components.schemas.Readiness?.required).toEqual(expect.arrayContaining(['release']))
    expect(JSON.stringify(document.components.schemas.Liveness?.properties?.release))
      .toContain('#/components/schemas/BuildIdentity')
    expect(JSON.stringify(document.components.schemas.Readiness?.properties?.release))
      .toContain('#/components/schemas/BuildIdentity')
    expect(JSON.stringify(document.components.schemas.Readiness?.properties?.worker))
      .toContain('activeOperationCount')
    expect(JSON.stringify(document.components.schemas.Readiness?.properties?.worker))
      .toContain('lastTickActivityAt')
    expect(document.components.parameters.IdempotencyKey?.required).toBe(true)
    expect(document.components.parameters.TenantId).toMatchObject({ name: 'X-PPT-Agent-Tenant', required: true })
    expect(document.components.parameters.ExternalUserId).toMatchObject({ name: 'X-PPT-Agent-User', required: true })
    expect(document.components.parameters.ExternalProjectId).toMatchObject({ name: 'X-PPT-Agent-Project', required: false })
    expect(document.components.responses.RateLimited?.headers?.['Retry-After']).toBeDefined()
    expect(document.components.securitySchemes.bearerAuth?.description).toContain('administrator')
    for (const path of ['/v1/runs', '/v1/runs/{runId}/actions', '/v1/admin/operations/{runId}/actions']) {
      expect(JSON.stringify(document.paths[path]?.parameters)).toContain('#/components/parameters/TenantId')
      expect(JSON.stringify(document.paths[path]?.parameters)).toContain('#/components/parameters/ExternalUserId')
    }
    expect(JSON.stringify(document.paths['/v1/runs']?.post)).toContain('#/components/responses/RateLimited')
    expect(JSON.stringify(document.paths['/v1/runs/{runId}/actions']?.post)).toContain('#/components/responses/RateLimited')
    expect(JSON.stringify(document.paths['/v1/admin/operations/{runId}/actions']?.post)).toContain('#/components/responses/RateLimited')
    expect(JSON.stringify(document.paths['/v1/runs']?.get)).toContain('keyset')
    expect(document.components.schemas.HostContext?.properties?.role?.enum).toEqual(['USER', 'ADMIN'])
    expect(document.components.schemas.PublicRun?.properties?.progress).toBeDefined()
    expect(document.components.schemas.PublicRun?.required).toContain('schemaVersion')
    expect(document.components.schemas.PublicRun?.properties?.schemaVersion?.const).toBe('1')
    expect(document.components.schemas.PublicRun?.properties?.technicalRecovery).toBeDefined()
    expect(document.components.schemas.PublicRun?.properties?.generationBatch).toBeDefined()
    expect(document.components.schemas.PublicRun?.properties?.pendingTerminalFailure).toBeDefined()
    expect(document.components.schemas.PublicRun?.properties?.terminalAccounting).toBeDefined()
    expect(document.components.schemas.PublicRun?.properties?.release).toBeDefined()
    expect(document.components.schemas.TechnicalRecovery).toBeDefined()
    expect(document.components.schemas.TechnicalRecovery?.properties?.resumeState?.enum)
      .toEqual(['PLANNING', 'EXECUTING', 'PAGE_REVIEW', 'DECK_REVIEW', 'REVISING', 'DELIVERING'])
    expect(document.components.schemas.GenerationBatch).toBeDefined()
    expect(document.components.schemas.GenerationBatch?.properties?.accounting).toBeDefined()
    expect(JSON.stringify(document.components.schemas.GenerationBatch?.properties?.accounting))
      .toContain('"settlement"')
    expect(document.components.schemas.ReleaseIdentity).toBeDefined()
    expect(document.components.schemas.PublicRun?.properties?.presentationMode?.enum)
      .toContain('VISUAL_DECK_V4')
    expect(document.components.schemas.CreateRunRequest?.properties?.assetAcquisitionPolicy?.enum)
      .toEqual(['AI_FIRST', 'SEARCH_FIRST'])
    expect(document.components.schemas.CreateRunRequest?.properties?.presentationMode?.enum)
      .toEqual(['SLIDE_IMAGE_V2', 'SLIDE_IMAGE_V2_1', 'LAYERED_COURSEWARE_V3', 'VISUAL_DECK_V4'])
    expect(document.components.schemas.CreateRunRequest?.properties?.visualDeckV4).toBeDefined()
    expect(document.components.schemas.VisualDeckV4GenerationPlan).toBeDefined()
    expect(document.components.schemas.AdminRevisionRoundsSettings).toBeDefined()
    expect(document.components.schemas.RunDetailEnvelope).toBeDefined()
    expect(document.components.schemas.AgentEventEnvelope?.required).toEqual(expect.arrayContaining([
      'schemaVersion', 'id', 'eventId', 'runId', 'sequence', 'type', 'payload',
    ]))
    expect(document.components.schemas.KnownAgentEvent?.oneOf?.map((item) => item.$ref)).toEqual([
      '#/components/schemas/RuntimeAgentEvent',
      '#/components/schemas/V4LifecycleEvent',
      '#/components/schemas/GenerationBatchEvent',
      '#/components/schemas/TechnicalRecoveryEvent',
      '#/components/schemas/LegacyTerminalAgentEvent',
    ])
    expect(JSON.stringify(document.components.schemas.GenerationBatchEvent))
      .toContain('generation.batch.updated')
    expect(JSON.stringify(document.components.schemas.TechnicalRecoveryEvent))
      .toContain('technical.recovery.completed')
    expect(document.components.schemas.V4LifecyclePayload?.properties?.reason?.enum).toEqual(expect.arrayContaining([
      'BUDGET_INSUFFICIENT', 'PROVIDER_TEMPORARILY_UNAVAILABLE', 'REVISION_LIMIT_REACHED',
      'USER_CONFIRMATION_REQUIRED',
    ]))
    expect(document.components.schemas.V4LifecyclePayload?.properties?.revisionKind?.enum)
      .toEqual(['PAGE_VISUAL', 'DECK_CONTENT', 'DECK_VISUAL', null])
    expect(document.components.schemas.V4LifecycleEvent).toBeDefined()
    expect(JSON.stringify(document.components.schemas.V4LifecycleEvent)).toContain('"stage":{"const":"REVISION"}')
    const v4LifecycleEvent = JSON.stringify(document.components.schemas.V4LifecycleEvent)
    for (const errorCode of [
      'WORKER_FATAL',
      'QUALITY_REMEDIATION_EXHAUSTED',
      'QUALITY_ISSUE_STATE_INCONSISTENT',
      'TECHNICAL_RECOVERY_EXHAUSTED',
      'TECHNICAL_CONFIGURATION_REQUIRED',
      'TECHNICAL_CONTRACT_INVALID',
    ]) {
      expect(v4LifecycleEvent).toContain(errorCode)
    }
    expect(v4LifecycleEvent).toContain('#/components/schemas/TerminalAccounting')
    expect(v4LifecycleEvent).toContain('run.accounting.finalized')
    expect(document.components.schemas.TerminalAccounting).toBeDefined()
    expect(JSON.stringify(document.components.schemas.TerminalAccounting)).toContain('RECONCILIATION_REQUIRED')
    expect(document.components.schemas.DeliveryRecord).toBeDefined()
    const deliveryRecord = JSON.stringify(document.components.schemas.DeliveryRecord)
    expect(document.components.schemas.DeliveryRecord?.required).toContain('schemaVersion')
    expect(document.components.schemas.DeliveryRecord?.properties?.schemaVersion?.const).toBe('1')
    expect(deliveryRecord).toContain('"disposition":{"const":"FINAL"}')
    expect(deliveryRecord).toContain('OVERRIDDEN_INTERNAL')
    expect(deliveryRecord).toContain('SYSTEM_POLICY_ACCEPTED')
    expect(deliveryRecord).toContain('qualityPolicyAudit')
    expect(deliveryRecord).toContain('SYSTEM_POLICY')
    expect(deliveryRecord).toContain('#/components/schemas/DeliveryIdentity')
    const deliveryIdentity = JSON.stringify(document.components.schemas.DeliveryIdentity)
    expect(deliveryIdentity).not.toContain('LEGACY_UNVERIFIED')
    expect(deliveryIdentity).toContain('blueprintHash')
    expect(deliveryIdentity).toContain('proposalHash')
    expect(JSON.stringify(document.components.schemas.RunDetail))
      .toContain('#/components/schemas/DeliveryRecord')
    const runDetailContract = JSON.stringify(document.components.schemas.RunDetail)
    expect(runDetailContract).toContain('#/components/schemas/AvailableDeliveryAvailability')
    expect(runDetailContract).toContain('#/components/schemas/UnavailableDeliveryAvailability')
    expect(runDetailContract).toContain('"status":{"const":"COMPLETED"}')
    expect(runDetailContract).toContain('"minItems":1,"maxItems":1')
    expect(runDetailContract).toContain('"maxItems":0')
    expect(JSON.stringify(document.components.schemas.RunDetailEnvelope))
      .toContain('#/components/schemas/RunDetail')
    expect(document.components.schemas.DeliveryAvailability).toBeDefined()
    expect(JSON.stringify(document.paths['/v1/runs/{runId}']?.get))
      .toContain('#/components/schemas/RunDetailEnvelope')
    expect(document.components.schemas.CreateRunRequest?.properties?.targetAudience).toBeDefined()
    expect(document.components.schemas.CreateRunRequest?.properties?.presentationGoal).toBeDefined()
    expect(document.components.schemas.PublicRun?.properties?.assetAcquisitionPolicy?.enum)
      .toEqual(['AI_FIRST', 'SEARCH_FIRST'])
    expect(document.components.schemas.PublicRun?.properties?.qualityDisposition?.enum).toEqual([
      'PENDING', 'REVIEW_PASSED', 'SYSTEM_POLICY_ACCEPTED', 'ADMIN_OVERRIDE', 'HARD_FAILURE',
    ])
    expect(document.components.schemas.PublicRun?.properties?.qualityDisposition?.description)
      .toContain('qualityOverride false')
    const publicRunContract = JSON.stringify(document.components.schemas.PublicRun)
    expect(publicRunContract).toContain('"qualityDisposition":{"enum":["PENDING","REVIEW_PASSED"]}')
    expect(publicRunContract).toContain('"if":{"properties":{"qualityDisposition":{"const":"SYSTEM_POLICY_ACCEPTED"}}')
    expect(publicRunContract).toContain('"if":{"properties":{"qualityDisposition":{"const":"ADMIN_OVERRIDE"}}')
    expect(publicRunContract).toContain('"if":{"properties":{"status":{"const":"FAILED"}}')
    expect(publicRunContract).toContain('"if":{"properties":{"qualityDisposition":{"const":"HARD_FAILURE"}}')
    const hardFailureRule = document.components.schemas.PublicRun?.allOf?.find((rule) =>
      rule.if?.properties?.qualityDisposition?.const === 'HARD_FAILURE')
    expect(hardFailureRule?.then).toMatchObject({
      required: ['qualityPolicyAudit', 'qualityOverrideAudit'],
      properties: {
        status: { const: 'FAILED' },
        qualityPolicyAudit: { type: 'null' },
        qualityOverrideAudit: { type: 'null' },
      },
    })
    expect(deliveryRecord).toContain('"if":{"properties":{"qualityStatus":{"const":"SYSTEM_POLICY_ACCEPTED"}}')
    expect(deliveryRecord).toContain('"if":{"properties":{"qualityStatus":{"const":"OVERRIDDEN_INTERNAL"}}')
    expect(deliveryRecord).toContain('"if":{"properties":{"qualityStatus":{"const":"APPROVED"}}')
    expect(document.components.schemas.RunAction?.properties?.type?.enum).toEqual(expect.arrayContaining([
      'RETRY_PLANNING', 'RETRY_DELIVERY', 'REPLAN', 'ACCEPT_WITH_OVERRIDE', 'CANCEL',
    ]))
    expect(document.components.schemas.DocumentSource?.oneOf?.map((source) => source.properties?.kind?.const)).toContain('SOURCE_PACKAGE')
    expect(document.components.schemas.DocumentSource?.oneOf?.map((source) => source.properties?.kind?.const)).toContain('APPROVED_PAGE_DESIGN')
    expect(document.components.schemas.BlueprintSourceManifestEntry).toBeDefined()
    expect(document.components.schemas.BlueprintSourceAsset).toBeDefined()
    expect(document.components.schemas.PlanningFailure?.properties?.errorCode?.enum).toEqual(expect.arrayContaining([
      'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID', 'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE',
    ]))
    expect(document.components.schemas.ErrorEnvelope?.required).toContain('schemaVersion')
    expect(document.components.schemas.ErrorEnvelope?.properties?.schemaVersion?.const).toBe('1')
    const contentContract = JSON.stringify(document.paths['/v1/runs/{runId}/deliveries/{deliveryId}/content'])
    expect(contentContract).toContain('DELIVERY_NOT_AVAILABLE')
    expect(contentContract).toContain('#/components/schemas/DeliveryUnavailableError')
    expect(JSON.stringify(document.components.schemas.DeliveryUnavailableError))
      .toContain('#/components/schemas/DeliveryUnavailableReason')
    expect(contentContract).toContain('X-PPT-Agent-Schema-Version')
    expect(contentContract).toContain('X-PPT-Agent-Delivery-ID')
    expect(contentContract).toContain('X-PPT-Agent-Content-SHA256')

    const publicDocument = document as any
    const responseAt = (path: string, method: string, status: string) =>
      publicDocument.paths[path]?.[method]?.responses?.[status]
    for (const [path, method, status] of [
      ['/v1/runs', 'post', '201'],
      ['/v1/runs/{runId}', 'get', '200'],
      ['/v1/runs/{runId}/events', 'get', '200'],
      ['/v1/runs/{runId}/events/history', 'get', '200'],
      ['/v1/runs/{runId}/deliveries/{deliveryId}/content', 'get', '200'],
      ['/v1/runs/{runId}/deliveries/{deliveryId}/content', 'get', '409'],
    ] as const) {
      expect(responseAt(path, method, status)?.headers?.['X-PPT-Agent-Contract-Version']).toBeDefined()
      expect(responseAt(path, method, status)?.headers?.['X-Request-ID']).toBeDefined()
      expect(responseAt(path, method, status)?.headers?.Link).toBeDefined()
    }
    expect(JSON.stringify(responseAt('/v1/runs', 'post', '201')))
      .toContain('#/components/schemas/CreateRunEnvelope')
    expect(publicDocument.components.schemas.CreateRunEnvelope?.required)
      .toEqual(['schemaVersion', 'requestId', 'data', 'replayed'])
    expect(publicDocument.components.schemas.RunDetailEnvelope?.required)
      .toEqual(['schemaVersion', 'requestId', 'data'])
    expect(publicDocument.components.schemas.RunEnvelope?.required)
      .toEqual(['schemaVersion', 'requestId', 'data'])
    const historyContract = responseAt('/v1/runs/{runId}/events/history', 'get', '200')
      ?.content?.['application/json']?.schema
    expect(historyContract?.required).toEqual(['schemaVersion', 'requestId', 'data', 'pagination'])
    expect(publicDocument.components.schemas.PublicRun?.required).toContain('error')
    expect(JSON.stringify(publicDocument.components.schemas.PublicRun?.properties?.error))
      .toContain('#/components/schemas/PublicError')
    const publicRunRules = publicDocument.components.schemas.PublicRun?.allOf ?? []
    const interruptedErrorRule = publicRunRules.find((rule: Record<string, any>) =>
      JSON.stringify(rule.if?.properties?.status?.enum) === JSON.stringify(['RECOVERING', 'FAILED']))
    expect(interruptedErrorRule?.then?.properties?.error?.$ref)
      .toBe('#/components/schemas/PublicError')
    const normalRunErrorRule = publicRunRules.find((rule: Record<string, any>) =>
      JSON.stringify(rule.if?.properties?.status?.not?.enum)
        === JSON.stringify(['PAUSED', 'RECOVERING', 'FAILED']))
    expect(normalRunErrorRule?.then?.properties?.error?.type).toBe('null')
    expect(publicDocument.components.schemas.RunStatus?.enum).toEqual(runStatusSchema.options)
    expect(publicDocument.components.schemas.DeliveryUnavailableReason?.enum)
      .toEqual(deliveryUnavailableReasonSchema.options)
    expect(publicDocument.components.schemas.PublicErrorCategory?.enum)
      .toEqual(publicErrorCategorySchema.options)
    expect(publicDocument.components.schemas.PublicErrorAction?.enum)
      .toEqual(publicErrorActionSchema.options)
    expect(publicDocument.components.schemas.PublicError?.required).toEqual([
      'code', 'category', 'retryable', 'action', 'requestId', 'runId',
    ])
    expect(publicDocument.components.schemas.ErrorEnvelope?.properties?.error?.required)
      .toEqual(['code', 'category', 'message', 'retryable', 'action', 'requestId', 'runId'])
    expect(JSON.stringify(publicDocument.components.schemas.V4LifecycleEvent))
      .toContain('#/components/schemas/PublicError')
    expect(publicDocument.components.schemas.TechnicalRecovery?.properties?.category?.$ref)
      .toBe('#/components/schemas/PublicErrorCategory')
  })
})
