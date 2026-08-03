# V4 Slide Brief Reflection Real-Acceptance Remediation Plan

## 1. Scope

### Objective

Fix the three PPT Agent defects proven by the direct, isolated twelve-slide V4 acceptance Run
`run-aa1c560fb1e08e669dfc4eb4e27f`. The change remains on branch
`codex/v4-delivery-reflection`, based on fetched `origin/main` commit
`0d078c35bb0fbc2e1e74e8f4fe8766d7fe3b78ed`.

1. Make Slide Brief reflection return only mutable visual-field patches instead of forcing the model
   to repeat frozen teaching/content fields in a complete Slide Brief.
2. Preserve structured-model execution metrics through the runtime tracking wrapper so persisted
   stage audits truthfully report accepted HTTP responses and SSE activity.
3. Make an exhausted planning/contract-repair failure terminal and non-retryable in its public
   diagnosis and user-facing summary.

This work changes only `/srv/codex-workspace/PPT-Agent`. It does not modify FrameFlow, the text or
image gateway, Nano Banana, host billing endpoints, the public `/v1` request shape, or production.

### Fresh evidence

- The direct acceptance Run used the user-provided `11_PPT大纲.md`, GPT `gpt-5.6`, Responses
  Structured Outputs, MiniMax disabled, twelve planned pages, Nano Banana concurrency 12, and no
  FrameFlow path.
- Source Spec, Deck/Visual, Deck/Visual reflection, and Slide Brief draft all completed. The Slide
  Brief reflection then failed five times with one stable stage key. Every accepted attempt returned
  HTTP 200; no image request was submitted and committed budget remained zero.
- The Run terminated `FAILED` with FINAL accounting: authorized 36, submitted 0, settled 0,
  released 36, reconciliation 0. Recovery and terminal accounting therefore worked.
- A bounded one-request diagnostic reconstructed the exact persisted candidate without saving any
  prompt or model body. It observed 4,219 valid Responses SSE JSON events, reconstructed valid JSON,
  passed the reflection Zod result schema, and then failed deterministic application with
  `V4_REFLECTION_FROZEN_FIELD_MUTATION`.
- The same diagnostic returned `REVISED`, four findings, and five affected pages. The current result
  contract requires each affected page to repeat all frozen fields even though the prompt forbids
  changing them. This contradictory echo contract is the root cause of the deterministic failure.
- `createAgentRuntime` wraps `execute` and preflight but drops `takeExecutionMetrics`; consequently
  the real audit recorded `responseAccepted=false` and `sseEventCount=0` despite accepted streamed
  responses.
- After the fifth failure, Run recovery correctly became non-retryable, but the persisted
  `planningFailure` remained `retryable=true`, `suggestedAction=RETRY`, and the visible summary still
  said the same parameters could be retried.

### Acceptance criteria

#### A. Visual-only Slide Brief patch contract

- `revisedSlides` contains strict patch objects with exactly:
  `pageNumber`, `role`, `visualMetaphor`, `composition`, `informationHierarchy`,
  `previousSlideRelation`, and `nextSlideRelation`.
- The structured-output JSON Schema for Slide Brief reflection does not contain mutable copies of
  `title`, `keyClaim`, `audienceTakeaway`, `lockedCopy`, `facts`, `numbers`, `formulas`, or
  `sourceChunkIds` inside `revisedSlides`.
- A model response that injects any frozen field into a patch is rejected by the strict schema.
- Core code merges each accepted patch onto the persisted candidate by `pageNumber`. Every frozen
  field and every unreported page remains deep-equal to the candidate.
- Every reported page has a real change, every changed mutable leaf is covered by an applied finding,
  and every finding field path maps to a real scoped change. Out-of-range, duplicate, unreported,
  no-op, and out-of-scope patches remain rejected.
- `UNCHANGED` still returns no patches and preserves the candidate object unchanged.
- The gateway prompt explicitly instructs the model to return only affected-page visual patch fields
  and never echo frozen teaching/content fields.

#### B. Truthful execution audit

- The runtime wrapper forwards `takeExecutionMetrics` when the underlying model provides it, without
  changing behavior for models that do not.
- A runtime-level regression proves a contract/deterministic reflection failure persists safe
  request metadata, HTTP 200 acceptance, non-zero SSE event count, last activity, duration, and token
  counts while never persisting prompt, source text, raw response, credentials, or Provider body.
- The internal attempt-audit record adds bounded nullable `inputTokens`, `outputTokens`, and
  `totalTokens`. Existing persisted schema-version-1 records that lack those fields normalize them to
  `null`; no database migration or fabricated usage is allowed. A `STARTED` attempt requires all three
  fields to be `null`.
- Stable stage and attempt-audit keys, five-attempt maximum, restart recovery, and zero media budget
  behavior remain unchanged.

#### C. Exhausted failure truth

- When `terminalCode=CONTRACT_REPAIR_EXHAUSTED`, `planningFailure.retryable=false` and
  `suggestedAction=CONTACT_ADMIN` even when the underlying pre-exhaustion error was retryable.
- The terminal issue summary no longer tells the user to retry identical parameters.
- Non-exhausted transient Provider failures remain retryable; source-incomplete guidance remains
  `MODIFY_SOURCE`.

#### D. End-to-end acceptance

- Focused tests, all tests, TypeScript, core-boundary checks, diff checks, and production build pass.
- Independent code review reports no BLOCKER or MUST_FIX after at most two rounds.
- One new direct PPT Agent Run with the same outline, a new Run creation key, GPT only, and the
  existing V4 chain reaches image generation, review, delivery, and `COMPLETED` or exposes a new
  independently evidenced defect.
- Success requires a downloadable, non-empty twelve-page PPTX whose pages are exactly 1 through 12,
  with one full-slide raster image per page and coherent lifecycle/accounting evidence. HTTP 200 or
  planning completion alone is not success.

## 2. Non-goals

- Do not weaken, delete, or make optional the frozen teaching/content fields.
- Do not permit the reflection model to edit `lockedCopy`, facts, numbers, formulas, sources, titles,
  key claims, takeaways, page count, or page order.
- Do not add another reflection call, a per-slide model call, or an unbounded repair loop.
- Do not switch to MiniMax, `/chat/completions`, or Responses Function Calling for the acceptance Run.
- Do not change image concurrency, image prompts, visual review policy, revision-round limits,
  deterministic teaching diagrams, DRAFT delivery, or image-to-image revision.
- Do not modify FrameFlow, gateway services/configuration, production data, or deploy production.
- Do not stage pre-existing `README.md`, the two user-owned analysis documents, or `output/`.

## 3. Implementation design

### 3.1 Contract-level capability restriction

Introduce one strict internal `VisualDeckV4SlideBriefRevisionPatch` schema built from the mutable
subset of `VisualDeckV4SlideBrief`. Use that schema only for reflection `revisedSlides`; the normal
Slide Brief and final proposal schemas remain unchanged. This removes frozen fields from the model's
output capability instead of asking the model to copy them byte-for-byte.

### 3.2 Deterministic merge and scope enforcement

For each patch, load the candidate by `pageNumber`, merge the seven allowed fields, compute the deep
leaf diff against the candidate, and enforce the existing finding page/field allowlist. The core,
not the model, carries forward all frozen values. Duplicate pages are rejected by schema and missing,
unreported, no-op, or out-of-scope changes are rejected by deterministic validation.

### 3.3 Metrics-preserving runtime wrapper

The tracked model adapter will conditionally bind and expose the underlying model's
`takeExecutionMetrics` method, just as it already conditionally exposes preflight. Metrics remain a
one-shot internal read keyed by the full stable idempotency key; persisted output remains bounded and
redacted. Extend the strict internal attempt-audit schema with three nullable token fields defaulted
to `null` during parsing, and fill them from the consumed execution metrics for both success and
failure. This preserves reads of existing schema-version-1 records without inventing usage values.

### 3.4 Terminal diagnosis normalization

`contractFailure` will derive an `effectiveRetryable = retryable && !exhausted`. The public
`retryable` and `suggestedAction` use that effective value. Reflection deterministic validation keeps
the existing public error enum. Before the current catch block replaces errors with
`MODEL_JSON_INVALID`, an explicit reflection-contract mapper will classify the original value:

- `ZodError` keeps its bounded issue paths and uses a safe reflection schema diagnostic;
- an allowlisted `V4_REFLECTION_*` error keeps that exact string as `diagnosticCode` and maps it to
  bounded stable field paths such as `baseArtifactHash`, `reviewContextHash`, `findings`, or
  `revisedSlides`;
- unknown/internal errors are not relabelled as model JSON and continue through the existing failure
  path.

The resulting public `errorCode` remains `MODEL_JSON_INVALID` for a model-produced reflection
contract violation, so the host API enum does not change. The original prompt/body and arbitrary
exception message are never persisted.

## 4. Test-first implementation order

1. Add failing reflection contract tests proving the output schema contains only the seven allowed
   patch fields, rejects frozen-field injection, merges a valid patch, and preserves all frozen fields
   and unreported pages.
2. Add failing scope tests for duplicate, out-of-range, unreported, no-op, and uncovered patch fields.
3. Add a failing gateway request-contract test proving the emitted strict JSON Schema for
   `revisedSlides.items` excludes frozen fields and the system prompt describes patch-only output.
4. Add a failing runtime-level audit test using a model with `takeExecutionMetrics`; prove the current
   wrapper loses its accepted-response/SSE evidence before implementing the fix. The test also
   requires failure attempt records to persist bounded token counts and requires old records without
   token fields to normalize them to `null`.
5. Amend exhausted planning-failure tests to require terminal non-retryability and non-retry wording;
   confirm they fail against the current behavior.
6. Add a failing planning-runner test that drives an actual `V4_REFLECTION_*` deterministic error
   through stage exhaustion and proves `errorCode=MODEL_JSON_INVALID` while `diagnosticCode` and
   bounded field paths preserve the allowlisted cause. Add a negative control proving an arbitrary
   internal error is not persisted as a reflection/model diagnostic.
7. Implement the patch schema, deterministic merge, prompt, metrics forwarding/audit compatibility,
   reflection error mapping, and exhausted-failure normalization in that order, running the focused
   tests after each slice.
8. Run focused reflection/planning/runtime tests, then full tests, `bun run typecheck`, core-boundary
   checks, `git diff --check`, and `bun run build`.
9. Run independent review round 1. Adjudicate every finding, fix all accepted BLOCKER/MUST_FIX items in
   one batch, and rerun the same gates. Round 2 only rechecks those remediations.
10. Execute one new direct twelve-slide paid acceptance Run only after the code review gate passes.

## 5. Expected files

- `src/visual-deck-v4-contracts.ts`
- `src/core/visual-deck-v4-reflection.ts`
- `src/adapters/gateway-courseware-model.ts`
- `src/core/planning-runner.ts`
- `src/runtime/mock-runtime.ts`
- `tests/visual-deck-v4-reflection.test.ts`
- `tests/gateway-courseware-model.test.ts`
- `tests/visual-deck-v4-planning-runner.test.ts`
- `tests/mock-runtime.test.ts` or the nearest runtime integration test
- `tests/planning-runner.test.ts`
- `docs/decisions/ADR-006-visual-deck-v4-selective-reflection.md`

No public OpenAPI or host-integration document change is expected because the host request/response
contract does not change.

## 6. Risks and rollback

- **Persisted intermediate compatibility:** this reflection chain exists only in the current
  uncommitted V4.1 branch and has not been deployed; there is no production record requiring the old
  full-Slide-Brief reflection output. The isolated failed Run is disposable evidence. If review finds
  contrary deployment evidence, compatibility becomes a BLOCKER before implementation.
- **Patch/schema drift:** derive or explicitly test the mutable subset against the finding field-path
  enum so adding a future mutable field cannot silently create an ungoverned capability.
- **False success:** a schema-valid patch can still be visually poor. Existing deterministic proposal
  validation, image review, deck review, and bounded revision remain mandatory.
- **Metrics leakage:** only allowlisted scalar metadata is forwarded; no raw text/body is added.
- **Audit compatibility:** token fields use parse-time `null` defaults so existing version-1 audit
  Steps remain readable. The schema version does not change because the persisted shape is additive
  and normalized at the read boundary.
- **Rollback:** revert only the expected file set above. No database migration, public endpoint
  removal, FrameFlow change, or production rollback is involved.
