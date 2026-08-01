import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const RUN_ID = 'run-86529d771703468d4f4efd1e4439'
const PARENT_RESERVATION_ID = 'd9a63ca4-9f7b-4295-9f3d-3ba2ecdc0ee5'
const COMPENSATED_MILLI = 120_000
const IDEMPOTENCY_KEY = `ppt-agent:quality-retry-compensation:${RUN_ID}:r0`
const CONTRACT = 'PPT_AGENT_QUALITY_RETRY_COMPENSATION_V2'
const DESTINATION = 'PARENT_RESERVATION'
const CAUSE = 'APPROVED_PAGE_PROMPT_CROSS_PAGE_CONTAMINATION'

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
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'COMPENSATION_EXPECTED_SHA_INVALID')
  const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'))
  assert(manifest?.softwareVersion === '4.0.0' && manifest?.contractVersion === '1', 'COMPENSATION_RELEASE_IDENTITY_INVALID')
  assert(manifest?.gitSha === expectedSha, 'COMPENSATION_RELEASE_SHA_MISMATCH')
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function accountSnapshot(account) {
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
assert(runRow, 'COMPENSATION_RUN_NOT_FOUND')
const run = JSON.parse(runRow.data)
assert(run.source?.kind === 'APPROVED_PAGE_DESIGN' && run.automationLevel === 'SUPERVISED',
  'COMPENSATION_RUN_CONTRACT_MISMATCH')
assert(run.revisionRound === 0 || run.revisionRound === 1, 'COMPENSATION_RUN_ROUND_MISMATCH')
const r0Steps = agent.query(`
  SELECT data FROM agent_steps
  WHERE run_id = ? AND tool = 'generate_slide_image' AND status = 'COMPLETED'
  ORDER BY rowid
`).all(RUN_ID).map((row) => JSON.parse(row.data)).filter((step) => step.idempotencyKey.endsWith(':r0:v1'))
assert(r0Steps.length === 12, 'COMPENSATION_R0_STEP_COUNT_MISMATCH')
const reservationIds = r0Steps.map((step) => step.budgetReservationId).sort()
assert(reservationIds.every((id) => typeof id === 'string') && new Set(reservationIds).size === 12,
  'COMPENSATION_R0_RESERVATION_MISMATCH')
agent.close()

const frameflow = apply ? new Database(frameflowPath) : new Database(frameflowPath, { readonly: true })
const existingLedger = frameflow.query(`
  SELECT userId, reservationId, type, amountMilli, availableAfterMilli, reservedAfterMilli,
         accountVersion, metadata
  FROM CreditLedgerEntry WHERE idempotencyKey = ?
`).get(IDEMPOTENCY_KEY)

const parent = frameflow.query(`
  SELECT userId, status, amountMilli, remainingMilli, settledMilli
  FROM CreditReservation WHERE id = ? AND parentReservationId IS NULL
`).get(PARENT_RESERVATION_ID)
assert(parent && parent.userId === run.host.externalUserId, 'COMPENSATION_PARENT_OWNER_MISMATCH')

const placeholders = reservationIds.map(() => '?').join(',')
const children = frameflow.query(`
  SELECT id, userId, parentReservationId, status, amountMilli, settledMilli, sourceType
  FROM CreditReservation WHERE id IN (${placeholders}) ORDER BY id
`).all(...reservationIds)
assert(children.length === 12 && children.every((child) => (
  child.userId === parent.userId
  && child.parentReservationId === PARENT_RESERVATION_ID
  && child.status === 'SETTLED'
  && child.amountMilli === 10_000
  && child.settledMilli === 10_000
  && child.sourceType === 'PPT_AGENT_MEDIA'
)), 'COMPENSATION_CHILD_STATE_MISMATCH')

const account = frameflow.query(`
  SELECT id, availableMilli, reservedMilli, totalUsedMilli, debtMilli, status, accountVersion
  FROM Credit WHERE userId = ?
`).get(parent.userId)
assert(account?.status === 'ACTIVE' && account.debtMilli === 0, 'COMPENSATION_ACCOUNT_UNAVAILABLE')

if (existingLedger) {
  const metadata = JSON.parse(existingLedger.metadata || '{}')
  const request = {
    contract: metadata.contract,
    runId: metadata.runId,
    parentReservationId: metadata.parentReservationId,
    childReservationIds: metadata.childReservationIds,
    compensatedMilli: metadata.compensatedMilli,
    destination: metadata.destination,
    cause: metadata.cause,
    accountId: metadata.account?.id,
    userId: metadata.userId,
    accountBefore: metadata.account?.before,
    parentBefore: metadata.parent?.before,
  }
  assert(metadata.contract === CONTRACT && metadata.runId === RUN_ID
    && metadata.parentReservationId === PARENT_RESERVATION_ID
    && metadata.compensatedMilli === COMPENSATED_MILLI
    && metadata.destination === DESTINATION && metadata.cause === CAUSE
    && JSON.stringify(metadata.childReservationIds) === JSON.stringify(reservationIds)
    && metadata.requestFingerprint === fingerprint(request), 'COMPENSATION_REPLAY_FINGERPRINT_MISMATCH')
  assert(existingLedger.userId === parent.userId && existingLedger.reservationId === PARENT_RESERVATION_ID
    && existingLedger.type === 'ADJUST' && existingLedger.amountMilli === 0
    && existingLedger.availableAfterMilli === metadata.account.after.availableMilli
    && existingLedger.reservedAfterMilli === metadata.account.after.reservedMilli
    && existingLedger.accountVersion === metadata.account.after.accountVersion,
  'COMPENSATION_REPLAY_LEDGER_MISMATCH')
  assert(account.accountVersion >= metadata.account.after.accountVersion, 'COMPENSATION_REPLAY_ACCOUNT_VERSION_REGRESSION')
  if (account.accountVersion === metadata.account.after.accountVersion) {
    assert(JSON.stringify(accountSnapshot(account)) === JSON.stringify(metadata.account.after),
      'COMPENSATION_REPLAY_ACCOUNT_SNAPSHOT_MISMATCH')
  }
  console.log(JSON.stringify({
    mode: 'replay', runId: RUN_ID, compensatedMilli: COMPENSATED_MILLI,
    compensationAccountVersion: metadata.account.after.accountVersion,
  }, null, 2))
  frameflow.close()
  process.exit(0)
}

assert(runRow.status === 'NEEDS_HUMAN' && run.status === 'NEEDS_HUMAN'
  && runRow.lease_until === null && run.revisionRound === 0, 'COMPENSATION_RUN_ACTIVE_OR_REVISED')
assert(parent.status === 'RESERVED' && parent.amountMilli === 600_000
  && parent.remainingMilli === 480_000 && parent.settledMilli === null, 'COMPENSATION_PARENT_STATE_MISMATCH')
assert(account.totalUsedMilli >= COMPENSATED_MILLI, 'COMPENSATION_USED_BALANCE_TOO_LOW')

const before = accountSnapshot(account)
const after = {
  ...before,
  reservedMilli: before.reservedMilli + COMPENSATED_MILLI,
  totalUsedMilli: before.totalUsedMilli - COMPENSATED_MILLI,
  accountVersion: before.accountVersion + 1,
}
const parentBefore = { status: parent.status, remainingMilli: parent.remainingMilli, settledMilli: parent.settledMilli }
const parentAfter = { status: 'RESERVED', remainingMilli: 600_000, settledMilli: null }
const request = {
  contract: CONTRACT,
  runId: RUN_ID,
  parentReservationId: PARENT_RESERVATION_ID,
  childReservationIds: reservationIds,
  compensatedMilli: COMPENSATED_MILLI,
  destination: DESTINATION,
  cause: CAUSE,
  accountId: account.id,
  userId: parent.userId,
  accountBefore: before,
  parentBefore,
}
const metadata = {
  contract: CONTRACT,
  runId: RUN_ID,
  parentReservationId: PARENT_RESERVATION_ID,
  childReservationIds: reservationIds,
  compensatedMilli: COMPENSATED_MILLI,
  destination: DESTINATION,
  cause: CAUSE,
  userId: parent.userId,
  account: { id: account.id, before, after },
  parent: { before: parentBefore, after: parentAfter },
  requestFingerprint: fingerprint(request),
}

if (apply) {
  frameflow.transaction(() => {
    const accountUpdate = frameflow.query(`
      UPDATE Credit
      SET reservedMilli = reservedMilli + ?, totalUsedMilli = totalUsedMilli - ?, accountVersion = ?
      WHERE id = ? AND accountVersion = ? AND status = 'ACTIVE' AND debtMilli = 0 AND totalUsedMilli >= ?
    `).run(COMPENSATED_MILLI, COMPENSATED_MILLI, after.accountVersion, account.id,
      before.accountVersion, COMPENSATED_MILLI)
    assert(accountUpdate.changes === 1, 'COMPENSATION_ACCOUNT_UPDATE_CONFLICT')
    const parentUpdate = frameflow.query(`
      UPDATE CreditReservation SET remainingMilli = remainingMilli + ?, updatedAt = ?
      WHERE id = ? AND status = 'RESERVED' AND amountMilli = 600000 AND remainingMilli = 480000
    `).run(COMPENSATED_MILLI, new Date().toISOString(), PARENT_RESERVATION_ID)
    assert(parentUpdate.changes === 1, 'COMPENSATION_PARENT_UPDATE_CONFLICT')
    frameflow.query(`
      INSERT INTO CreditLedgerEntry (
        id, userId, reservationId, actorUserId, type, amountMilli,
        availableAfterMilli, reservedAfterMilli, accountVersion,
        idempotencyKey, reason, metadata, createdAt
      ) VALUES (?, ?, ?, NULL, 'ADJUST', 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), parent.userId, PARENT_RESERVATION_ID,
      after.availableMilli, after.reservedMilli, after.accountVersion,
      IDEMPOTENCY_KEY,
      '首轮页面提示污染导致整套质检失败，失败图片费用由产品承担并回补至原任务预留',
      JSON.stringify(metadata),
      new Date().toISOString(),
    )
  }).immediate()
}

const finalAccount = frameflow.query(`
  SELECT id, availableMilli, reservedMilli, totalUsedMilli, debtMilli, status, accountVersion
  FROM Credit WHERE userId = ?
`).get(parent.userId)
const finalParent = frameflow.query(`
  SELECT status, remainingMilli, settledMilli FROM CreditReservation WHERE id = ?
`).get(PARENT_RESERVATION_ID)
const finalLedger = frameflow.query(`
  SELECT type, amountMilli, availableAfterMilli, reservedAfterMilli, accountVersion, metadata
  FROM CreditLedgerEntry WHERE idempotencyKey = ?
`).get(IDEMPOTENCY_KEY)
if (apply) {
  assert(JSON.stringify(accountSnapshot(finalAccount)) === JSON.stringify(after), 'COMPENSATION_POST_ACCOUNT_MISMATCH')
  assert(JSON.stringify(finalParent) === JSON.stringify(parentAfter), 'COMPENSATION_POST_PARENT_MISMATCH')
  assert(finalLedger?.type === 'ADJUST' && finalLedger.amountMilli === 0
    && finalLedger.availableAfterMilli === after.availableMilli
    && finalLedger.reservedAfterMilli === after.reservedMilli
    && finalLedger.accountVersion === after.accountVersion
    && JSON.parse(finalLedger.metadata).requestFingerprint === metadata.requestFingerprint,
  'COMPENSATION_POST_LEDGER_MISMATCH')
}

console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry-run',
  runId: RUN_ID,
  compensatedMilli: COMPENSATED_MILLI,
  preservedSettledChildren: children.length,
  accountBefore: before,
  accountAfter: apply ? accountSnapshot(finalAccount) : after,
  parentBefore,
  parentAfter: apply ? finalParent : parentAfter,
}, null, 2))

frameflow.close()
