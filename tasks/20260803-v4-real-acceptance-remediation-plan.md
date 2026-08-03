# V4 Real Acceptance Remediation Plan

## Scope

### Objective

Remediate the PPT Agent defects proven by the direct twelve-slide V4 acceptance Run
`run-40e6ee...c843`. The Run used GPT `gpt-5.6`, disabled MiniMax fallback, never reached the image
provider, and committed zero budget units.

This change is limited to `/srv/codex-workspace/PPT-Agent`. It does not modify FrameFlow, change the
Nano Banana contract, deploy production, or start another paid Run before all local gates and the
focused independent review pass.

### Acceptance criteria

1. An HTTP 401, 403, or 404 with the same explicit upstream numeric code is classified as
   `MODEL_AUTH_FAILED`, `MODEL_FORBIDDEN`, or `MODEL_NOT_FOUND` and is non-retryable. A wrapper that
   only reports `bad_response_status_code` remains a retryable upstream transport failure. String
   and JSON-number codes are normalized; a missing upstream numeric code remains retryable, while an
   explicit code that conflicts with the HTTP status is non-retryable `PROVIDER_UNAVAILABLE`.
2. One V4 planning stage has one shared retry budget of at most five Provider submissions across
   persisted technical recovery. It cannot execute five inner attempts in each of five recovery
   rounds. Every submission reuses the same stable stage idempotency key. The authoritative count is
   stored in a separate internal audit Step keyed from that stage key, not inferred only from the
   Run-level `resumeState`. When stage A recovers successfully, its completed Run-level recovery is
   cleared before stage B starts; stage B therefore starts at attempt 1 with its own audit Step.
3. V4 reflection Structured Outputs use a strict root object schema. `decision` still controls the
   executable `UNCHANGED` and `REVISED` invariants through Zod refinement and deterministic core
   validation; the transport schema does not expose a root `oneOf`.
4. Structured-generation preflight exercises a representative strict nested object/enum/array
   contract. Tests additionally assert that the real reflection request schema is a root object.
5. A recoverable planning or source-resolution interruption leaves the original `planning.started` lifecycle open. It
   does not publish `planning.completed` and then emit more planning progress. Eventual success or
   terminal failure closes that lifecycle exactly once. Recovery success, recovery exhaustion, and
   immediate non-retryable configuration failure are covered for both entry paths.
6. Every V4 Provider-backed planning stage owns a zero-budget internal audit Step whose strict output
   contains at most five attempt records. Each record contains attempt number, outcome, duration,
   safe request/response ID, normalized error/status, response-accepted flag, SSE activity count and
   last-activity time; the envelope contains cumulative duration and a SHA-256 of the stage key. The
   audit Step retains failed attempts after eventual stage success and is the persisted stage retry
   counter across process restarts. `StepRecord.idempotencyKey` remains the complete authoritative key
   required for recovery; logs and audit payloads must not repeat that full key. No prompt, source
   text, credential, raw response body, or Provider error body is persisted or logged.
7. A non-retryable planning configuration failure with no media submission ends as
   `FAILED + terminalAccounting.accountingStatus=FINAL`, with zero submitted/settled units and no
   `NEEDS_HUMAN` or user approval event.

## Finding adjudication

- **Accepted BLOCKER:** explicit `403 + providerCode=403 + providerType=upstream_error` is currently
  misclassified as retryable.
- **Accepted BLOCKER:** independent five-attempt planning retry and five-attempt technical recovery
  multiply to 25 submissions.
- **Accepted MUST_FIX:** the micro preflight does not cover the root shape first used by reflection;
  reflection transport schemas will be root objects and the request contract will be tested.
- **Accepted MUST_FIX:** `planning.completed` is currently emitted before technical recovery resumes.
- **Accepted MUST_FIX:** failure metrics are discarded and rejection logs lack safe stage correlation;
  a bounded internal attempt-audit Step will retain evidence without replacing the authoritative Step key.
- **Accepted planning-review BLOCKER:** Run-level recovery attempts are scoped only to `PLANNING`;
  stage-specific audit Steps and success-time recovery clearing will isolate source, preflight,
  Deck/Visual reflection and Slide Brief reflection budgets.
- **Accepted planning-review MUST_FIX:** classification tests cover exact, missing, mismatched, string,
  JSON-number and `bad_response_status_code` metadata.
- **Accepted planning-review MUST_FIX:** both normal planning failure and source-resolution failure
  must preserve a single lifecycle pair through recovery.
- **Deferred SUGGESTION:** make the 180-second idle timeout separately configurable from a total stage
  deadline. The user explicitly selected a 180-second activity timeout; changing that policy requires
  a separate contract decision.
- **Test-fixture correction:** the next single-source grounded acceptance request will mark the
  authoritative outline as `CONTENT_SOURCE`; no source-role inference behavior is changed here.

## Implementation order

1. Add failing table-driven gateway tests for exact/missing/mismatched string and numeric wrapped
   401/403/404 codes, wrapper-only retryability, real reflection root-object schema, representative
   preflight schema, and failure metrics.
2. Add failing planning tests proving no inner retry multiplication, exactly five total persisted
   attempts, stable keys, the bounded internal audit Step, and cumulative safe failure evidence.
   Recreate the runner between attempts to prove restart persistence. In one test, stage A fails then
   succeeds and stage B starts at attempt 1; stage B then terminates on its fifth failure.
3. Add failing lifecycle tests for both Provider-backed planning and source resolution: recover then
   succeed, exhaust recovery, and fail immediately with a non-retryable configuration error. Every
   path must have one `planning.started` and one eventual `planning.completed`.
4. Refactor reflection result schemas to strict root objects with conditional invariants.
5. Fix Provider rejection classification and capture safe success/failure request metrics.
6. Make V4 use one Provider call per persisted stage recovery attempt while preserving legacy retry
   behavior. Persist the attempt audit transactionally and clear only the successfully recovered
   stage's inactive Run-level recovery before proceeding to the next stage.
7. Correct lifecycle emission for both planning-stage and source-resolution recovery.
8. Run focused tests, all adjacent accounting/lifecycle tests, full tests, boundaries, typecheck, and
   build.
9. Run a focused independent code review. Fix BLOCKER/MUST_FIX findings, rerun the same gates, then
   execute one new isolated paid twelve-slide acceptance Run with a new input hash and one stable key.

## Expected files

- `src/adapters/gateway-courseware-model.ts`
- `src/core/planning-runner.ts`
- `src/core/ports.ts`
- `src/core/technical-recovery.ts` only if a small helper is required to clear a successfully completed
  planning recovery; do not change recovery limits for other phases
- `src/visual-deck-v4-contracts.ts`
- `tests/gateway-courseware-model.test.ts`
- `tests/visual-deck-v4-contracts.test.ts`
- `tests/visual-deck-v4-planning-runner.test.ts`
- related lifecycle/technical-recovery tests only when required by the failing regression

## Risks and rollback

- Tightening wrapped 401/403/404 classification may stop retries for a gateway that incorrectly uses
  those explicit codes for transient failures. The test keeps wrapper-only transport failures
  retryable and uses the explicit inner numeric code as the boundary.
- Root-object reflection schemas must preserve every current conditional invariant. Existing semantic
  reflection and page-6/page-12 regressions remain mandatory.
- Removing inner V4 retries changes event counts and latency but not public endpoint shapes, Run status
  names, stage keys, or Provider protocol.
- The audit Step is internal, zero-budget, bounded to five records, and ignored by media accounting.
  Its identity is derived from the authoritative stage key so it cannot merge two stages.
- Rollback is the exact file set above; no database migration or public-contract removal is involved.

## Non-goals

- Do not modify FrameFlow, gateway services, Nano Banana, image concurrency, billing interfaces, or
  production configuration.
- Do not implement deterministic teaching diagrams, image-edit revision, DRAFT delivery, or Hybrid
  PPTX editing.
- Do not increase the idle timeout merely to force this one acceptance case through.
- Do not use MiniMax or switch to `/chat/completions`.
