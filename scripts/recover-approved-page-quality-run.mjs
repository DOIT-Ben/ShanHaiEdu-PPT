import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  approvedPageLayout,
  approvedPageVisualDirection,
  approvedPageVisualPrompt,
} from '../dist/core/planning-runner.js'
import { presentationBlueprintSchema } from '../dist/presentation-contracts.js'

const RUN_ID = 'run-86529d771703468d4f4efd1e4439'
const REVISION_KEY = `${RUN_ID}:revision-blueprint:r1`

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
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'RECOVERY_EXPECTED_SHA_INVALID')
  const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'))
  assert(manifest?.softwareVersion === '4.0.0' && manifest?.contractVersion === '1', 'RECOVERY_RELEASE_IDENTITY_INVALID')
  assert(manifest?.gitSha === expectedSha, 'RECOVERY_RELEASE_SHA_MISMATCH')
}

function parseStep(row) {
  return { ...row, value: JSON.parse(row.data) }
}

function expectedRevisionBlueprint(run, previousBlueprint, createdAt) {
  const source = run.source
  return presentationBlueprintSchema.parse({
    ...previousBlueprint,
    id: `${RUN_ID}:revision-blueprint:r1`,
    visualDirection: approvedPageVisualDirection(source),
    slides: previousBlueprint.slides.map((slide, index) => {
      const page = source.pages[index]
      assert(page?.pageNumber === slide.pageNumber, 'RECOVERY_BLUEPRINT_PAGE_MISMATCH')
      return {
        ...slide,
        layout: approvedPageLayout(page.layoutIntent, index),
        visualIntent: `本页教学目标：${page.teachingPurpose}`,
        visualPrompt: approvedPageVisualPrompt(source, page, index),
      }
    }),
    createdAt,
  })
}

function assertRevisionBlueprint(run, blueprint) {
  assert(blueprint.id === `${RUN_ID}:revision-blueprint:r1`, 'RECOVERY_REVISION_BLUEPRINT_ID_MISMATCH')
  assert(blueprint.visualDirection === approvedPageVisualDirection(run.source), 'RECOVERY_VISUAL_DIRECTION_MISMATCH')
  assert(blueprint.slides.length === run.source.pages.length, 'RECOVERY_REVISION_SLIDE_COUNT_MISMATCH')
  for (const [index, slide] of blueprint.slides.entries()) {
    const page = run.source.pages[index]
    assert(page?.pageNumber === slide.pageNumber, 'RECOVERY_REVISION_PAGE_MISMATCH')
    assert(slide.visualPrompt === approvedPageVisualPrompt(run.source, page, index), 'RECOVERY_VISUAL_PROMPT_MISMATCH')
  }
}

const databasePath = option('--database')
const expectedSha = option('--expected-sha')
const apply = process.argv.includes('--apply')
assertRelease(expectedSha)

const database = apply ? new Database(databasePath) : new Database(databasePath, { readonly: true })
const row = database.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
assert(row, 'RECOVERY_RUN_NOT_FOUND')
const run = JSON.parse(row.data)
assert(run.source?.kind === 'APPROVED_PAGE_DESIGN', 'RECOVERY_SOURCE_MISMATCH')
assert(run.presentationMode === 'SLIDE_IMAGE_V2' && run.slideCount === 12, 'RECOVERY_MODE_MISMATCH')
assert(run.automationLevel === 'SUPERVISED', 'RECOVERY_AUTOMATION_LEVEL_MISMATCH')
assert(run.maxRevisionRounds >= 1, 'RECOVERY_REVISION_NOT_ALLOWED')
assert(run.committedBudgetUnits === 12 && run.budgetUnits === 60, 'RECOVERY_BUDGET_MISMATCH')

const steps = database.query('SELECT id, idempotency_key, tool, status, data FROM agent_steps WHERE run_id = ? ORDER BY rowid')
  .all(RUN_ID).map(parseStep)
const revisionSteps = steps.filter((step) => step.idempotency_key === REVISION_KEY)

if (run.revisionRound === 1) {
  assert(revisionSteps.length === 1 && revisionSteps[0].tool === 'apply_revision'
    && revisionSteps[0].status === 'COMPLETED', 'RECOVERY_REPLAY_REVISION_STEP_MISMATCH')
  assertRevisionBlueprint(run, presentationBlueprintSchema.parse(revisionSteps[0].value.output))
  assert(!steps.some((step) => step.idempotency_key.includes(':r2')), 'RECOVERY_REPLAY_R2_EXISTS')
  console.log(JSON.stringify({
    mode: 'replay', runId: RUN_ID, status: row.status, revisionRound: run.revisionRound,
    revisionBlueprintSteps: 1,
    openIssues: database.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count,
  }, null, 2))
  database.close()
  process.exit(0)
}

assert(row.status === 'NEEDS_HUMAN' && run.status === 'NEEDS_HUMAN', 'RECOVERY_RUN_STATUS_MISMATCH')
assert(row.lease_until === null && run.leaseToken === null && run.leaseUntil === null, 'RECOVERY_ACTIVE_LEASE')
assert(run.planningAttempt === 0 && run.revisionRound === 0, 'RECOVERY_ROUND_MISMATCH')
assert(revisionSteps.length === 0, 'RECOVERY_REVISION_BLUEPRINT_EXISTS')

const pageSteps = steps.filter((step) => step.tool === 'generate_slide_image')
const reviewSteps = steps.filter((step) => step.tool === 'review_slide_image')
const planningSteps = steps.filter((step) => step.tool === 'create_blueprint')
assert(pageSteps.length === 12 && pageSteps.every((step) => step.status === 'COMPLETED'), 'RECOVERY_PAGE_STEPS_MISMATCH')
assert(reviewSteps.length === 12 && reviewSteps.every((step) => step.status === 'COMPLETED'), 'RECOVERY_REVIEW_STEPS_MISMATCH')
assert(planningSteps.length === 1 && planningSteps[0].status === 'COMPLETED', 'RECOVERY_PLANNING_STEPS_MISMATCH')
assert(database.query('SELECT COUNT(*) AS count FROM agent_deliveries WHERE run_id = ?').get(RUN_ID).count === 0,
  'RECOVERY_DELIVERY_EXISTS')

const issues = database.query('SELECT issue_id, data FROM agent_open_issues WHERE run_id = ? ORDER BY sequence').all(RUN_ID)
assert(issues.length === 12, 'RECOVERY_OPEN_ISSUE_COUNT_MISMATCH')
for (const issue of issues) {
  assert(JSON.parse(issue.data).payload?.category === 'IMAGE_QUALITY', 'RECOVERY_OPEN_ISSUE_CATEGORY_MISMATCH')
}

const previousBlueprint = presentationBlueprintSchema.parse(planningSteps[0].value.output)
const now = new Date().toISOString()
const revisedBlueprint = expectedRevisionBlueprint(run, previousBlueprint, now)
assertRevisionBlueprint(run, revisedBlueprint)

if (apply) {
  const nextRun = {
    ...run,
    status: 'EXECUTING',
    planningAttempt: 0,
    revisionRound: 1,
    version: Number(run.version) + 1,
    leaseToken: null,
    leaseUntil: null,
    updatedAt: now,
  }
  database.transaction(() => {
    database.query(`
      INSERT INTO agent_steps (id, run_id, idempotency_key, data, tool, status)
      VALUES (?, ?, ?, ?, 'apply_revision', 'COMPLETED')
    `).run(
      `step-${RUN_ID}-prompt-isolation-r1`,
      RUN_ID,
      REVISION_KEY,
      JSON.stringify({
        id: `step-${RUN_ID}-prompt-isolation-r1`,
        runId: RUN_ID,
        idempotencyKey: REVISION_KEY,
        inputHash: createHash('sha256').update(JSON.stringify(revisedBlueprint)).digest('hex'),
        tool: 'apply_revision',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: revisedBlueprint,
        createdAt: now,
        updatedAt: now,
      }),
    )
    database.query('DELETE FROM agent_progress WHERE run_id = ?').run(RUN_ID)
    const deletedIssues = database.query('DELETE FROM agent_open_issues WHERE run_id = ?').run(RUN_ID)
    assert(deletedIssues.changes === 12, 'RECOVERY_OPEN_ISSUE_DELETE_MISMATCH')

    let sequence = Number(database.query('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_events WHERE run_id = ?')
      .get(RUN_ID).sequence)
    for (const issue of issues) {
      sequence += 1
      database.query('INSERT INTO agent_events (run_id, sequence, data) VALUES (?, ?, ?)').run(
        RUN_ID,
        sequence,
        JSON.stringify({
          schemaVersion: '1', id: `${RUN_ID}:prompt-isolation:${sequence}`, runId: RUN_ID, sequence, createdAt: now,
          type: 'issue.resolved', payload: { issueId: issue.issue_id, resolution: 'FIXED' },
        }),
      )
    }
    sequence += 1
    database.query('INSERT INTO agent_events (run_id, sequence, data) VALUES (?, ?, ?)').run(
      RUN_ID,
      sequence,
      JSON.stringify({
        schemaVersion: '1', id: `${RUN_ID}:prompt-isolation:phase`, runId: RUN_ID, sequence, createdAt: now,
        type: 'phase.changed',
        payload: { from: 'NEEDS_HUMAN', to: 'EXECUTING', reason: 'APPROVED_PAGE_PROMPT_ISOLATION_RECOVERY' },
      }),
    )
    const updated = database.query(`
      UPDATE agent_runs
      SET data = ?, status = 'EXECUTING', lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'NEEDS_HUMAN' AND lease_until IS NULL
    `).run(JSON.stringify(nextRun), now, RUN_ID)
    assert(updated.changes === 1, 'RECOVERY_RUN_UPDATE_FAILED')
  }).immediate()
}

const finalRow = database.query('SELECT status, data, lease_until FROM agent_runs WHERE id = ?').get(RUN_ID)
const finalRun = JSON.parse(finalRow.data)
const finalRevisionSteps = database.query('SELECT data, tool, status FROM agent_steps WHERE run_id = ? AND idempotency_key = ?')
  .all(RUN_ID, REVISION_KEY)
if (apply) {
  assert(finalRow.status === 'EXECUTING' && finalRun.status === 'EXECUTING'
    && finalRun.revisionRound === 1 && finalRun.planningAttempt === 0, 'RECOVERY_POST_RUN_MISMATCH')
  assert(finalRow.lease_until === null && finalRevisionSteps.length === 1
    && finalRevisionSteps[0].tool === 'apply_revision' && finalRevisionSteps[0].status === 'COMPLETED',
  'RECOVERY_POST_REVISION_STEP_MISMATCH')
  assertRevisionBlueprint(finalRun, presentationBlueprintSchema.parse(JSON.parse(finalRevisionSteps[0].data).output))
  assert(database.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count === 0,
    'RECOVERY_POST_OPEN_ISSUES_MISMATCH')
}

console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry-run',
  runId: RUN_ID,
  status: finalRow.status,
  planningAttempt: finalRun.planningAttempt,
  revisionRound: finalRun.revisionRound,
  automationLevel: finalRun.automationLevel,
  preservedPageSteps: pageSteps.length,
  preservedReviewSteps: reviewSteps.length,
  revisionBlueprintSteps: finalRevisionSteps.length,
  openIssues: database.query('SELECT COUNT(*) AS count FROM agent_open_issues WHERE run_id = ?').get(RUN_ID).count,
}, null, 2))

database.close()
