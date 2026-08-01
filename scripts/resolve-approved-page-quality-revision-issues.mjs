import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { passesDeckQuality } from '../dist/core/deck-review-runner.js'
import { deckReviewSchema, revisionPlanSchema } from '../dist/presentation-contracts.js'

const RUN_ID = 'run-86529d771703468d4f4efd1e4439'
const EXPECTED_PAGES = [1, 3, 4, 5, 7, 11]

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
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'QUALITY_RESOLUTION_EXPECTED_SHA_INVALID')
  const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'))
  assert(manifest?.softwareVersion === '4.0.0' && manifest?.contractVersion === '1', 'QUALITY_RESOLUTION_RELEASE_IDENTITY_INVALID')
  assert(manifest?.gitSha === expectedSha, 'QUALITY_RESOLUTION_RELEASE_SHA_MISMATCH')
}

const databasePath = option('--database')
const expectedSha = option('--expected-sha')
const apply = process.argv.includes('--apply')
assertRelease(expectedSha)
const database = apply ? new Database(databasePath) : new Database(databasePath, { readonly: true })

const row = database.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
assert(row, 'QUALITY_RESOLUTION_RUN_NOT_FOUND')
const run = JSON.parse(row.data)
assert(row.status === 'COMPLETED' && run.status === 'COMPLETED' && run.revisionRound === 2
  && row.lease_until === null && run.qualityOverride === false,
'QUALITY_RESOLUTION_RUN_STATE_MISMATCH')

const planRow = database.query('SELECT data, status, tool FROM agent_steps WHERE run_id = ? AND idempotency_key = ?')
  .get(RUN_ID, `${RUN_ID}:revision-plan:r2`)
assert(planRow?.status === 'COMPLETED' && planRow.tool === 'plan_revision', 'QUALITY_RESOLUTION_PLAN_MISSING')
const plan = revisionPlanSchema.parse(JSON.parse(planRow.data).output)
const planPages = plan.operations.map((operation) => Number(operation.slideId.split(':').at(-1))).sort((a, b) => a - b)
assert(JSON.stringify(planPages) === JSON.stringify(EXPECTED_PAGES)
  && plan.operations.every((operation) => operation.kind === 'REGENERATE_IMAGE'),
'QUALITY_RESOLUTION_PLAN_MISMATCH')
const issueIds = plan.operations.flatMap((operation) => operation.issueIds).sort()
assert(issueIds.length === 6 && new Set(issueIds).size === 6, 'QUALITY_RESOLUTION_ISSUE_IDS_MISMATCH')

const steps = database.query('SELECT tool, status, data FROM agent_steps WHERE run_id = ?').all(RUN_ID)
  .map((step) => ({ ...step, value: JSON.parse(step.data) }))
const r2Images = steps.filter((step) => step.tool === 'generate_slide_image'
  && step.value.idempotencyKey.endsWith(':r2:v1'))
assert(r2Images.length === 6 && r2Images.every((step) => step.status === 'COMPLETED'),
  'QUALITY_RESOLUTION_R2_IMAGES_MISMATCH')
const r2ImageReviewKeys = new Set(r2Images.map((step) => `${step.value.idempotencyKey}:review`))
const r2ImageReviews = steps.filter((step) => step.tool === 'review_slide_image'
  && r2ImageReviewKeys.has(step.value.idempotencyKey))
assert(r2ImageReviews.length === 6 && r2ImageReviews.every((step) => step.status === 'COMPLETED'
  && step.value.output?.approved === true), 'QUALITY_RESOLUTION_R2_IMAGE_REVIEWS_MISMATCH')
const compositeReviews = steps.filter((step) => step.tool === 'review_slide_image'
  && step.value.idempotencyKey.includes(':composite:r2:review'))
assert(compositeReviews.length === 12 && compositeReviews.every((step) => step.status === 'COMPLETED'
  && step.value.output?.approved === true), 'QUALITY_RESOLUTION_COMPOSITE_REVIEWS_MISMATCH')

const deckStep = steps.find((step) => step.tool === 'review_deck'
  && step.value.idempotencyKey === `${RUN_ID}:deck-review:r2`)
assert(deckStep?.status === 'COMPLETED', 'QUALITY_RESOLUTION_DECK_REVIEW_MISSING')
const deckReview = deckReviewSchema.parse(deckStep.value.output)
assert(passesDeckQuality(deckReview) && run.qualityScore === deckReview.qualityScore,
  'QUALITY_RESOLUTION_DECK_REVIEW_FAILED')
const deliveryRow = database.query('SELECT data FROM agent_deliveries WHERE run_id = ?').get(RUN_ID)
assert(deliveryRow, 'QUALITY_RESOLUTION_DELIVERY_MISSING')
const delivery = JSON.parse(deliveryRow.data)
assert(delivery.revisionRound === 2 && delivery.qualityOverride === false
  && delivery.qualityOverrideAudit === null && delivery.qualityScore === deckReview.qualityScore,
'QUALITY_RESOLUTION_DELIVERY_MISMATCH')

const openIssues = database.query('SELECT issue_id, data FROM agent_open_issues WHERE run_id = ? ORDER BY sequence')
  .all(RUN_ID)
if (openIssues.length === 0) {
  const resolved = database.query(`
    SELECT data FROM agent_events WHERE run_id = ? ORDER BY sequence
  `).all(RUN_ID).map((event) => JSON.parse(event.data))
    .filter((event) => event.type === 'issue.resolved' && issueIds.includes(event.payload?.issueId))
  assert(new Set(resolved.map((event) => event.payload.issueId)).size === 6,
    'QUALITY_RESOLUTION_REPLAY_EVENTS_MISMATCH')
  console.log(JSON.stringify({ mode: 'replay', runId: RUN_ID, resolvedIssues: 6 }, null, 2))
  database.close()
  process.exit(0)
}
assert(openIssues.length === 6 && openIssues.every((issue) => issueIds.includes(issue.issue_id)
  && JSON.parse(issue.data).payload?.category === 'IMAGE_QUALITY'),
'QUALITY_RESOLUTION_OPEN_ISSUES_MISMATCH')

if (apply) {
  const now = new Date().toISOString()
  database.transaction(() => {
    const deleted = database.query(`
      DELETE FROM agent_open_issues WHERE run_id = ? AND issue_id IN (${issueIds.map(() => '?').join(',')})
    `).run(RUN_ID, ...issueIds)
    assert(deleted.changes === 6, 'QUALITY_RESOLUTION_ISSUE_DELETE_MISMATCH')
    let sequence = Number(database.query('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_events WHERE run_id = ?')
      .get(RUN_ID).sequence)
    for (const issueId of issueIds) {
      sequence += 1
      database.query('INSERT INTO agent_events (run_id, sequence, data) VALUES (?, ?, ?)').run(
        RUN_ID, sequence, JSON.stringify({ schemaVersion: '1', id: `${RUN_ID}:quality-r2-resolved:${sequence}`,
          runId: RUN_ID, sequence, createdAt: now, type: 'issue.resolved',
          payload: { issueId, resolution: 'FIXED' } }))
    }
  }).immediate()
}
const remaining = database.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count
if (apply) assert(remaining === 0, 'QUALITY_RESOLUTION_POST_ISSUES_MISMATCH')
console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', runId: RUN_ID,
  resolvedIssues: apply ? 6 : 0, remainingOpenIssues: remaining,
}, null, 2))
database.close()
