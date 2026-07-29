import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { passesDeckQuality } from '../dist/core/deck-review-runner.js'
import { deckReviewSchema, revisionPlanSchema } from '../dist/presentation-contracts.js'

const RUN_ID = 'run-86529d771703468d4f4efd1e4439'
const PARENT_ID = 'd9a63ca4-9f7b-4295-9f3d-3ba2ecdc0ee5'
const EXPECTED_PAGES = [1, 3, 4, 5, 7, 11]
const R0_COMPENSATION_KEY = `ppt-agent:quality-retry-compensation:${RUN_ID}:r0`
const R1_COMPENSATION_KEY = `ppt-agent:quality-retry-compensation:${RUN_ID}:r1-rejected`
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function option(name) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  assert(value && !value.startsWith('--'), `missing ${name}`)
  return value
}

function assertRelease(expectedSha) {
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'REVISION_VERIFY_EXPECTED_SHA_INVALID')
  const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'))
  assert(manifest?.gitSha === expectedSha, 'REVISION_VERIFY_RELEASE_SHA_MISMATCH')
}

function assertDatabase(database, prefix) {
  const integrity = database.query('PRAGMA integrity_check').all()
  assert(integrity.length === 1 && Object.values(integrity[0])[0] === 'ok', `${prefix}_INTEGRITY_FAILED`)
  assert(database.query('PRAGMA foreign_key_check').all().length === 0, `${prefix}_FOREIGN_KEY_FAILED`)
}

function verifyArtifact(root, artifact, expectedMime) {
  assert(artifact?.mimeType === expectedMime && /^artifact-[a-f0-9]{40}$/.test(artifact.artifactId),
    'REVISION_VERIFY_ARTIFACT_CONTRACT_MISMATCH')
  const directory = path.join(root, artifact.artifactId)
  const metadata = JSON.parse(readFileSync(path.join(directory, 'metadata.json'), 'utf8'))
  const contentPath = path.join(directory, 'content.bin')
  const bytes = readFileSync(contentPath)
  assert(metadata.artifactId === artifact.artifactId && metadata.mimeType === expectedMime
    && statSync(contentPath).size === metadata.byteLength && bytes.length === artifact.byteLength,
  'REVISION_VERIFY_ARTIFACT_METADATA_MISMATCH')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  assert(sha256 === metadata.sha256 && sha256 === artifact.sha256, 'REVISION_VERIFY_ARTIFACT_HASH_MISMATCH')
  if (expectedMime === 'image/png') {
    assert(bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'REVISION_VERIFY_PNG_SIGNATURE_MISMATCH')
  } else {
    assert(bytes.subarray(0, 4).toString('hex') === '504b0304', 'REVISION_VERIFY_PPTX_SIGNATURE_MISMATCH')
  }
  return { artifactId: artifact.artifactId, mimeType: expectedMime, byteLength: bytes.length, sha256 }
}

const frameflowPath = option('--frameflow-database')
const agentPath = option('--agent-database')
const artifactRoot = option('--artifact-root')
const expectedSha = option('--expected-sha')
assertRelease(expectedSha)
const frameflow = new Database(frameflowPath, { readonly: true })
const agent = new Database(agentPath, { readonly: true })
assertDatabase(frameflow, 'REVISION_VERIFY_FRAMEFLOW')
assertDatabase(agent, 'REVISION_VERIFY_AGENT')

const runRow = agent.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
assert(runRow, 'REVISION_VERIFY_RUN_NOT_FOUND')
const run = JSON.parse(runRow.data)
assert(runRow.status === 'COMPLETED' && run.status === 'COMPLETED' && run.revisionRound === 2
  && runRow.lease_until === null && run.qualityOverride === false
  && run.qualityOverrideBy == null && run.qualityOverrideReason == null,
'REVISION_VERIFY_RUN_STATE_MISMATCH')
assert(agent.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count === 0,
  'REVISION_VERIFY_OPEN_ISSUES_MISMATCH')

const steps = agent.query('SELECT tool, status, data FROM agent_steps WHERE run_id = ?').all(RUN_ID)
  .map((step) => ({ ...step, value: JSON.parse(step.data) }))
const imageRound = (round) => steps.filter((step) => step.tool === 'generate_slide_image'
  && step.value.idempotencyKey.endsWith(`:r${round}:v1`))
const r0 = imageRound(0)
const r1 = imageRound(1)
const r2 = imageRound(2)
const r3 = imageRound(3)
assert(r0.length === 12 && r1.length === 12 && r2.length === 6 && r3.length === 0
  && [...r0, ...r1, ...r2].every((step) => step.status === 'COMPLETED'),
'REVISION_VERIFY_IMAGE_STEPS_MISMATCH')
const r2Pages = r2.map((step) => Number(step.value.output?.slideId?.split(':').at(-1))).sort((a, b) => a - b)
assert(JSON.stringify(r2Pages) === JSON.stringify(EXPECTED_PAGES), 'REVISION_VERIFY_R2_PAGES_MISMATCH')

const planStep = steps.find((step) => step.tool === 'plan_revision'
  && step.value.idempotencyKey === `${RUN_ID}:revision-plan:r2`)
assert(planStep?.status === 'COMPLETED', 'REVISION_VERIFY_PLAN_MISSING')
const plan = revisionPlanSchema.parse(planStep.value.output)
assert(JSON.stringify(plan.operations.map((operation) => Number(operation.slideId.split(':').at(-1)))
  .sort((a, b) => a - b)) === JSON.stringify(EXPECTED_PAGES), 'REVISION_VERIFY_PLAN_PAGES_MISMATCH')

const deckStep = steps.find((step) => step.tool === 'review_deck'
  && step.value.idempotencyKey === `${RUN_ID}:deck-review:r2`)
assert(deckStep?.status === 'COMPLETED', 'REVISION_VERIFY_DECK_REVIEW_MISSING')
const deckReview = deckReviewSchema.parse(deckStep.value.output)
assert(passesDeckQuality(deckReview) && run.qualityScore === deckReview.qualityScore,
  'REVISION_VERIFY_DECK_QUALITY_MISMATCH')
const deliveryRow = agent.query('SELECT data FROM agent_deliveries WHERE run_id = ?').get(RUN_ID)
assert(deliveryRow, 'REVISION_VERIFY_DELIVERY_MISSING')
const delivery = JSON.parse(deliveryRow.data)
assert(delivery.revisionRound === 2 && delivery.qualityOverride === false
  && delivery.qualityOverrideAudit === null && delivery.qualityScore === deckReview.qualityScore,
'REVISION_VERIFY_DELIVERY_MISMATCH')

const compensationRows = frameflow.query(`
  SELECT idempotencyKey, userId, reservationId, type, amountMilli, metadata
  FROM CreditLedgerEntry WHERE idempotencyKey IN (?, ?)
`).all(R0_COMPENSATION_KEY, R1_COMPENSATION_KEY)
assert(compensationRows.length === 2 && compensationRows.every((row) => row.type === 'ADJUST'
  && row.amountMilli === 0 && row.reservationId === PARENT_ID), 'REVISION_VERIFY_COMPENSATIONS_MISSING')
const compensation = new Map(compensationRows.map((row) => [row.idempotencyKey, JSON.parse(row.metadata || '{}')]))
const r0Metadata = compensation.get(R0_COMPENSATION_KEY)
const r1Metadata = compensation.get(R1_COMPENSATION_KEY)
assert(r0Metadata?.compensatedMilli === 120_000 && r0Metadata.childReservationIds?.length === 12,
  'REVISION_VERIFY_R0_COMPENSATION_MISMATCH')
assert(r1Metadata?.compensatedMilli === 60_000 && r1Metadata.childReservationIds?.length === 6
  && JSON.stringify(r1Metadata.rejectedPages) === JSON.stringify(EXPECTED_PAGES),
'REVISION_VERIFY_R1_COMPENSATION_MISMATCH')

const allReservationIds = [...r0, ...r1, ...r2].map((step) => step.value.budgetReservationId)
assert(allReservationIds.length === 30 && allReservationIds.every((id) => typeof id === 'string')
  && new Set(allReservationIds).size === 30, 'REVISION_VERIFY_RESERVATION_IDS_MISMATCH')
const placeholders = allReservationIds.map(() => '?').join(',')
const children = frameflow.query(`
  SELECT id, parentReservationId, status, amountMilli, settledMilli
  FROM CreditReservation WHERE id IN (${placeholders})
`).all(...allReservationIds)
assert(children.length === 30 && children.every((child) => child.parentReservationId === PARENT_ID
  && child.status === 'SETTLED' && child.amountMilli === 10_000 && child.settledMilli === 10_000),
'REVISION_VERIFY_CHILD_RESERVATIONS_MISMATCH')
const gross = children.reduce((sum, child) => sum + child.settledMilli, 0)
assert(gross === 300_000 && gross - r0Metadata.compensatedMilli - r1Metadata.compensatedMilli === 120_000,
  'REVISION_VERIFY_NET_CHARGE_MISMATCH')

const parent = frameflow.query(`
  SELECT userId, status, amountMilli, remainingMilli, settledMilli FROM CreditReservation WHERE id = ?
`).get(PARENT_ID)
assert(parent?.status === 'RELEASED' && parent.amountMilli === 600_000
  && parent.remainingMilli === 0 && parent.settledMilli === 120_000,
'REVISION_VERIFY_PARENT_MISMATCH')
const account = frameflow.query(`
  SELECT availableMilli, reservedMilli, totalUsedMilli, debtMilli, status, accountVersion
  FROM Credit WHERE userId = ?
`).get(parent.userId)
assert(account?.status === 'ACTIVE' && account.debtMilli === 0
  && account.totalUsedMilli === r1Metadata.account.before.totalUsedMilli,
'REVISION_VERIFY_ACCOUNT_MISMATCH')
const reservedAggregate = Number(frameflow.query(`
  SELECT COALESCE(SUM(CASE WHEN parentReservationId IS NULL THEN COALESCE(remainingMilli, amountMilli)
    ELSE amountMilli END), 0) AS total
  FROM CreditReservation WHERE userId = ? AND status = 'RESERVED'
`).get(parent.userId).total)
assert(account.reservedMilli === reservedAggregate, 'REVISION_VERIFY_RESERVED_AGGREGATE_MISMATCH')
const ledgerHead = frameflow.query(`
  SELECT accountVersion, availableAfterMilli, reservedAfterMilli FROM CreditLedgerEntry
  WHERE userId = ? ORDER BY accountVersion DESC LIMIT 1
`).get(parent.userId)
assert(ledgerHead?.accountVersion === account.accountVersion
  && ledgerHead.availableAfterMilli === account.availableMilli
  && ledgerHead.reservedAfterMilli === account.reservedMilli, 'REVISION_VERIFY_LEDGER_HEAD_MISMATCH')

const artifacts = [
  verifyArtifact(artifactRoot, delivery.preview, 'image/png'),
  verifyArtifact(artifactRoot, delivery.pptx, PPTX_MIME),
]
console.log(JSON.stringify({
  runId: RUN_ID, status: runRow.status, revisionRound: run.revisionRound,
  r0Images: r0.length, r1Images: r1.length, r2Images: r2.length, r3Images: r3.length,
  grossSettledMilli: gross, compensatedMilli: 180_000, netSettledMilli: 120_000,
  parentStatus: parent.status, parentSettledMilli: parent.settledMilli,
  accountReservedMilli: account.reservedMilli, reservedAggregateMilli: reservedAggregate,
  qualityScore: deckReview.qualityScore, artifacts,
}, null, 2))
agent.close()
frameflow.close()
