# V4 Reflection Contract Skip and Bounded Repair Plan

## 1. Scope

### Objective

Fix the product-chain failure reproduced by isolated direct Run
`run-f9044d35b9be38e80fef9371c651`. The validated Slide Brief candidate was already persisted, but the optional
`reflect-slide-briefs` stage returned five accepted HTTP 200 responses that violated its contract. Generic planning
recovery then blocked image generation.

Both V4 reflection stages are optional, bounded quality enhancements. They may execute the text Provider at most twice
per logical stage across process restarts. A contract-invalid first response permits one contract-repair request. When
the final allowed execution is contract-invalid, preserve the validated candidate, atomically persist
`REFLECTION_SKIPPED / CONTRACT_INVALID`, and continue the same Run. Never fabricate `APPROVED`, a successful rubric,
or a model-authored `UNCHANGED` decision.

This work modifies only `/srv/codex-workspace/PPT-Agent`. It does not modify FrameFlow, the gateway service, Nano
Banana, public `/v1` request/response contracts, quality thresholds, revision limits, host billing contracts, or
production.

### Acceptance criteria

#### A. Stable identities and a hard two-execution ceiling

- A reflection has one stable logical `stageKey` for persistence, audit, candidate binding and restart recovery.
- Provider execution 1 uses the canonical stage request key. The only semantic contract-repair execution uses the
  deterministic key `${stageKey}:repair:1`. These are fixed identities, not randomly generated retry keys.
- Replaying a timeout, unknown submission, process exit or restart for one execution always reuses that execution's
  exact Provider key and request hash. It never advances to a new repair key merely because time elapsed.
- Contract repair may add only a sanitized `previousFailureLayer` marker to the repair request. No raw output,
  validation message, prompt, source text or Provider error is copied into repair metadata.
- A model execution already accepted under a Provider key is never resubmitted under a replacement key. Tests use a
  Provider that caches by idempotency key so accidental same-key pseudo-repair cannot pass.
- `reflect-deck-visual` and `reflect-slide-briefs` each permit at most two Provider executions in total. Other V4
  planning stages keep their existing retry policies.

#### B. Exact outcome matrix

`C` means a classified contract failure, `T` means a Provider/transport technical failure, and `S` means a valid
reflection result.

| Execution 1 | Execution 2 | Required outcome |
|---|---|---|
| `S` | none | Apply backend patch merge and complete reflection |
| `C` | `S` | Apply the unique repair result and complete reflection |
| `C` | `C` | Atomically record the second failure and `REFLECTION_SKIPPED / CONTRACT_INVALID`; continue unchanged |
| retryable `T` | `S` | One technical recovery replays the same execution key; complete reflection |
| retryable `T` | `C` | No contract-repair slot remains; atomically skip as `CONTRACT_INVALID`; continue unchanged |
| `C` | `T` | Preserve the actual technical code, terminate reflection recovery, do not skip, and fail the Run through existing V4 terminal accounting |
| retryable `T` | `T` | Preserve the final technical code, terminate reflection recovery, do not skip, and fail the Run through existing V4 terminal accounting |
| non-retryable `T` | none | Preserve configuration/auth/model failure and fail immediately; no second call |

The terminal technical cases persist a sanitized `V4_REFLECTION_TECHNICAL_RECOVERY_EXHAUSTED` diagnostic while
retaining the real Provider error code. They do not enter the generic five-round recovery loop and cannot execute a
third Provider call.

#### C. Patch-only Provider output

GPT returns only problem-page scope, one allowed field, and one local replacement value. It never returns candidate or
context hashes, full artifacts, frozen content, rubric checks, findings prose, applied-finding identifiers, compiler
metadata, audit metadata or fixed timestamps.

Deck/Visual output is:

```ts
{ patches: DeckVisualPatch[] }
```

Each `DeckVisualPatch` is a strict discriminated union with exactly:

```ts
{ affectedPageNumbers: number[]; field: '<allowlisted path>'; value: <exact field type> }
```

Allowed fields and whole-field replacement types are:

- `deckPlan.title`: string; `affectedPageNumbers` must be exactly `[1]`.
- `deckPlan.narrativeArc`: the complete validated string array; scope must be every page.
- `deckPlan.chapters`: the complete validated chapter array; scope must equal the sorted union of pages owned by
  chapters that differ before and after replacement.
- `visualContract.artDirection`, `typography`, `medium`: string; scope must be every page.
- `visualContract.palette`: the complete validated color array; scope must be every page.
- `visualContract.visualDensity`: the exact enum value; scope must be every page.
- `visualContract.compositionRules`, `continuityRules`, `forbidden`: the complete validated string array; scope must
  be every page.

Slide Brief output is:

```ts
{ patches: SlideBriefPatch[] }
```

Each `SlideBriefPatch` is a strict discriminated union with exactly:

```ts
{ pageNumber: number; field: '<allowlisted field>'; value: <exact field type> }
```

Allowed fields are `role`, `visualMetaphor`, `composition`, `informationHierarchy`, `previousSlideRelation` and
`nextSlideRelation`, using the exact corresponding Slide Brief field type. `title`, `keyClaim`, `audienceTakeaway`,
`lockedCopy`, `facts`, `numbers`, `formulas`, `sourceChunkIds` and page identity never appear in Provider output.

Backend semantics are deterministic:

- a Deck/Visual field may appear at most once;
- a Slide field may appear at most once per page;
- array values replace the complete field, never merge by element;
- Deck patches apply in the declared allowlist order; Slide patches apply by page number then allowlist order;
- out-of-range scope, duplicate ownership, wrong derived page scope and no-op values are rejected semantically;
- empty `patches` is valid and backend-derived as unchanged;
- hashes, frozen fields, candidate clone/merge, full-stage Zod validation, full Proposal validation, derived decision,
  rubric identity, compiler metadata and audit metadata are exclusively backend-owned.

#### D. Sanitized contract-failure layers

- `JSON_PARSE`: the transport returned output/SSE text that cannot be parsed as JSON.
- `JSON_SCHEMA`: parsed JSON violates the strict Provider patch shape, including missing, unknown/frozen fields or
  wrong value types.
- `ZOD_SEMANTIC`: the transport patch shape passed, but backend page scope, duplicate ownership, no-op, candidate
  merge, frozen-value invariant or full Proposal invariant failed.
- The Gateway assigns only `JSON_PARSE` or `JSON_SCHEMA` on `StructuredModelError`. Planning assigns
  `ZOD_SEMANTIC` only after transport-schema success; one error cannot belong to two layers.
- The layer is stored in the bounded stage-attempt audit and final skip disposition. Raw response bodies, prompts,
  source text, raw Zod messages, credentials and arbitrary exception messages are never persisted or logged.
- Existing top-level safe error codes stay compatible; this is an internal diagnostic dimension.

#### E. Atomic skip and crash recovery

- A skip disposition contains only: schema version, stage, `REFLECTION_SKIPPED`, `CONTRACT_INVALID`, failure layer,
  attempt count, backend candidate hash, rubric version and timestamp.
- On the final allowed contract failure, the Provider Step failure, final attempt audit and completed skip disposition
  are written in one repository transaction.
- A restart that finds the disposition verifies the candidate hash and makes no Provider call.
- A compatibility recovery path that finds two persisted contract failures but no disposition atomically backfills
  only the disposition; it never starts a third execution.
- Planning progress explicitly says the reflection was skipped. The validated candidate then compiles normally and
  the same Run enters image generation, page review and deck review. Skip never lowers thresholds or approves review.

#### F. Regression proof

- Contract tests prove the two patch-only schemas and confirm hashes, full artifacts, frozen fields and fixed metadata
  are rejected as `JSON_SCHEMA`.
- Gateway tests distinguish `JSON_PARSE` and `JSON_SCHEMA`; core tests distinguish `ZOD_SEMANTIC` without retaining
  raw messages.
- A caching-Provider test proves `C -> S` uses exactly the canonical and deterministic repair keys; a restart reuses
  the same key assigned to the current execution.
- Tests cover every row in the outcome matrix, including non-retryable technical failure and accepted-but-timed-out
  replay. No path can create a third audit attempt or Provider call.
- A transaction-fault test covers the final failure boundary, and a compatibility test covers two failures with a
  missing disposition.
- Runtime integration reproduces a valid Slide Brief candidate followed by final contract-invalid reflection,
  verifies one Run ID and unchanged planning attempt, then reaches concurrent image submission, one generation batch,
  one batch reservation, unique stable page keys, page review and deck review. It asserts no duplicate reservation,
  settlement or media submission.

## 2. Non-goals

- Do not relax page review, deck review, source grounding, frozen teaching fields or final delivery identity.
- Do not fabricate reflection approval or treat a failed reflection as a model-authored `UNCHANGED` result.
- Do not add a third reflection execution, MiniMax fallback, Chat Completions fallback or another Run.
- Do not change initial planning contracts, image prompts, image concurrency, host billing APIs or FrameFlow.
- Do not run another paid Provider acceptance. Mock, contract and integration tests are the acceptance evidence.
- Do not deploy, push, merge or modify production in this phase.

## 3. Implementation design

### 3.1 Transport and semantic contracts

Replace both reflection Provider result schemas with the strict patch-only discriminated unions above. Keep transport
shape validation in the Gateway. Apply deterministic scope, ownership, no-op, merge and complete-candidate checks in
`visual-deck-v4-reflection.ts`, after which Planning constructs the backend-owned persisted reflection output.

The Provider still receives the candidate and trusted governance context as review input. Backend-only hashes,
rubric/audit identity and fixed metadata are not requested in Provider output.

### 3.2 Reflection-specific execution coordinator

Add a reflection-specific coordinator around the existing single-stage execution primitive. It loads the stable audit
and disposition before selecting execution 1 or execution 2, chooses the deterministic request key, and never allows
the generic maximum of five. Contract execution 2 receives only the sanitized previous failure layer.

Technical recovery re-enters the coordinator with the same logical stage identity. It replays the same Provider key
for the interrupted technical execution. Once the audit contains two executions, the coordinator either returns the
atomic skip or emits the terminal technical diagnostic without another Provider call.

### 3.3 Failure-layer propagation

Extend `StructuredModelError` and structured metrics with an optional contract-failure layer. Add nullable
`contractFailureLayer` to persisted attempt audits with backward defaults. Gateway JSON parsing assigns `JSON_PARSE`;
strict output parsing assigns `JSON_SCHEMA`; reflection application and Proposal validation assign `ZOD_SEMANTIC`.

### 3.4 Atomic disposition

Use one repository transaction to finish the final failed attempt and create the zero-budget disposition Step. The
Step is keyed by Run, logical reflection stage, planning attempt and candidate hash. Failed Provider Steps remain
truthfully `FAILED`; the disposition records the backend degradation decision. Replay verifies the hash before using
the candidate.

## 4. Test-first development order

1. Add failing Gateway and contract tests for patch-only output plus `JSON_PARSE / JSON_SCHEMA`.
2. Add failing core tests for deterministic patch merge, exact scope, duplicates, no-op and `ZOD_SEMANTIC`.
3. Add failing planning tests for `C -> S`, `C -> C`, all technical combinations, stable execution keys, atomic skip
   and restart/backfill without a third call.
4. Add a failing runtime integration test for skip -> compile -> concurrent generation -> page/deck review with one
   Run and one batch accounting lifecycle.
5. Implement schemas and deterministic backend merge.
6. Implement failure-layer propagation, the two-execution coordinator and atomic disposition.
7. Run focused tests after each slice, then all local gates and independent review. Review round two only rechecks
   accepted findings from round one.

## 5. Expected files

- `src/visual-deck-v4-contracts.ts`
- `src/core/visual-deck-v4-reflection.ts`
- `src/core/planning-runner.ts`
- `src/core/ports.ts`
- `src/adapters/gateway-courseware-model.ts`
- `tests/visual-deck-v4-reflection.test.ts`
- `tests/visual-deck-v4-planning-runner.test.ts`
- `tests/gateway-courseware-model.test.ts`
- `tests/mock-runtime.test.ts`
- `docs/decisions/ADR-006-visual-deck-v4-selective-reflection.md`

Public OpenAPI and FrameFlow files are not expected to change.

## 6. Risks and rollback

- **Idempotency:** stable stage identity and deterministic execution keys prevent random-key retries; a caching Mock
  Provider prevents false-positive tests.
- **Crash window:** final failure, audit and skip disposition share one transaction; compatibility backfill handles
  pre-fix partial state without a Provider call.
- **Silent quality loss:** skip is explicit and does not bypass page/deck review.
- **Patch ambiguity:** strict discriminated unions, exact page mapping, whole-field replacement and deterministic
  ordering remove merge ambiguity.
- **Terminal technical failure:** the second technical failure preserves its real code, closes recovery and uses V4
  terminal accounting instead of starting a third execution.
- **Rollback:** revert only the expected files. No host, billing, public API, database or production rollback is needed.
