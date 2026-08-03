# Implementation Plan: V4 Terminal Delivery and Selective Planning Reflection

## 1. Scope

### Objective

Deliver two ordered changes on top of `origin/main` commit
`0d078c35bb0fbc2e1e74e8f4fe8766d7fe3b78ed`:

1. Resolve the P0 consumer dead end in GitHub Issue #29 before any reflection work.
2. Implement the bounded, source-grounded Reflect-and-Revise workflow in GitHub Issue #30.
3. Reassess the remaining open PPT Agent Issues only after both changes and their quality gates pass.

This work is limited to `/srv/codex-workspace/PPT-Agent`. It does not modify FrameFlow and it does not deploy production.

### Acceptance criteria for Issue #29

- A standard `VISUAL_DECK_V4` Run cannot remain in ordinary-user `NEEDS_HUMAN` because quality remediation is exhausted.
- Page-review rejection that cannot start another automatic revision ends as
  `FAILED(QUALITY_REMEDIATION_EXHAUSTED)` rather than requesting user quality approval.
- Deck-review rejection at `maxRevisionRounds` ends as
  `FAILED(QUALITY_REMEDIATION_EXHAUSTED)`.
- A currently passing Deck Review with unresolved historical blocking Issues ends as
  `FAILED(QUALITY_ISSUE_STATE_INCONSISTENT)` rather than requesting user quality approval.
- New V4 terminal failures publish a stable, replay-safe terminal event containing authorization,
  submission, settlement, release, and reconciliation status.
- Ordinary users cannot use `ACCEPT_WITH_OVERRIDE` to obtain a V4 FINAL delivery. An ADMIN-only,
  audited override remains available for internal governance and remains impossible for critical
  issues unless every open issue is acknowledged.
- Every newly created successful delivery is explicitly `FINAL`; a V4 `COMPLETED` transition is
  rejected unless the delivery has a non-empty preview and PPTX, correct MIME types, hashes, byte
  lengths, exact page set/count, active blueprint/proposal hash, current revision identity, and an
  approved or internally overridden quality status.
- Existing `/v1` request shapes, status names, endpoint paths, and existing persisted deliveries
  remain readable. New delivery metadata and terminal accounting are additive/defaulted.
- No serious teaching, factual, knowledge, source, or countability issue is delivered as an
  ordinary approved FINAL artifact.

### Acceptance criteria for Issue #30

- The normal V4 planning sequence is exactly:

  ```text
  source-spec
  -> deck-visual draft
  -> reflect-and-revise deck-visual
  -> slide-briefs draft
  -> reflect-and-revise slide-briefs
  -> deterministic proposal validation and prompt compilation
  ```

- The old Final Coherence Review call is replaced by Slide Brief reflection. The normal path uses
  five text-model calls, exactly one more than the current four-call workflow.
- Reflection is never invoked once per slide.
- Each reflection input separates original request, trusted evidence, frozen constraints, candidate
  artifact, candidate hash, rubric version, and provider capabilities.
- Each reflection result is a strict discriminated result: `UNCHANGED` or `REVISED`, with stable
  findings, evidence, executable revision instructions, the base hash, and applied finding IDs.
- Deck/Visual revision returns the complete Deck Plan and Visual Contract. Slide Brief revision
  returns only affected pages; the core merges them deterministically by `pageNumber`.
- `UNCHANGED` preserves the candidate byte-for-byte at the structured value level. `REVISED` cannot
  mutate frozen constraints or pages/fields outside the reported findings.
- Both reflection stages have independent stable idempotency keys bound to planning attempt,
  candidate hash, rubric version, and selected structured-generation protocol. A restart resumes
  only the current stage and does not change keys.
- Reflection output must pass Zod, base-hash, frozen-field, source-role, source-reference, slide-count,
  page-order, visible-copy, and whole-proposal validation before image generation can begin.
- The page 6 duplicate-count pattern and page 12 unauthorized-numbering pattern are represented by
  regression fixtures and are corrected before deterministic prompt compilation.
- Reflection timeouts and other technical Provider failures use existing V4 technical recovery and
  never create an ordinary-user blueprint confirmation or `NEEDS_HUMAN` quality task.
- No FrameFlow changes, no Hybrid mode, no user blueprint approval, no image-provider contract
  changes, and no unbounded reflection loop.

## 2. Non-goals

- Do not implement DRAFT delivery generation; that remains GitHub Issue #13. This change adds and
  enforces FINAL identity without presenting an unreviewed artifact as FINAL.
- Do not implement image-to-image revision; that remains Issue #27.
- Do not implement deterministic teaching diagrams; that remains Issue #9.
- Do not modify Nano Banana, `/image-tasks`, FrameFlow, host credit endpoints, or production config.
- Do not add per-slide reflection calls or always-on Evaluator + Optimizer calls.
- Do not close or rewrite unrelated Issues without fresh code and test evidence.
- Do not stage the pre-existing `README.md`,
  `docs/v4-pptx-delivery-contract-failure-20260803.md`, or `output/` changes.

## 3. Architecture decisions

### 3.1 P0 terminal outcome is explicit failure, not a hidden queue

The repository has no internal operations queue with an SLA and bounded ownership. Therefore the
P0 implementation uses the Issue #29 minimum allowed outcome: when bounded quality remediation can
no longer proceed, terminate as a stable, non-retryable failure. It does not invent an internal queue
or silently deliver a defective deck.

### 3.2 Terminal accounting uses one canonical batch reducer

Add one strict terminal-accounting contract derived once from the Run and every durable
`generate_image_batch` Step. A batch is counted exactly once; its `pages[].idempotencyKey` entries
are the only association to page media Steps. The reducer must never add the batch Step's
`budgetUnits` to page Step units, because that would double count the same authorization.

For every INITIAL and REVISION batch, the reducer must:

1. Parse the persisted `GenerationBatch` and require every listed page key to resolve to exactly one
   image Step.
2. Reject FINAL classification while a batch or referenced page is absent, `RUNNING`, `RESERVED`,
   `SUBMITTING`, `WAITING`, `RELEASING`, `RESERVATION_UNKNOWN`, `SUBMISSION_UNKNOWN`, or
   `BILLING_UNKNOWN`.
3. Derive submitted units only from referenced page Steps that reached a submitted/charged state.
4. Sum settled and released units once from finalized batch accounting, and require every batch
   settlement to be `SETTLED` or `RELEASED`.
5. Require aggregate batch `settledUnits === Run.committedBudgetUnits` and ensure no unrelated image
   Step for the Run is omitted from all batches.
6. Treat authorization outside generated batches as released only after all known batches are final;
   then require `settledUnits + releasedUnits === authorizedUnits`.

For new terminal V4 events it reports:

- `authorizedUnits`: the Run authorization ceiling;
- `submittedUnits`: budget units whose image operations reached a submitted/charged state;
- `settledUnits`: the Run's durable committed units after batch finalization;
- `releasedUnits`: authorization not settled;
- `reconciliationUnits`: units still unknown;
- `accountingStatus`: `FINAL` or `RECONCILIATION_REQUIRED`.

`FINAL` requires all six reducer conditions, zero reconciliation units, and
`settledUnits + releasedUnits === authorizedUnits`. The quality-exhaustion path is allowed to become
terminal only with FINAL accounting. Missing, active, or unknown media/batch state remains in the
existing reconciliation/technical-recovery path and cannot publish a FINAL terminal event.

### 3.3 Delivery compatibility is additive

Extend new `DeliveryRecord` values with metadata:

- `disposition: FINAL` for all existing and newly created records;
- `qualityStatus: APPROVED | OVERRIDDEN_INTERNAL`;
- `openIssueIds` for auditable internal override context.
- a discriminated `identity` value:
  - new records use `VERIFIED` with `pageNumbers`, `slideCount`, `blueprintHash`, and, for V4,
    `proposalHash`, all bound to the exact active artifact used for rendering;
  - normalized old records use `LEGACY_UNVERIFIED` and do not fabricate page/hash evidence.

No DRAFT record is emitted in this change. Compatibility is implemented at every Delivery read
boundary, not assumed from Zod defaults: SQLite `listDeliveries`/`getDelivery` and completed-step
replay parse legacy JSON through one compatibility function. It derives legacy `qualityStatus` from
`qualityOverride` (`true -> OVERRIDDEN_INTERNAL`, `false -> APPROVED`) but marks page/hash identity as
legacy/unknown rather than fabricating evidence. Newly created V4 FINAL values require full identity.
The delivery runner validates the record against the current active blueprint in the same transaction
as the atomic `COMPLETED` transition.

### 3.4 Reflection follows existing V2.1 and published patterns

Reuse the repository's one-call V2.1 Reflection structure from ADR-004, its structured model port,
stage persistence, contract repair, and stable key conventions. Record the V4 decision in ADR-006,
grounded in:

- Self-Refine (`https://arxiv.org/abs/2303.17651` and its official implementation);
- Anthropic's Evaluator-Optimizer workflow (`https://www.anthropic.com/engineering/building-effective-agents`);
- CRITIC (`https://arxiv.org/abs/2305.11738`);
- Reflexion's distinction between episodic memory and immediate artifact revision
  (`https://arxiv.org/abs/2303.11366`);
- evidence on intrinsic self-correction limitations (`https://arxiv.org/abs/2310.01798`).

The default is one structured request that evaluates and revises an artifact. External deterministic
validation remains authoritative, and iteration is bounded.

### 3.5 Two persisted reflection stages, no per-page calls

Add planning stages `reflect-deck-visual` and `reflect-slide-briefs`. Each stores its complete model
result immediately. The first produces a complete final Deck/Visual artifact. The second produces
only revised affected pages and deterministically merges them with the candidate array.

Every finding declares a closed mutation scope. Deck/Visual findings use an allowlisted structured
field path. Slide Brief findings use `pageNumber + fieldPaths`, where field paths are limited to the
mutable Slide Brief fields. After parsing, core code computes a deterministic deep diff between the
candidate and revised artifact. Every changed leaf path must be covered by an applied finding, every
applied finding must produce a covered change, and `UNCHANGED` must be deep-equal. This makes the
"only change findings" rule executable rather than advisory.

The rubric version is a code constant. Required dimensions include existing coherence concerns plus:

- `IMAGE_MODEL_EXECUTABILITY`
- `COUNTABILITY_RISK`
- `UNAUTHORIZED_TEXT_RISK`
- `VISUAL_DENSITY_RISK`
- `CROSS_SLIDE_REPETITION`
- `SOURCE_ROLE_INTEGRITY`
- `PEDAGOGICAL_SEQUENCE`

High-risk two-call Evaluator + Optimizer is designed as a future bounded escalation seam, but is not
enabled until a separate acceptance corpus proves the additional cost is justified.

## 4. Dependency graph and implementation order

```text
Terminal accounting + failure event contracts
  -> V4 terminal transition helper
     -> page/deck/revision dead-end removal
     -> V4 override authorization
  -> FINAL delivery metadata and completion invariant

Reflection schemas + ADR
  -> stage identities and deterministic validators
     -> gateway prompts/structured schemas
        -> planning-runner orchestration and persistence
           -> deterministic prompt regression fixtures
```

Issue #29 is implemented, tested, and checkpointed before any Issue #30 production code.

## 5. Tasks

### Task 1: Write failing P0 terminal-contract tests

**Files likely touched:**

- `tests/revision-planning-runner.test.ts`
- `tests/page-review-coordinator.test.ts`
- `tests/deck-review-runner.test.ts`
- `tests/run-service.test.ts`
- `tests/delivery-runner.test.ts`
- `tests/contracts.test.ts`
- `tests/v4-lifecycle.test.ts`
- `tests/mock-runtime.test.ts`
- `tests/sqlite-repository.test.ts`

**Acceptance criteria:**

- Tests reproduce both known dead ends and fail against the baseline because status is
  `NEEDS_HUMAN` or because required terminal/final metadata is absent.
- Tests cover ordinary-user override rejection and ADMIN audit preservation.
- Tests cover a mixed INITIAL+REVISION Run and prove the canonical reducer does not double count.
- Tests cover FINAL versus `WAITING`, `SUBMITTING`, missing page Step, `SUBMISSION_UNKNOWN`,
  `BILLING_UNKNOWN`, mismatched committed units, and replay.

**Verification:**

- Run only the new/changed tests and record the expected failures before implementation.

**Dependencies:** None.

### Task 2: Implement terminal failure and accounting contracts

**Files likely touched:**

- `src/contracts.ts`
- `src/core/v4-lifecycle.ts`
- `src/core/technical-recovery.ts`
- `src/core/revision-planning-runner.ts`
- `src/core/page-review-coordinator.ts`
- `src/core/deck-review-runner.ts`
- `src/core/generation-batch.ts`

**Acceptance criteria:**

- Quality exhaustion and historical issue inconsistency produce one valid terminal event and no
  `approval.required(HUMAN_REVIEW)`.
- Terminal transitions are idempotent and do not bypass unknown accounting reconciliation.
- Exhausted V4 technical recovery produces explicit failure rather than an ordinary-user task;
  legacy modes keep their existing behavior.

**Verification:**

- `bun test tests/v4-lifecycle.test.ts tests/revision-planning-runner.test.ts tests/page-review-coordinator.test.ts tests/deck-review-runner.test.ts tests/technical-recovery.test.ts`

**Dependencies:** Task 1.

### Task 3: Enforce V4 override and FINAL delivery invariants

**Files likely touched:**

- `src/presentation-contracts.ts`
- `src/core/policy.ts`
- `src/core/run-service.ts`
- `src/core/delivery-runner.ts`
- `src/adapters/sqlite-repository.ts`
- `src/http/handler.ts`
- `src/http/openapi.ts` or the repository's current OpenAPI definition module
- `docs/ppt-agent-v4-api.md`

**Acceptance criteria:**

- V4 ordinary-user override fails before state mutation; ADMIN override remains fully audited.
- New deliveries are explicitly FINAL and V4 completion cannot reference a Delivery whose
  revision, complete page set, blueprint hash, or V4 proposal hash differs from the active blueprint.
- All SQLite Delivery read paths and completed-step replay normalize real legacy JSON. Historical
  overrides become `OVERRIDDEN_INTERNAL`; missing legacy page/hash evidence is not fabricated.
- Public API documentation describes stable terminal error codes, terminal accounting, and FINAL
  metadata without requiring FrameFlow-specific logic.

**Verification:**

- `bun test tests/run-service.test.ts tests/policy.test.ts tests/delivery-runner.test.ts tests/presentation-contracts.test.ts tests/sqlite-repository.test.ts tests/openapi.test.ts tests/http-handler.test.ts`

**Dependencies:** Tasks 1-2.

### Checkpoint A: Issue #29 P0 slice

- All Issue #29 targeted tests pass.
- Existing V2/V2.1/V3 state and delivery tests pass unchanged.
- No standard V4 quality path emits user approval.
- No DRAFT claim is made and Issue #13 remains open.
- Review the resulting diff before starting Issue #30.

### Task 4: Write ADR-006 and strict reflection contracts

**Files likely touched:**

- `docs/decisions/ADR-006-visual-deck-v4-selective-reflection.md`
- `src/visual-deck-v4-contracts.ts`
- `src/core/visual-deck-v4-planner.ts`
- `tests/visual-deck-v4-contracts.test.ts`

**Acceptance criteria:**

- ADR records source basis, selected two-stage design, cost bound, failure semantics, and rejected
  alternatives.
- Schemas enforce decisions, findings, base hash, affected page boundaries, allowlisted field paths,
  applied finding IDs, and all rubric dimensions.
- Deterministic deep-diff validators reject frozen-field mutation, any changed leaf outside applied
  finding scopes, unchanged applied findings, unreported page mutation, stale candidate hashes, and
  invalid source references.

**Verification:**

- New contract tests fail before implementation and pass after implementation.

**Dependencies:** Checkpoint A.

### Task 5: Implement gateway reflection requests

**Files likely touched:**

- `src/adapters/gateway-courseware-model.ts`
- `tests/gateway-courseware-model.test.ts`

**Acceptance criteria:**

- Both operations use the preflight-selected Structured Generation protocol and strict schemas.
- Prompts explicitly preserve trusted evidence/frozen constraints, treat sources as data, suppress
  hidden reasoning, prohibit gratuitous rewriting, and require evidence-backed targeted changes.
- The Slide Brief prompt explicitly checks duplicate countable-object depictions and unauthorized
  numeric labels/badges.

**Verification:**

- Gateway request-contract tests cover Responses JSON Schema and existing compatibility protocol.

**Dependencies:** Task 4.

### Task 6: Orchestrate persisted reflection and deterministic merge

**Files likely touched:**

- `src/core/planning-runner.ts`
- `src/core/visual-deck-v4-planner.ts`
- `src/core/run-service.ts`
- `tests/visual-deck-v4-planning-runner.test.ts`
- `tests/run-service.test.ts`

**Acceptance criteria:**

- The five-operation normal sequence is exact and Final Coherence is absent.
- A shared `V4_PLANNING_STAGE_COUNT = 5` drives initial, retry, replan, progress, and completion
  lifecycle events; no call site retains a hard-coded total of four.
- Each reflection stage replays its persisted result with the same key and resumes only itself.
- `UNCHANGED` and `REVISED` paths both produce a fully validated proposal; image execution begins
  only afterward.
- Invalid JSON/schema, timeout, stale hash, frozen mutation, unmatched findings, and invalid merge
  have regression tests.

**Verification:**

- `bun test tests/visual-deck-v4-planning-runner.test.ts tests/planning-runner.test.ts`

**Dependencies:** Tasks 4-5.

### Task 7: Add semantic regression fixtures for pages 6 and 12

**Files likely touched:**

- `tests/visual-deck-v4-planning-runner.test.ts`
- `tests/slide-generation-coordinator.test.ts`
- optionally a focused fixture under `tests/fixtures/`

**Acceptance criteria:**

- Before reflection, page 6's candidate brief and compiled Prompt contain the concrete dangerous
  "two display rows plus bottom aggregation visual" composition. After reflection, the persisted
  result and merged brief hash change, the bottom duplicate-object instruction disappears, and the
  actual `blueprintImageRequirements` Prompt contains the page-specific correction.
- Before reflection, page 12's candidate brief and compiled Prompt contain the concrete three-scene
  device that can induce `1/2/3`, while `1/2/3` is absent from allowed copy. After reflection, the
  persisted result and merged brief hash change, the dangerous visual cue disappears from
  composition and remains absent from numbers/locked copy, and the actual
  `blueprintImageRequirements` Prompt contains the page-specific no-numbering design.
- Source facts, exact counts, non-empty grouping semantics, and locked copy remain unchanged.
- Every non-target page remains deep-equal, proving the test is not satisfied by the compiler's
  existing generic countability/text safety suffix or by a mocked reflection response alone.

**Verification:**

- Focused fixture and deterministic prompt tests pass without any real Provider call.

**Dependencies:** Task 6.

### Checkpoint B: Issue #30 implementation

- Reflection contracts, gateway requests, persistence, recovery, and semantic cases pass.
- Model-call count is asserted: current four calls become five, never one call per slide.
- Existing image generation, batching, billing, and delivery contracts are unchanged.

### Task 8: Full verification and independent review

**Verification matrix:**

- Unit and contracts: changed test files plus `bun test`.
- API: HTTP handler and OpenAPI tests.
- Integration: runtime scheduler and mock runtime tests.
- End-to-end: existing `tests/ppt-agent.e2e.test.ts` and V4 execution/evaluation harness tests using
  mocks only.
- Boundaries: `bun run check:boundaries`.
- Static/build: `bun run typecheck` and `bun run build`.
- Aggregate gate: `bun run check`.

Provider-fee authorization applies only if a later acceptance step genuinely needs a real request.
No real Provider call is part of the default regression suite.

**Dependencies:** Checkpoints A-B.

### Task 9: Reassess open Issues

Review open Issues #8, #9, #10-#14, #23, #27, #29, and #30 against fresh code/test evidence.
Classify each as:

- fully covered and eligible to close;
- partially covered with exact remaining acceptance criteria;
- unaffected;
- superseded by a demonstrably better solution.

Do not close any Issue based only on architectural similarity or prose.

**Dependencies:** Task 8 and post-development review.

## 6. Test-first protocol

For each vertical slice:

1. Add the smallest regression test that expresses the externally observable contract.
2. Run the focused test and record the expected baseline failure.
3. Implement only enough production code to satisfy that slice.
4. Re-run the focused test and its nearest regression neighbors.
5. Proceed only when the slice is green.

Tests must use in-memory/Mock adapters. No test may call a paid Provider.

## 7. Independent review protocol

### Planning review

An agent uninvolved in this plan must inspect this document, Issue #29/#30, relevant code, tests,
and `AGENTS.md`. It reports only `BLOCKER`, `MUST_FIX`, and `SUGGESTION`, with file/line evidence,
and does not edit files. All BLOCKER/MUST_FIX findings are resolved before Task 1.

### Post-development review

An agent uninvolved in development reviews code, tests, API compatibility, accounting, idempotency,
recovery, and acceptance evidence. At most two rounds:

```text
review -> adjudicate -> unified fix -> retest
```

Round two only rechecks accepted findings from round one. It cannot expand scope.

### Residual review

Non-blocking findings remaining after two rounds are recorded, then handled centrally in at most
three focused rounds. P0, security, data corruption, irreversible, or stage-blocking findings cannot
be deferred.

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Old SQLite deliveries bypass strict parsing | High | Normalize every repository/replay read boundary and test raw legacy JSON plus override derivation. |
| Terminal failure occurs while billing is unknown | High | Canonical batch reducer blocks active/missing/unknown steps; preserve reconciliation and stable media keys. |
| A helper emits duplicate terminal events on replay | High | Make terminal transition idempotent and test repeated worker ticks. |
| Ordinary users can still reach V4 override through another call site | High | Enforce in core policy context and RunService; test HTTP action path. |
| Reflection silently rewrites correct pages | High | Hash candidate, require allowlisted finding field paths, deterministic deep diff/merge, and equality checks. |
| Reflection mutates source facts or design/source roles | High | Frozen constraints and source-role validators run after model output. |
| Reflection doubles latency | Medium | Replace final review, do two deck-level calls only, assert exact operation count. |
| Provider response is unknown and a new key is submitted | High | Stage keys bind candidate hash/rubric/protocol and replay the same durable step. |
| Semantic tests merely echo mocked answers | Medium | Assert the resulting merged brief and deterministic compiled image prompt, not only findings. |
| Unrelated dirty files are committed | High | Stage explicit paths and inspect staged diff before any commit. |

## 9. Rollback

- No database migration is planned.
- New persisted fields are additive; old Delivery rows are normalized at read boundaries without a
  destructive database rewrite.
- Reverting the eventual Issue #30 commit restores the old four-stage planner without touching
  image tasks or deliveries.
- Reverting the Issue #29 commit restores prior terminal behavior, but must only be done as an
  emergency rollback because it reintroduces the consumer dead end.
- No production release is part of this task.

## 10. Open planning questions for independent review

- Is terminal accounting derivable with sufficient certainty from the current durable Run/image
  state, or must an additional batch aggregation step be persisted before terminal failure?
- Are additive/defaulted DeliveryRecord fields enough to enforce FINAL invariants without a schema
  version bump?
- Does any V4 quality path outside page review, deck review, and revision planning still create an
  ordinary-user `NEEDS_HUMAN` state?
- Are the proposed reflection field-level mutation checks implementable without over-constraining a
  legitimate complete Deck/Visual rewrite?
