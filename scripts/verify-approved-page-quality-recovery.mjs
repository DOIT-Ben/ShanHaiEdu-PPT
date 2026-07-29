import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { passesDeckQuality } from '../dist/core/deck-review-runner.js'
import { deckReviewSchema } from '../dist/presentation-contracts.js'

const RUN_ID = 'run-86529d771703468d4f4efd1e4439'
const PARENT_RESERVATION_ID = 'd9a63ca4-9f7b-4295-9f3d-3ba2ecdc0ee5'
const COMPENSATED_MILLI = 120_000
const IDEMPOTENCY_KEY = `ppt-agent:quality-retry-compensation:${RUN_ID}:r0`
const CONTRACT = 'PPT_AGENT_QUALITY_RETRY_COMPENSATION_V2'

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
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'VERIFY_EXPECTED_SHA_INVALID')
  const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'))
  assert(manifest?.gitSha === expectedSha, 'VERIFY_RELEASE_SHA_MISMATCH')
}

function assertDatabase(database, prefix) {
  const integrity = database.query('PRAGMA integrity_check').all()
  assert(integrity.length === 1 && Object.values(integrity[0])[0] === 'ok', `${prefix}_INTEGRITY_FAILED`)
  assert(database.query('PRAGMA foreign_key_check').all().length === 0, `${prefix}_FOREIGN_KEY_FAILED`)
}

function roundSteps(steps, round) {
  return steps.filter((step) => step.tool === 'generate_slide_image'
    && step.value.idempotencyKey.endsWith(`:r${round}:v1`))
}

function verifyArtifact(artifactRoot, artifactId, expectedMimeType) {
  assert(/^artifact-[a-f0-9]{40}$/.test(artifactId), 'VERIFY_ARTIFACT_ID_INVALID')
  const directory = path.join(artifactRoot, artifactId)
  const metadata = JSON.parse(readFileSync(path.join(directory, 'metadata.json'), 'utf8'))
  const contentPath = path.join(directory, 'content.bin')
  const bytes = readFileSync(contentPath)
  assert(metadata.artifactId === artifactId && metadata.mimeType === expectedMimeType,
    'VERIFY_ARTIFACT_METADATA_MISMATCH')
  assert(statSync(contentPath).size === metadata.byteLength && bytes.length > 0,
    'VERIFY_ARTIFACT_SIZE_MISMATCH')
  assert(createHash('sha256').update(bytes).digest('hex') === metadata.sha256,
    'VERIFY_ARTIFACT_HASH_MISMATCH')
  if (expectedMimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    assert(bytes.subarray(0, 4).toString('hex') === '504b0304', 'VERIFY_PPTX_SIGNATURE_MISMATCH')
  }
  if (expectedMimeType === 'image/png') {
    assert(bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'VERIFY_PNG_SIGNATURE_MISMATCH')
  }
  return { artifactId, mimeType: expectedMimeType, byteLength: bytes.length, sha256: metadata.sha256 }
}

const frameflowPath = option('--frameflow-database')
const agentPath = option('--agent-database')
const artifactRoot = option('--artifact-root')
const expectedSha = option('--expected-sha')
const phase = option('--phase')
assert(['recovered', 'completed'].includes(phase), 'VERIFY_PHASE_INVALID')
assertRelease(expectedSha)

const frameflow = new Database(frameflowPath, { readonly: true })
const agent = new Database(agentPath, { readonly: true })
assertDatabase(frameflow, 'VERIFY_FRAMEFLOW')
assertDatabase(agent, 'VERIFY_AGENT')

const runRow = agent.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
assert(runRow, 'VERIFY_RUN_NOT_FOUND')
const run = JSON.parse(runRow.data)
assert(run.source?.kind === 'APPROVED_PAGE_DESIGN' && run.automationLevel === 'SUPERVISED'
  && run.revisionRound === 1, 'VERIFY_RUN_CONTRACT_MISMATCH')
assert(agent.query('SELECT COUNT(*) AS count FROM agent_steps WHERE run_id = ? AND idempotency_key = ?')
  .get(RUN_ID, `${RUN_ID}:revision-blueprint:r1`).count === 1, 'VERIFY_REVISION_BLUEPRINT_MISMATCH')

const steps = agent.query('SELECT tool, status, data FROM agent_steps WHERE run_id = ? ORDER BY rowid').all(RUN_ID)
  .map((row) => ({ ...row, value: JSON.parse(row.data) }))
const r0 = roundSteps(steps, 0)
const r1 = roundSteps(steps, 1)
const r2 = roundSteps(steps, 2)
assert(r0.length === 12 && r0.every((step) => step.status === 'COMPLETED'), 'VERIFY_R0_STEPS_MISMATCH')
assert(r2.length === 0, 'VERIFY_R2_STEPS_EXIST')

const r0ReservationIds = r0.map((step) => step.value.budgetReservationId).sort()
const r1ReservationIds = r1.map((step) => step.value.budgetReservationId).filter(Boolean).sort()
const ledger = frameflow.query(`
  SELECT userId, reservationId, type, amountMilli, availableAfterMilli, reservedAfterMilli,
         accountVersion, metadata
  FROM CreditLedgerEntry WHERE idempotencyKey = ?
`).get(IDEMPOTENCY_KEY)
assert(ledger?.type === 'ADJUST' && ledger.amountMilli === 0 && ledger.reservationId === PARENT_RESERVATION_ID,
  'VERIFY_COMPENSATION_LEDGER_MISSING')
const metadata = JSON.parse(ledger.metadata || '{}')
assert(metadata.contract === CONTRACT && metadata.runId === RUN_ID
  && metadata.compensatedMilli === COMPENSATED_MILLI
  && JSON.stringify(metadata.childReservationIds) === JSON.stringify(r0ReservationIds)
  && metadata.account.before.totalUsedMilli - metadata.account.after.totalUsedMilli === COMPENSATED_MILLI
  && metadata.account.after.reservedMilli - metadata.account.before.reservedMilli === COMPENSATED_MILLI
  && metadata.account.after.availableMilli === metadata.account.before.availableMilli,
'VERIFY_COMPENSATION_METADATA_MISMATCH')
assert(ledger.accountVersion === metadata.account.after.accountVersion
  && ledger.availableAfterMilli === metadata.account.after.availableMilli
  && ledger.reservedAfterMilli === metadata.account.after.reservedMilli,
'VERIFY_COMPENSATION_LEDGER_SNAPSHOT_MISMATCH')

const parent = frameflow.query(`
  SELECT userId, status, amountMilli, remainingMilli, settledMilli
  FROM CreditReservation WHERE id = ?
`).get(PARENT_RESERVATION_ID)
assert(parent && parent.userId === ledger.userId && parent.amountMilli === 600_000,
  'VERIFY_PARENT_RESERVATION_MISMATCH')
const account = frameflow.query(`
  SELECT id, availableMilli, reservedMilli, totalUsedMilli, debtMilli, status, accountVersion
  FROM Credit WHERE userId = ?
`).get(parent.userId)
assert(account?.status === 'ACTIVE' && account.debtMilli === 0, 'VERIFY_ACCOUNT_UNAVAILABLE')

const reservedAggregate = Number(frameflow.query(`
  SELECT COALESCE(SUM(CASE
    WHEN parentReservationId IS NULL THEN COALESCE(remainingMilli, amountMilli)
    ELSE amountMilli
  END), 0) AS total
  FROM CreditReservation WHERE userId = ? AND status = 'RESERVED'
`).get(parent.userId).total)
assert(account.reservedMilli === reservedAggregate, 'VERIFY_RESERVED_AGGREGATE_MISMATCH')
const ledgerVersions = frameflow.query(`
  SELECT COUNT(*) AS count, COUNT(DISTINCT accountVersion) AS distinctCount,
         COALESCE(MAX(accountVersion), 0) AS maxVersion
  FROM CreditLedgerEntry WHERE userId = ?
`).get(parent.userId)
assert(ledgerVersions.count === ledgerVersions.distinctCount
  && ledgerVersions.maxVersion === account.accountVersion, 'VERIFY_LEDGER_VERSION_MISMATCH')
const ledgerHead = frameflow.query(`
  SELECT availableAfterMilli, reservedAfterMilli FROM CreditLedgerEntry
  WHERE userId = ? ORDER BY accountVersion DESC LIMIT 1
`).get(parent.userId)
assert(ledgerHead?.availableAfterMilli === account.availableMilli
  && ledgerHead.reservedAfterMilli === account.reservedMilli, 'VERIFY_LEDGER_HEAD_MISMATCH')

let artifacts = []
if (phase === 'recovered') {
  assert(runRow.status === 'EXECUTING' && run.status === 'EXECUTING' && runRow.lease_until === null,
    'VERIFY_RECOVERED_RUN_STATE_MISMATCH')
  assert(r1.length === 0, 'VERIFY_RECOVERED_R1_ALREADY_STARTED')
  assert(parent.status === 'RESERVED' && parent.remainingMilli === 600_000 && parent.settledMilli === null,
    'VERIFY_RECOVERED_PARENT_MISMATCH')
  assert(account.accountVersion === metadata.account.after.accountVersion
    && account.totalUsedMilli === metadata.account.after.totalUsedMilli
    && account.reservedMilli === metadata.account.after.reservedMilli,
  'VERIFY_RECOVERED_ACCOUNT_MISMATCH')
  assert(agent.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count === 0,
    'VERIFY_RECOVERED_OPEN_ISSUES_MISMATCH')
}

if (phase === 'completed') {
  assert(runRow.status === 'COMPLETED' && run.status === 'COMPLETED' && runRow.lease_until === null,
    'VERIFY_COMPLETED_RUN_STATE_MISMATCH')
  assert(run.qualityOverride === false && run.qualityOverrideBy === null
    && run.qualityOverrideRole === null && run.qualityOverrideReason === null
    && run.qualityOverrideIssueIds === null && run.qualityOverrideAt === null,
  'VERIFY_COMPLETED_QUALITY_OVERRIDE_FORBIDDEN')
  assert(r1.length === 12 && r1.every((step) => step.status === 'COMPLETED'), 'VERIFY_R1_STEPS_MISMATCH')
  const deckReviewSteps = steps.filter((step) => step.tool === 'review_deck'
    && step.value.idempotencyKey === `${RUN_ID}:deck-review:r1`)
  assert(deckReviewSteps.length === 1 && deckReviewSteps[0].status === 'COMPLETED',
    'VERIFY_COMPLETED_DECK_REVIEW_STEP_MISMATCH')
  const deckReview = deckReviewSchema.parse(deckReviewSteps[0].value.output)
  assert(passesDeckQuality(deckReview) && run.qualityScore === deckReview.qualityScore,
    'VERIFY_COMPLETED_DECK_QUALITY_MISMATCH')
  assert(r1ReservationIds.length === 12 && new Set(r1ReservationIds).size === 12,
    'VERIFY_R1_RESERVATIONS_MISMATCH')
  const allReservationIds = [...r0ReservationIds, ...r1ReservationIds]
  const placeholders = allReservationIds.map(() => '?').join(',')
  const children = frameflow.query(`
    SELECT id, parentReservationId, status, amountMilli, settledMilli
    FROM CreditReservation WHERE id IN (${placeholders})
  `).all(...allReservationIds)
  assert(children.length === 24 && children.every((child) => child.parentReservationId === PARENT_RESERVATION_ID
    && child.status === 'SETTLED' && child.amountMilli === 10_000 && child.settledMilli === 10_000),
  'VERIFY_COMPLETED_CHILDREN_MISMATCH')
  const grossSettledMilli = children.reduce((sum, child) => sum + child.settledMilli, 0)
  assert(grossSettledMilli === 240_000 && grossSettledMilli - COMPENSATED_MILLI === 120_000,
    'VERIFY_COMPLETED_NET_CHARGE_MISMATCH')
  assert(parent.status === 'RELEASED' && parent.remainingMilli === 0 && parent.settledMilli === 120_000,
    'VERIFY_COMPLETED_PARENT_MISMATCH')
  assert(agent.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count === 0,
    'VERIFY_COMPLETED_OPEN_ISSUES_MISMATCH')
  const deliveries = agent.query('SELECT data FROM agent_deliveries WHERE run_id = ?').all(RUN_ID)
  assert(deliveries.length === 1, 'VERIFY_COMPLETED_DELIVERY_COUNT_MISMATCH')
  const delivery = JSON.parse(deliveries[0].data)
  const preview = delivery.preview
  const pptx = delivery.pptx
  assert(delivery.revisionRound === 1 && delivery.qualityOverride === false
    && delivery.qualityOverrideAudit === null && delivery.qualityScore === deckReview.qualityScore
    && preview?.mimeType === 'image/png'
    && pptx?.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'VERIFY_COMPLETED_DELIVERY_ARTIFACTS_MISSING')
  artifacts = [
    verifyArtifact(artifactRoot, preview.artifactId, 'image/png'),
    verifyArtifact(artifactRoot, pptx.artifactId,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  ]
}

console.log(JSON.stringify({
  phase,
  runId: RUN_ID,
  status: runRow.status,
  revisionRound: run.revisionRound,
  r0Images: r0.length,
  r1Images: r1.length,
  r2Images: r2.length,
  compensationMilli: COMPENSATED_MILLI,
  accountReservedMilli: account.reservedMilli,
  reservedAggregateMilli: reservedAggregate,
  parentStatus: parent.status,
  parentRemainingMilli: parent.remainingMilli,
  parentSettledMilli: parent.settledMilli,
  artifacts,
}, null, 2))

agent.close()
frameflow.close()
