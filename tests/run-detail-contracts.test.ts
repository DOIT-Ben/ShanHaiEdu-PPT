import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { runDetailSchema } from '../src/run-detail-contracts'

const runId = 'run-contract-1'
const deliveryId = `${runId}:delivery:r0`

const publicDelivery = {
  schemaVersion: CONTRACT_VERSION,
  id: deliveryId,
  runId,
  revisionRound: 0,
  qualityScore: 92,
  qualityOverride: false,
  disposition: 'FINAL' as const,
  qualityStatus: 'APPROVED' as const,
  openIssueIds: [],
  identity: {
    status: 'VERIFIED' as const,
    slideCount: 2,
    pageNumbers: [1, 2],
    blueprintHash: 'a'.repeat(64),
  },
  qualityPolicyAudit: null,
  qualityOverrideAudit: null,
  preview: {
    artifactId: 'artifact-preview-1',
    name: 'preview.png',
    mimeType: 'image/png' as const,
    sha256: 'b'.repeat(64),
    byteLength: 1024,
  },
  pptx: {
    artifactId: 'artifact-pptx-1',
    name: 'lesson.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const,
    sha256: 'c'.repeat(64),
    byteLength: 4096,
  },
  createdAt: '2026-08-04T00:00:00.000Z',
}

const completedRunDetail = {
  schemaVersion: CONTRACT_VERSION,
  id: runId,
  host: { tenantId: 'frameflow', externalUserId: 'user-1', externalProjectId: 'deck-1' },
  status: 'COMPLETED' as const,
  resumeState: null,
  visualDirection: '清晰、克制的课堂信息图风格',
  targetAudience: null,
  presentationGoal: null,
  imageModel: 'gpt-image-2',
  automationLevel: 'SUPERVISED' as const,
  version: 8,
  slideCount: 2,
  revisionRound: 0,
  maxRevisionRounds: 2,
  planningAttempt: 0,
  maxPlanningRetries: 2 as const,
  budgetUnits: 100,
  committedBudgetUnits: 2,
  qualityScore: 92,
  qualityOverride: false,
  qualityDisposition: 'REVIEW_PASSED' as const,
  qualityPolicyAudit: null,
  qualityOverrideAudit: null,
  error: null,
  blueprint: null,
  generationPlan: null,
  deliveries: [publicDelivery],
  deliveryAvailability: {
    state: 'AVAILABLE' as const,
    deliveryId,
    disposition: 'FINAL' as const,
    identityStatus: 'VERIFIED' as const,
  },
  issues: [],
  progress: [],
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:05:00.000Z',
}

describe('public RunDetail contract', () => {
  test('accepts the exact readable delivery authorized by a completed Run', () => {
    const detail = runDetailSchema.parse(completedRunDetail)

    expect(detail.deliveryAvailability).toMatchObject({ state: 'AVAILABLE', deliveryId })
    expect(detail.deliveries).toHaveLength(1)
    expect(detail.deliveries[0]).toMatchObject({ id: deliveryId, runId, disposition: 'FINAL' })
  })

  test('keeps completed and non-completed unavailable projections valid', () => {
    expect(runDetailSchema.safeParse({
      ...completedRunDetail,
      deliveries: [],
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'VERIFIED_FINAL_DELIVERY_MISSING' },
    }).success).toBe(true)
    expect(runDetailSchema.safeParse({
      ...completedRunDetail,
      status: 'EXECUTING',
      qualityScore: null,
      qualityDisposition: 'PENDING',
      deliveries: [],
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_NOT_COMPLETED' },
    }).success).toBe(true)
  })

  test('rejects incomplete, ambiguous, mismatched, or unreadable available projections', () => {
    const { deliveries: _deliveries, ...withoutDeliveries } = completedRunDetail
    const { deliveryAvailability: _deliveryAvailability, ...withoutAvailability } = completedRunDetail
    const invalidDetails = [
      withoutDeliveries,
      withoutAvailability,
      { ...completedRunDetail, deliveries: [] },
      { ...completedRunDetail, status: 'DELIVERING' },
      {
        ...completedRunDetail,
        deliveries: [{ ...publicDelivery, runId: 'run-other' }],
      },
      {
        ...completedRunDetail,
        deliveryAvailability: { ...completedRunDetail.deliveryAvailability, deliveryId: 'delivery-other' },
      },
      {
        ...completedRunDetail,
        deliveries: [{ ...publicDelivery, id: 'delivery-other' }],
      },
      {
        ...completedRunDetail,
        deliveries: [publicDelivery, { ...publicDelivery }],
      },
      {
        ...completedRunDetail,
        deliveries: [{ ...publicDelivery, identity: { status: 'LEGACY_UNVERIFIED' } }],
      },
      {
        ...completedRunDetail,
        deliveries: [{ ...publicDelivery, preview: undefined }],
      },
      {
        ...completedRunDetail,
        deliveries: [{ ...publicDelivery, pptx: undefined }],
      },
      {
        ...completedRunDetail,
        deliveries: [{ ...publicDelivery, preview: { ...publicDelivery.preview, mimeType: 'image/jpeg' } }],
      },
      {
        ...completedRunDetail,
        deliveries: [{ ...publicDelivery, pptx: { ...publicDelivery.pptx, byteLength: 0 } }],
      },
    ]

    for (const detail of invalidDetails) {
      expect(runDetailSchema.safeParse(detail).success).toBe(false)
    }
  })

  test('does not expose a public Delivery while availability is unavailable', () => {
    expect(runDetailSchema.safeParse({
      ...completedRunDetail,
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'DELIVERY_CONTENT_INVALID' },
    }).success).toBe(false)
  })
})
