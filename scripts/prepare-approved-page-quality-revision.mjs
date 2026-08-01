import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { FrameFlowHostAdapter } from '../dist/adapters/frameflow-host.js'
import { hashInput } from '../dist/core/hash.js'
import { presentationBlueprintSchema, revisionPlanSchema } from '../dist/presentation-contracts.js'

const RUN_ID = 'run-86529d771703468d4f4efd1e4439'
const PARENT_ID = 'd9a63ca4-9f7b-4295-9f3d-3ba2ecdc0ee5'
const EXPECTED_PAGES = [1, 3, 4, 5, 7, 11]
const PLAN_KEY = `${RUN_ID}:revision-plan:r2`
const BLUEPRINT_KEY = `${RUN_ID}:revision-blueprint:r2`
const COMPENSATION_KEY = `ppt-agent:quality-retry-compensation:${RUN_ID}:r1-rejected`
const COMPENSATION_CONTRACT = 'PPT_AGENT_REJECTED_PAGE_COMPENSATION_V2'
const COMPENSATION_AMOUNT = 60_000
const COMPENSATION_CAUSE = 'R1_PAGE_VISUAL_REVIEW_REJECTED'
const COMPENSATION_DESTINATION = 'PARENT_RESERVATION'
const INSTRUCTIONS = new Map([
  [1, '必须准确呈现五只小鸟、两座空鸟巢和小鸟回巢的主题关系；五只小鸟应正在飞向或停靠在两座鸟巢附近，但不要提前画出分配结果。不要出现女孩、小狗或无关人物。'],
  [3, '必须准确呈现五只小鸟从鸟巢外部陆续飞向两座鸟巢的动态尾帧，让一年级学生能观察到“总数五将分到两个鸟巢”的变化；两座鸟巢保持未完全分配状态，不要提前展示全部分配结果，不要画成小鸟从一个鸟巢飞往另一个鸟巢，也不要使用静坐阅读等无关场景。'],
  [4, '必须呈现五个可数圆片正在分到两个明确区域的操作过程，并与两个鸟巢的数量情境建立直接联系；所有圆片和分组必须清楚可辨。'],
  [5, '忽略原提示中的“两个空分区”状态，最终画面必须把恰好五个圆片按1和4或2和3分放到两个均非空的分区托盘内，直观呈现总数五分成两个部分；采用统一儿童友好教育插画风格，避免写实产品渲染。'],
  [7, '必须继续使用同一组恰好五个圆片，以一个整体和两个均非空部分的清晰空间关系表现“分”与“合”的双向表达；可以用自然的聚拢与分开动势辅助理解，但不要改用小鸟，不要出现文字、数字、算式或无意义装饰。'],
  [11, '必须呈现五只小鸟正在进入、离开或分别停靠两个鸟巢的明确动作与分组，让两个部分和总数五的关系清晰可数；不要让鸟巢保持空置。'],
])

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
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'QUALITY_REVISION_EXPECTED_SHA_INVALID')
  const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'))
  assert(manifest?.softwareVersion === '4.0.0' && manifest?.contractVersion === '1', 'QUALITY_REVISION_RELEASE_IDENTITY_INVALID')
  assert(manifest?.gitSha === expectedSha, 'QUALITY_REVISION_RELEASE_SHA_MISMATCH')
}

function digest(value) {
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

const databasePath = option('--database')
const frameflowPath = option('--frameflow-database')
const expectedSha = option('--expected-sha')
const apply = process.argv.includes('--apply')
assertRelease(expectedSha)
const database = apply ? new Database(databasePath) : new Database(databasePath, { readonly: true })

const row = database.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
assert(row, 'QUALITY_REVISION_RUN_NOT_FOUND')
const run = JSON.parse(row.data)
assert(run.source?.kind === 'APPROVED_PAGE_DESIGN' && run.automationLevel === 'SUPERVISED'
  && run.maxRevisionRounds === 2 && run.qualityOverride === false
  && run.qualityOverrideBy == null && run.qualityOverrideReason == null,
'QUALITY_REVISION_RUN_CONTRACT_MISMATCH')
const existingPlan = database.query('SELECT data, tool, status FROM agent_steps WHERE run_id = ? AND idempotency_key = ?')
  .all(RUN_ID, PLAN_KEY)
const existingBlueprint = database.query('SELECT data, tool, status FROM agent_steps WHERE run_id = ? AND idempotency_key = ?')
  .all(RUN_ID, BLUEPRINT_KEY)
const replay = run.revisionRound === 2
const replayStatuses = new Set(['REVISING', 'PAGE_REVIEW', 'DECK_REVIEW', 'DELIVERING', 'COMPLETED', 'NEEDS_HUMAN'])
assert((!replay && row.status === 'NEEDS_HUMAN' && run.status === 'NEEDS_HUMAN'
  && run.revisionRound === 1 && row.lease_until === null)
  || (replay && row.status === run.status && replayStatuses.has(run.status)
    && row.lease_until === null), 'QUALITY_REVISION_RUN_STATE_MISMATCH')
if (replay) {
  assert(existingPlan.length === 1 && existingPlan[0].tool === 'plan_revision'
    && existingPlan[0].status === 'COMPLETED', 'QUALITY_REVISION_REPLAY_PLAN_MISMATCH')
  assert(existingBlueprint.length === 1 && existingBlueprint[0].tool === 'apply_revision'
    && existingBlueprint[0].status === 'COMPLETED', 'QUALITY_REVISION_REPLAY_BLUEPRINT_MISMATCH')
} else {
  assert(existingPlan.length === 0 && existingBlueprint.length === 0, 'QUALITY_REVISION_ALREADY_EXISTS')
}
const deliveryCount = database.query('SELECT COUNT(*) AS count FROM agent_deliveries WHERE run_id = ?').get(RUN_ID).count
assert((run.status === 'COMPLETED' && deliveryCount === 1)
  || (run.status !== 'COMPLETED' && deliveryCount === 0), 'QUALITY_REVISION_DELIVERY_STATE_MISMATCH')
assert(database.query(`
  SELECT COUNT(*) AS count FROM agent_steps WHERE run_id = ? AND idempotency_key LIKE '%:r3%'
`).get(RUN_ID).count === 0, 'QUALITY_REVISION_R3_EXISTS')
const replayPlanData = replay ? JSON.parse(existingPlan[0].data) : null
const replayPlan = replay ? revisionPlanSchema.parse(replayPlanData.output) : null
const openIssues = database.query('SELECT issue_id, data FROM agent_open_issues WHERE run_id = ? ORDER BY sequence')
  .all(RUN_ID).map((entry) => ({ issueId: entry.issue_id, payload: JSON.parse(entry.data).payload }))
let issues = openIssues
if (replay) {
  const planIssueIds = replayPlan.operations.flatMap((operation) => operation.issueIds).sort()
  assert(replayPlan.operations.length === 6 && planIssueIds.length === 6 && new Set(planIssueIds).size === 6,
    'QUALITY_REVISION_REPLAY_PLAN_ISSUES_MISMATCH')
  const events = database.query('SELECT data FROM agent_events WHERE run_id = ? ORDER BY sequence').all(RUN_ID)
    .map((entry) => JSON.parse(entry.data))
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
  'QUALITY_REVISION_REPLAY_RESOLVED_ISSUES_MISMATCH')
  issues = planIssueIds.map((issueId) => ({ issueId, payload: detected.get(issueId) }))
}
issues.sort((left, right) => Number(left.payload.slideIds?.[0]?.split(':').at(-1))
  - Number(right.payload.slideIds?.[0]?.split(':').at(-1)))
const pages = issues.map((issue) => Number(issue.payload.slideIds?.[0]?.split(':').at(-1))).sort((a, b) => a - b)
assert(issues.length === 6 && issues.every((issue) => issue.payload.category === 'IMAGE_QUALITY'
  && issue.payload.severity === 'WARNING'), 'QUALITY_REVISION_ISSUES_MISMATCH')
assert(JSON.stringify(pages) === JSON.stringify(EXPECTED_PAGES), 'QUALITY_REVISION_PAGES_MISMATCH')
const r1Steps = database.query(`
  SELECT data FROM agent_steps WHERE run_id = ? AND tool = 'generate_slide_image' AND status = 'COMPLETED'
`).all(RUN_ID).map((entry) => JSON.parse(entry.data)).filter((step) => step.idempotencyKey.endsWith(':r1:v1'))
assert(r1Steps.length === 12, 'QUALITY_REVISION_R1_IMAGES_MISMATCH')
const rejectedReservationIds = r1Steps
  .filter((step) => EXPECTED_PAGES.includes(Number(step.output?.slideId?.split(':').at(-1))))
  .map((step) => step.budgetReservationId).sort()
assert(rejectedReservationIds.length === 6 && rejectedReservationIds.every((id) => typeof id === 'string')
  && new Set(rejectedReservationIds).size === 6, 'QUALITY_REVISION_R1_RESERVATIONS_MISMATCH')
assert(database.query(`
  SELECT COUNT(*) AS count FROM agent_steps
  WHERE run_id = ? AND tool = 'review_slide_image' AND status = 'COMPLETED'
    AND idempotency_key LIKE '%:r1:v1:review'
`).get(RUN_ID).count === 12, 'QUALITY_REVISION_R1_REVIEWS_MISMATCH')

const previousStep = database.query('SELECT data FROM agent_steps WHERE run_id = ? AND idempotency_key = ?')
  .get(RUN_ID, `${RUN_ID}:revision-blueprint:r1`)
assert(previousStep, 'QUALITY_REVISION_R1_BLUEPRINT_MISSING')
const previousBlueprint = presentationBlueprintSchema.parse(JSON.parse(previousStep.data).output)
const document = await new FrameFlowHostAdapter({}).resolve({ host: run.host, source: run.source })
assert(document.isComplete, 'QUALITY_REVISION_SOURCE_INCOMPLETE')
const replayBlueprintData = replay ? JSON.parse(existingBlueprint[0].data) : null
const now = replay ? replayPlan.createdAt : new Date().toISOString()
const plan = revisionPlanSchema.parse({
  id: `${RUN_ID}:revision-plan:r2`,
  reviewId: `${RUN_ID}:page-review:r1`,
  revisionRound: 2,
  createdAt: now,
  summary: '重绘六个未通过页级视觉质检的页面，保留其余六页和全部已审核教学文案。',
  operations: issues.map((issue) => {
    const pageNumber = Number(issue.payload.slideIds[0].split(':').at(-1))
    return {
      id: `${RUN_ID}:quality-operation:r2:page:${pageNumber}`,
      slideId: `${RUN_ID}:slide:${pageNumber}`,
      kind: 'REGENERATE_IMAGE',
      issueIds: [issue.issueId],
      instruction: INSTRUCTIONS.get(pageNumber),
      sourceChunkIds: [],
    }
  }),
})
const revisedBlueprint = presentationBlueprintSchema.parse({
  ...previousBlueprint,
  id: `${RUN_ID}:revision-blueprint:r2`,
  createdAt: replay
    ? presentationBlueprintSchema.parse(replayBlueprintData.output).createdAt
    : now,
})
const planInputHash = hashInput({ tool: 'plan_revision', plan })
const blueprintInputHash = hashInput({
  tool: 'apply_revision',
  base: previousBlueprint,
  plan,
  sourceChunks: document.chunks.map(({ id, sha256 }) => ({ id, sha256 })),
})

const frameflow = new Database(frameflowPath, { readonly: true })
const compensation = frameflow.query(`
  SELECT userId, reservationId, type, amountMilli, availableAfterMilli, reservedAfterMilli,
         accountVersion, metadata FROM CreditLedgerEntry WHERE idempotencyKey = ?
`).get(COMPENSATION_KEY)
assert(compensation, 'QUALITY_REVISION_COMPENSATION_MISSING')
const compensationMetadata = JSON.parse(compensation.metadata || '{}')
const issueIds = issues.map((issue) => issue.issueId).sort()
const compensationRequest = {
  contract: COMPENSATION_CONTRACT,
  runId: RUN_ID,
  parentReservationId: PARENT_ID,
  rejectedPages: EXPECTED_PAGES,
  issueIds,
  childReservationIds: rejectedReservationIds,
  compensatedMilli: COMPENSATION_AMOUNT,
  cause: COMPENSATION_CAUSE,
  destination: COMPENSATION_DESTINATION,
  accountBefore: compensationMetadata.account?.before,
  parentBefore: compensationMetadata.parent?.before,
}
assert(compensationMetadata.contract === COMPENSATION_CONTRACT
  && compensationMetadata.runId === RUN_ID
  && compensationMetadata.parentReservationId === PARENT_ID
  && JSON.stringify(compensationMetadata.rejectedPages) === JSON.stringify(EXPECTED_PAGES)
  && JSON.stringify(compensationMetadata.issueIds) === JSON.stringify(issueIds)
  && JSON.stringify(compensationMetadata.childReservationIds) === JSON.stringify(rejectedReservationIds)
  && compensationMetadata.compensatedMilli === COMPENSATION_AMOUNT
  && compensationMetadata.cause === COMPENSATION_CAUSE
  && compensationMetadata.destination === COMPENSATION_DESTINATION
  && compensationMetadata.requestFingerprint === digest(compensationRequest),
'QUALITY_REVISION_COMPENSATION_CONTRACT_MISMATCH')
const parent = frameflow.query(`
  SELECT userId, status, amountMilli, remainingMilli, settledMilli
  FROM CreditReservation WHERE id = ? AND parentReservationId IS NULL
`).get(PARENT_ID)
const parentReady = parent?.userId === run.host.externalUserId && parent.amountMilli === 600_000
  && ((!replay && parent.status === 'RESERVED' && parent.remainingMilli === 540_000 && parent.settledMilli === null)
    || (replay && parent.status === 'RESERVED' && parent.settledMilli === null
      && Number.isSafeInteger(parent.remainingMilli) && parent.remainingMilli >= 480_000
      && parent.remainingMilli <= 540_000 && parent.remainingMilli % 10_000 === 0)
    || (replay && parent.status === 'RELEASED' && parent.remainingMilli === 0
      && Number.isSafeInteger(parent.settledMilli) && parent.settledMilli >= 60_000
      && parent.settledMilli <= 120_000 && parent.settledMilli % 10_000 === 0))
assert(parentReady, 'QUALITY_REVISION_COMPENSATION_PARENT_MISMATCH')
const account = frameflow.query(`
  SELECT id, availableMilli, reservedMilli, totalUsedMilli, debtMilli, status, accountVersion
  FROM Credit WHERE userId = ?
`).get(parent.userId)
assert(account?.status === 'ACTIVE' && account.debtMilli === 0
  && account.accountVersion >= compensationMetadata.account.after.accountVersion,
'QUALITY_REVISION_COMPENSATION_ACCOUNT_MISMATCH')
if (account.accountVersion === compensationMetadata.account.after.accountVersion) {
  assert(JSON.stringify(accountSnapshot(account)) === JSON.stringify(compensationMetadata.account.after),
    'QUALITY_REVISION_COMPENSATION_ACCOUNT_SNAPSHOT_MISMATCH')
}
assert(compensation.userId === parent.userId && compensation.reservationId === PARENT_ID
  && compensation.type === 'ADJUST' && compensation.amountMilli === 0
  && compensation.availableAfterMilli === compensationMetadata.account.after.availableMilli
  && compensation.reservedAfterMilli === compensationMetadata.account.after.reservedMilli
  && compensation.accountVersion === compensationMetadata.account.after.accountVersion,
'QUALITY_REVISION_COMPENSATION_LEDGER_MISMATCH')
frameflow.close()

if (replay) {
  assert(JSON.stringify(revisionPlanSchema.parse(replayPlanData.output)) === JSON.stringify(plan)
    && replayPlanData.inputHash === planInputHash, 'QUALITY_REVISION_REPLAY_PLAN_CONTRACT_MISMATCH')
  assert(JSON.stringify(presentationBlueprintSchema.parse(replayBlueprintData.output)) === JSON.stringify(revisedBlueprint)
    && replayBlueprintData.inputHash === blueprintInputHash,
  'QUALITY_REVISION_REPLAY_BLUEPRINT_CONTRACT_MISMATCH')
  console.log(JSON.stringify({ mode: 'replay', runId: RUN_ID, status: row.status,
    revisionRound: run.revisionRound, revisionPages: EXPECTED_PAGES, compensationVerified: true }, null, 2))
  database.close()
  process.exit(0)
}

if (apply) {
  database.transaction(() => {
    const planData = {
      id: `step-${RUN_ID}-quality-plan-r2`, runId: RUN_ID, idempotencyKey: PLAN_KEY,
      inputHash: planInputHash,
      tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: plan, createdAt: now, updatedAt: now,
    }
    const blueprintData = {
      id: `step-${RUN_ID}-quality-blueprint-r2`, runId: RUN_ID, idempotencyKey: BLUEPRINT_KEY,
      inputHash: blueprintInputHash,
      tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: revisedBlueprint, createdAt: now, updatedAt: now,
    }
    database.query(`
      INSERT INTO agent_steps (id, run_id, idempotency_key, data, tool, status)
      VALUES (?, ?, ?, ?, 'plan_revision', 'COMPLETED')
    `).run(planData.id, RUN_ID, PLAN_KEY, JSON.stringify(planData))
    database.query(`
      INSERT INTO agent_steps (id, run_id, idempotency_key, data, tool, status)
      VALUES (?, ?, ?, ?, 'apply_revision', 'COMPLETED')
    `).run(blueprintData.id, RUN_ID, BLUEPRINT_KEY, JSON.stringify(blueprintData))
    database.query('DELETE FROM agent_progress WHERE run_id = ?').run(RUN_ID)
    const next = { ...run, status: 'REVISING', revisionRound: 2, version: Number(run.version) + 1,
      leaseToken: null, leaseUntil: null, updatedAt: now }
    const update = database.query(`
      UPDATE agent_runs SET data = ?, status = 'REVISING', lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'NEEDS_HUMAN' AND lease_until IS NULL
    `).run(JSON.stringify(next), now, RUN_ID)
    assert(update.changes === 1, 'QUALITY_REVISION_RUN_UPDATE_FAILED')
    let sequence = Number(database.query('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_events WHERE run_id = ?')
      .get(RUN_ID).sequence)
    for (const event of [
      { type: 'tool.completed', payload: { stepId: planData.id, summary: '已建立六页局部质量修订计划' } },
      { type: 'approval.resolved', payload: { kind: 'REVISION', actionType: 'APPROVE_REVISION' } },
      { type: 'tool.completed', payload: { stepId: blueprintData.id, summary: '已锁定第二轮局部修订蓝图' } },
      { type: 'phase.changed', payload: { from: 'NEEDS_HUMAN', to: 'REVISING', reason: 'APPROVED_PAGE_QUALITY_REVISION_R2' } },
    ]) {
      sequence += 1
      database.query('INSERT INTO agent_events (run_id, sequence, data) VALUES (?, ?, ?)').run(
        RUN_ID, sequence, JSON.stringify({ schemaVersion: '1', id: `${RUN_ID}:quality-r2:${sequence}`,
          runId: RUN_ID, sequence, createdAt: now, ...event }))
    }
  }).immediate()
}

const finalRow = database.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
const finalRun = JSON.parse(finalRow.data)
if (apply) {
  assert(finalRow.status === 'REVISING' && finalRun.status === 'REVISING'
    && finalRun.revisionRound === 2 && finalRow.lease_until === null,
  'QUALITY_REVISION_POST_RUN_MISMATCH')
  assert(database.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count === 6,
    'QUALITY_REVISION_POST_ISSUES_MISMATCH')
}
console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', runId: RUN_ID,
  status: finalRow.status, revisionRound: finalRun.revisionRound, revisionPages: EXPECTED_PAGES,
  openIssues: database.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count,
}, null, 2))
database.close()
