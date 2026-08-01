import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { revisionPlanSchema } from '../dist/presentation-contracts.js'

const RUN_ID = 'run-86529d771703468d4f4efd1e4439'
const PARENT_ID = 'd9a63ca4-9f7b-4295-9f3d-3ba2ecdc0ee5'
const EXPECTED_PAGES = [1, 3, 4, 5, 7, 11]
const AMOUNT = 60_000
const IDEMPOTENCY_KEY = `ppt-agent:quality-retry-compensation:${RUN_ID}:r1-rejected`
const CONTRACT = 'PPT_AGENT_REJECTED_PAGE_COMPENSATION_V2'
const CAUSE = 'R1_PAGE_VISUAL_REVIEW_REJECTED'
const DESTINATION = 'PARENT_RESERVATION'

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
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'REVISION_COMPENSATION_EXPECTED_SHA_INVALID')
  const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'))
  assert(manifest?.softwareVersion === '4.0.0' && manifest?.contractVersion === '1', 'REVISION_COMPENSATION_RELEASE_IDENTITY_INVALID')
  assert(manifest?.gitSha === expectedSha, 'REVISION_COMPENSATION_RELEASE_SHA_MISMATCH')
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function snapshot(account) {
  return {
    id: account.id,
    availableMilli: account.availableMilli,
    reservedMilli: account.reservedMilli,
    totalUsedMilli: account.totalUsedMilli,
    debtMilli: account.debtMilli,
    status: account.status,
    accountVersion: account.accountVersion,
  }
}

const frameflowPath = option('--frameflow-database')
const agentPath = option('--agent-database')
const expectedSha = option('--expected-sha')
const apply = process.argv.includes('--apply')
assertRelease(expectedSha)

const agent = new Database(agentPath, { readonly: true })
const runRow = agent.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
assert(runRow, 'REVISION_COMPENSATION_RUN_NOT_FOUND')
const run = JSON.parse(runRow.data)
assert(run.source?.kind === 'APPROVED_PAGE_DESIGN' && run.automationLevel === 'SUPERVISED'
  && run.maxRevisionRounds === 2 && run.qualityOverride === false
  && run.qualityOverrideBy == null && run.qualityOverrideReason == null,
'REVISION_COMPENSATION_RUN_CONTRACT_MISMATCH')
assert([1, 2].includes(run.revisionRound), 'REVISION_COMPENSATION_RUN_ROUND_MISMATCH')

const openIssues = agent.query('SELECT issue_id, data FROM agent_open_issues WHERE run_id = ? ORDER BY sequence')
  .all(RUN_ID).map((row) => ({ issueId: row.issue_id, payload: JSON.parse(row.data).payload }))
let issues = openIssues
if (run.revisionRound === 2) {
  const planRow = agent.query('SELECT data FROM agent_steps WHERE run_id = ? AND idempotency_key = ?')
    .get(RUN_ID, `${RUN_ID}:revision-plan:r2`)
  assert(planRow, 'REVISION_COMPENSATION_R2_PLAN_MISSING')
  const plan = revisionPlanSchema.parse(JSON.parse(planRow.data).output)
  const planIssueIds = plan.operations.flatMap((operation) => operation.issueIds).sort()
  assert(plan.operations.length === 6 && planIssueIds.length === 6 && new Set(planIssueIds).size === 6,
    'REVISION_COMPENSATION_R2_PLAN_ISSUES_MISMATCH')
  const events = agent.query('SELECT data FROM agent_events WHERE run_id = ? ORDER BY sequence').all(RUN_ID)
    .map((row) => JSON.parse(row.data))
  const detected = new Map(events.filter((event) => event.type === 'issue.detected'
    && planIssueIds.includes(event.payload?.id)).map((event) => [event.payload.id, event.payload]))
  const fixed = new Set(events.filter((event) => event.type === 'issue.resolved'
    && event.payload?.resolution === 'FIXED' && planIssueIds.includes(event.payload?.issueId))
    .map((event) => event.payload.issueId))
  const nonFixed = events.filter((event) => event.type === 'issue.resolved'
    && event.payload?.resolution !== 'FIXED' && planIssueIds.includes(event.payload?.issueId))
  const open = new Set(openIssues.map((issue) => issue.issueId))
  assert(detected.size === 6 && nonFixed.length === 0
    && planIssueIds.every((issueId) => open.has(issueId) || fixed.has(issueId)),
  'REVISION_COMPENSATION_RESOLVED_ISSUES_MISMATCH')
  issues = planIssueIds.map((issueId) => ({ issueId, payload: detected.get(issueId) }))
}
const issueIds = issues.map((issue) => issue.issueId).sort()
const issuePages = issues.map((issue) => Number(issue.payload.slideIds?.[0]?.split(':').at(-1))).sort((a, b) => a - b)
assert(issues.length === 6 && issues.every((issue) => issue.payload.category === 'IMAGE_QUALITY'
  && issue.payload.severity === 'WARNING'), 'REVISION_COMPENSATION_ISSUES_MISMATCH')
assert(JSON.stringify(issuePages) === JSON.stringify(EXPECTED_PAGES), 'REVISION_COMPENSATION_PAGES_MISMATCH')

const r1Steps = agent.query("SELECT data FROM agent_steps WHERE run_id = ? AND tool = 'generate_slide_image' AND status = 'COMPLETED'")
  .all(RUN_ID).map((row) => JSON.parse(row.data)).filter((step) => step.idempotencyKey.endsWith(':r1:v1'))
assert(r1Steps.length === 12, 'REVISION_COMPENSATION_R1_STEP_COUNT_MISMATCH')
const rejectedSteps = r1Steps.filter((step) => EXPECTED_PAGES.includes(Number(step.output?.slideId?.split(':').at(-1))))
const reservationIds = rejectedSteps.map((step) => step.budgetReservationId).sort()
assert(reservationIds.length === 6 && reservationIds.every((id) => typeof id === 'string')
  && new Set(reservationIds).size === 6, 'REVISION_COMPENSATION_RESERVATIONS_MISMATCH')
agent.close()

const frameflow = apply ? new Database(frameflowPath) : new Database(frameflowPath, { readonly: true })
const parent = frameflow.query(`
  SELECT userId, status, amountMilli, remainingMilli, settledMilli
  FROM CreditReservation WHERE id = ? AND parentReservationId IS NULL
`).get(PARENT_ID)
assert(parent && parent.userId === run.host.externalUserId, 'REVISION_COMPENSATION_PARENT_OWNER_MISMATCH')
const placeholders = reservationIds.map(() => '?').join(',')
const children = frameflow.query(`
  SELECT id, userId, parentReservationId, status, amountMilli, settledMilli, sourceType
  FROM CreditReservation WHERE id IN (${placeholders}) ORDER BY id
`).all(...reservationIds)
assert(children.length === 6 && children.every((child) => child.userId === parent.userId
  && child.parentReservationId === PARENT_ID && child.status === 'SETTLED'
  && child.amountMilli === 10_000 && child.settledMilli === 10_000
  && child.sourceType === 'PPT_AGENT_MEDIA'), 'REVISION_COMPENSATION_CHILDREN_MISMATCH')
const account = frameflow.query(`
  SELECT id, availableMilli, reservedMilli, totalUsedMilli, debtMilli, status, accountVersion
  FROM Credit WHERE userId = ?
`).get(parent.userId)
assert(account?.status === 'ACTIVE' && account.debtMilli === 0, 'REVISION_COMPENSATION_ACCOUNT_UNAVAILABLE')

const existing = frameflow.query(`
  SELECT userId, reservationId, type, amountMilli, availableAfterMilli, reservedAfterMilli,
         accountVersion, metadata FROM CreditLedgerEntry WHERE idempotencyKey = ?
`).get(IDEMPOTENCY_KEY)
if (existing) {
  const metadata = JSON.parse(existing.metadata || '{}')
  const request = {
    contract: CONTRACT,
    runId: RUN_ID,
    parentReservationId: PARENT_ID,
    rejectedPages: EXPECTED_PAGES,
    issueIds,
    childReservationIds: reservationIds,
    compensatedMilli: AMOUNT,
    cause: CAUSE,
    destination: DESTINATION,
    accountBefore: metadata.account?.before,
    parentBefore: metadata.parent?.before,
  }
  assert(metadata.contract === CONTRACT && metadata.runId === RUN_ID
    && metadata.parentReservationId === PARENT_ID && metadata.compensatedMilli === AMOUNT
    && JSON.stringify(metadata.rejectedPages) === JSON.stringify(EXPECTED_PAGES)
    && JSON.stringify(metadata.issueIds) === JSON.stringify(issueIds)
    && JSON.stringify(metadata.childReservationIds) === JSON.stringify(reservationIds)
    && metadata.cause === CAUSE && metadata.destination === DESTINATION
    && metadata.requestFingerprint === digest(request), 'REVISION_COMPENSATION_REPLAY_FINGERPRINT_MISMATCH')
  assert(existing.userId === parent.userId && existing.reservationId === PARENT_ID
    && existing.type === 'ADJUST' && existing.amountMilli === 0
    && existing.availableAfterMilli === metadata.account.after.availableMilli
    && existing.reservedAfterMilli === metadata.account.after.reservedMilli
    && existing.accountVersion === metadata.account.after.accountVersion,
  'REVISION_COMPENSATION_REPLAY_LEDGER_MISMATCH')
  assert(account.accountVersion >= metadata.account.after.accountVersion,
    'REVISION_COMPENSATION_REPLAY_ACCOUNT_VERSION_REGRESSION')
  if (account.accountVersion === metadata.account.after.accountVersion) {
    assert(JSON.stringify(snapshot(account)) === JSON.stringify(metadata.account.after),
      'REVISION_COMPENSATION_REPLAY_ACCOUNT_MISMATCH')
  }
  console.log(JSON.stringify({ mode: 'replay', runId: RUN_ID, compensatedMilli: AMOUNT,
    compensationAccountVersion: metadata.account.after.accountVersion }, null, 2))
  frameflow.close()
  process.exit(0)
}

assert(runRow.status === 'NEEDS_HUMAN' && run.status === 'NEEDS_HUMAN'
  && run.revisionRound === 1 && runRow.lease_until === null, 'REVISION_COMPENSATION_RUN_STATE_MISMATCH')
assert(parent.status === 'RESERVED' && parent.amountMilli === 600_000
  && parent.remainingMilli === 480_000 && parent.settledMilli === null,
'REVISION_COMPENSATION_PARENT_STATE_MISMATCH')
assert(account.totalUsedMilli >= AMOUNT && account.reservedMilli === 480_000,
  'REVISION_COMPENSATION_ACCOUNT_STATE_MISMATCH')

const before = snapshot(account)
const after = { ...before, reservedMilli: before.reservedMilli + AMOUNT,
  totalUsedMilli: before.totalUsedMilli - AMOUNT, accountVersion: before.accountVersion + 1 }
const parentBefore = { status: parent.status, remainingMilli: parent.remainingMilli, settledMilli: parent.settledMilli }
const parentAfter = { status: 'RESERVED', remainingMilli: 540_000, settledMilli: null }
const request = {
  contract: CONTRACT,
  runId: RUN_ID,
  parentReservationId: PARENT_ID,
  rejectedPages: EXPECTED_PAGES,
  issueIds,
  childReservationIds: reservationIds,
  compensatedMilli: AMOUNT,
  cause: CAUSE,
  destination: DESTINATION,
  accountBefore: before,
  parentBefore,
}
const metadata = {
  ...request,
  account: { id: account.id, before, after },
  parent: { before: parentBefore, after: parentAfter },
  requestFingerprint: digest(request),
}

if (apply) {
  frameflow.transaction(() => {
    const accountUpdate = frameflow.query(`
      UPDATE Credit SET reservedMilli = reservedMilli + ?, totalUsedMilli = totalUsedMilli - ?, accountVersion = ?
      WHERE id = ? AND accountVersion = ? AND status = 'ACTIVE' AND debtMilli = 0 AND totalUsedMilli >= ?
    `).run(AMOUNT, AMOUNT, after.accountVersion, account.id, before.accountVersion, AMOUNT)
    assert(accountUpdate.changes === 1, 'REVISION_COMPENSATION_ACCOUNT_CONFLICT')
    const parentUpdate = frameflow.query(`
      UPDATE CreditReservation SET remainingMilli = remainingMilli + ?, updatedAt = ?
      WHERE id = ? AND status = 'RESERVED' AND remainingMilli = 480000
    `).run(AMOUNT, new Date().toISOString(), PARENT_ID)
    assert(parentUpdate.changes === 1, 'REVISION_COMPENSATION_PARENT_CONFLICT')
    frameflow.query(`
      INSERT INTO CreditLedgerEntry (
        id, userId, reservationId, actorUserId, type, amountMilli,
        availableAfterMilli, reservedAfterMilli, accountVersion,
        idempotencyKey, reason, metadata, createdAt
      ) VALUES (?, ?, ?, NULL, 'ADJUST', 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), parent.userId, PARENT_ID, after.availableMilli, after.reservedMilli,
      after.accountVersion, IDEMPOTENCY_KEY,
      '第二轮逐页视觉质检拒绝的六页由产品承担费用并回补至原任务预留',
      JSON.stringify(metadata), new Date().toISOString())
  }).immediate()
}

const finalAccount = frameflow.query(`
  SELECT id, availableMilli, reservedMilli, totalUsedMilli, debtMilli, status, accountVersion
  FROM Credit WHERE userId = ?
`).get(parent.userId)
const finalParent = frameflow.query('SELECT status, remainingMilli, settledMilli FROM CreditReservation WHERE id = ?')
  .get(PARENT_ID)
if (apply) {
  assert(JSON.stringify(snapshot(finalAccount)) === JSON.stringify(after), 'REVISION_COMPENSATION_POST_ACCOUNT_MISMATCH')
  assert(JSON.stringify(finalParent) === JSON.stringify(parentAfter), 'REVISION_COMPENSATION_POST_PARENT_MISMATCH')
}
console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry-run', runId: RUN_ID, rejectedPages: EXPECTED_PAGES,
  compensatedMilli: AMOUNT, accountBefore: before, accountAfter: apply ? snapshot(finalAccount) : after,
  parentBefore, parentAfter: apply ? finalParent : parentAfter,
}, null, 2))
frameflow.close()
