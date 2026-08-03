# Implementation Plan: V4 GPT Local Image Revision

## 1. Scope

### Objective

Close GitHub Issue #27 on top of local commit `f81b6df` by replacing the normal
`VISUAL_DECK_V4` paid revision path from text-to-image regeneration with an edit of the latest
controlled page artifact.

The product policy is fixed:

```text
initial page generation -> the Run image model (production default: Nano Banana)
automatic page revision -> configured GPT image edit model (production target: image-2)
```

Both operations consume the same integer image budget unit. For a ten-page test Run with two
configured revision rounds, the host continues to authorize at most thirty image units. FrameFlow
currently maps both supported image models to the same ten-credit price. PPT Agent must not encode,
calculate, display, or change that user-credit price.

This work is limited to `/srv/codex-workspace/PPT-Agent`. It does not modify FrameFlow, the model
gateway, production configuration, or production data, and it does not deploy or push.

### Acceptance criteria

- Initial V4 page generation remains unchanged and does not receive a previous page image.
- Every normal automatic V4 revision resolves the latest completed controlled artifact for its
  target page and submits that exact artifact through `referenceImage` to the image edit route.
- The revision request uses the server-configured GPT edit model, never the Run's initial Nano
  Banana model.
- A persisted strict repair contract records page, approved Issue IDs, required changes, preservation
  constraints, exact teaching constraints, forbidden changes, source artifact identity, source SHA,
  edit model, and repair mode without storing image bytes or raw Provider responses.
- The Provider idempotency key is stable and bound to Run, page, revision round, repair-contract hash,
  source artifact SHA, and edit model. Replay or process recovery never changes that key.
- A response with unknown submission state never switches models and never falls back to full-page
  text-to-image generation.
- The revision batch reserves and reports the GPT edit model while preserving one batch authorization,
  concurrent page submission, atomic settlement, and page-level accounting allocation.
- Missing, cross-tenant, corrupt, unsupported-MIME, hash-mismatched, or non-16:9 source artifacts fail
  before budget reservation and before any Provider submission.
- Completed edited pages re-enter the existing page review and deck review pipeline before delivery.
- Existing V2/V2.1/V3 behavior and V4 chain-1 persisted image keys remain readable.
- All new behavior is test-first and the final repository quality gate passes.

## 2. Non-goals

- Do not modify FrameFlow pricing, the ten-credit image rate, the 300-credit ten-page test ceiling,
  parent authorization, public wallet UI, or the host credit API.
- Do not add Hybrid/editable PPTX rendering.
- Do not implement deterministic teaching diagrams from Issue #9.
- Do not add masks, bounding-box detection, or a second visual localization model in this slice.
  "Local edit" means image-to-image edit of the previous full page with a strictly scoped repair
  contract; mask support can be added after Provider capability evidence exists.
- Do not let the planning model choose raw Provider/model identifiers.
- Do not silently fall back to Nano Banana or text-to-image when GPT editing is unavailable.
- Do not add another user approval or budget-confirmation state.
- Do not treat a Provider's aesthetic quality variance as a code-completion blocker. The product
  acceptance gate proves the correct artifact, model, route, recovery, review, and accounting flow.
- Do not stage the existing `README.md`, user analysis documents, or `output/` artifacts.

## 3. Architecture decisions

### 3.1 Server-owned model routing

Add one gateway runtime setting for the V4 revision image model. Gateway mode requires a non-empty
configured value; the deployment example uses `image-2`. Initial generation continues to use
`RunRecord.imageModel`.

The model identifier is resolved by the backend before budget reservation and persisted with the
repair contract and media Step. The revision-planning model cannot alter it.

The revision GenerationBatch also persists `accountingModel = image-2` and
`operationMode = IMAGE_EDIT` before host authorization. These are internal storage fields: the
existing public Run, event, and GenerationBatch projections remain unchanged. New batch identity,
input hash, reservation, recovery, finalization, and administrator reconciliation use the persisted
model and mode. They never derive a new revision model from current configuration or
`RunRecord.imageModel`. Legacy batches and media Steps remain readable, but a key carrying the new
edit identity fails closed if either persisted field is absent.

### 3.2 Deterministic repair contract

Create a strict internal `V4RepairContract` from the approved Revision Plan, active V4 Proposal, and
latest controlled page artifact. No additional text-model request is introduced.

The contract contains:

```text
schemaVersion
runId / pageNumber / revisionRound
mode = IMAGE_EDIT
issueIds
requiredChanges
preserve
exactConstraints
forbiddenChanges
sourceArtifactId / sourceArtifactSha256 / sourceMimeType / sourceWidth / sourceHeight
editModel
```

The core owns the contract identity and hash. `requiredChanges` comes from approved revision
operations. Frozen allowed copy, non-target page composition, global visual continuity, facts,
numbers, and formulas form the preservation and exact-constraint sections.

### 3.3 Controlled source artifact resolution

For each target page, select the newest completed page image from a revision strictly before the
current revision round. Load it through `ArtifactPort` under the Run tenant, verify its SHA against
its bytes, verify a supported raster MIME, decode dimensions, and require the page aspect ratio to
be 16:9 within a one-pixel rounding tolerance.

Only opaque artifact identity and metadata are persisted. Bytes are loaded just in time and passed
to `MediaStepRunner`; they are never stored in an event or Step payload.

### 3.4 Stable media identity and compatibility

The V4 edit key has exactly this syntax:

```text
<runId>:slide:<pageNumber>:image:r<revisionRound>:v1:edit:<repairIdentity>
```

`repairIdentity` is the first 24 lowercase hexadecimal characters of SHA-256 over the canonical
strict `V4RepairContract`. The full contract hash is persisted. Because the contract includes the
Run, page, round, source artifact SHA, edit model and repair mode, the Provider key is bound to all
of them without exposing raw content. The version ID remains
`<runId>:slide:<pageNumber>:r<revisionRound>:v1`.

Extend completed-asset lookup and round parsing to recognize both the legacy
`<prefix>:rN:v1` key and the new `<prefix>:rN:v1:edit:<24hex>` form. Compatibility tests cover old
chain-1 keys, new edit keys, page-review keys derived from both forms, deck review, delivery,
technical recovery, and selection of the latest controlled artifact. The media Step's input hash
independently includes the full source SHA, full contract hash, persisted operation mode and model.

Persist enough Step metadata to reconstruct the real model and edit identity during polling,
settlement, and recovery. Do not reconstruct a GPT edit as the Run's Nano Banana model.

### 3.5 No implicit fallback

All automatic V4 revisions use `IMAGE_EDIT`. Existing full regeneration remains a legacy/explicit
compatibility behavior only; it is not selected when edit submission fails. A definite pre-submit
failure may enter the existing bounded technical recovery and retry the same edit with the same
Provider key. Unknown submission remains unresolved under the original key.

`SUBMITTING` and `SUBMISSION_UNKNOWN` are reconciliation states, never submission states. Before
any further POST, `MediaStepRunner` must query the gateway by the original idempotency key and the
persisted `IMAGE_EDIT` operation mode. The gateway adapter uses the existing unified
`/image-tasks/by-idempotency` lookup contract with the operation mode carried explicitly. Only an
authoritative `NOT_SUBMITTED` result may enter bounded recovery and later repeat the same
`/images/edits` POST with the same model, source SHA, contract and key. `SUBMITTED` resumes polling;
`UNKNOWN`, a missing lookup capability, a transport failure, or an unrecognized response stays
unresolved and cannot POST again.

### 3.6 Accounting remains one unit per image operation

The revision coordinator persists the GPT edit model and operation mode in the batch before calling
`reserveGenerationBatch`; reservation reads those persisted values and every page media Step uses
the same values. The caller-provided `unitBudgetUnits` remains unchanged, so initial Nano generation
and GPT edit each consume one Agent image unit. The host owns the conversion from that unit to the
currently configured ten credits. Tests model a ten-page initial Nano batch plus two complete GPT
edit rounds and assert a maximum of 30 image units (the host's current 300-credit ceiling), with no
duplicate reservation or settlement.

## 4. Test-first implementation order

### Slice 1: Contract and artifact identity

Write failing tests for a strict repair contract, deterministic hash, allowed-copy preservation,
exact teaching constraints, and legacy/new revision-key lookup. Implement only the contract compiler
and lookup compatibility, then run the focused tests.

### Slice 2: Controlled reference resolution

Write failing coordinator tests proving the selected source is the latest prior controlled page and
that missing, cross-tenant, corrupt, hash-mismatched, unsupported, and wrong-aspect artifacts stop
before budget/Provider work. Add `ArtifactPort` to the coordinator and implement resolution.

### Slice 3: GPT edit submission and batch accounting

Write failing tests proving:

- revision requests contain the exact prior artifact bytes and SHA;
- the model is the configured GPT edit model;
- the gateway uses multipart `/images/edits`;
- the revision batch reservation uses the same GPT model;
- multiple problem pages remain concurrently submitted under one revision batch.

Implement target compilation, model routing, media metadata, and runtime wiring.

### Slice 4: Idempotent recovery

Write failing tests for completed replay, restart from persisted submission, definite-not-submitted
recovery, unknown submission, changed source SHA, changed repair contract, and changed model. Prove
that recovery uses the original key, never creates a new Run or model route, and never duplicates a
budget reservation or Provider submission. Simulate an edit accepted by the gateway whose POST
response is lost; after restart the edit-aware lookup returns `SUBMITTED`, and the total
`/images/edits` POST count must remain exactly one. A lookup result of `UNKNOWN` must also leave the
POST count at one.

Add accounting recovery tests covering an initial Nano batch followed by two GPT edit batches,
configuration drift after submission, and administrator reconciliation. Every new edit path must
read `accountingModel` and `operationMode` from persisted Step/batch state; using current config or
the Run's Nano model is a test failure.

### Slice 5: Review and end-to-end product path

Add an integration test that starts with Nano-generated V4 pages, rejects selected pages, edits only
those pages through GPT with prior artifacts, re-runs page/deck review, and produces a valid raster
PPTX. Assert operation counts and terminal accounting without requiring a particular aesthetic score
from a real Provider.

### Slice 6: Documentation and release identity

Document the additive PPT Agent configuration and edit/recovery contract. Update the release identity
consistently only after the public/internal compatibility review determines the correct semantic
version.

## 5. Verification gates

After each slice, run its focused tests. Before review, run:

```text
bun run check
git diff --check
```

Then perform at most two independent review rounds:

```text
review -> adjudicate -> batch remediation -> focused/full verification
```

Reviewers report only `BLOCKER`, `MUST_FIX`, and `SUGGESTION` findings with evidence and do not edit
files. Round two only rechecks accepted round-one remediations.

## 6. Risks and rollback

- **Gateway edit idempotency:** the gateway must honor the supplied edit Idempotency-Key and resolve
  it through the unified idempotency lookup when `operationMode=IMAGE_EDIT`. If that capability is
  absent or submission remains unknown, fail safe under the original key rather than resubmitting
  or changing models.
- **Artifact-key compatibility:** delivery selects the latest completed page through shared lookup;
  both old and new key formats require regression coverage.
- **Model-aware host authorization:** the current legacy batch-credit contract accepts a GPT revision
  child under the Run authorization and prices both image models equally. Any future host usage
  contract that restricts child model identity must explicitly support the configured edit model;
  PPT Agent will document the requirement but will not modify FrameFlow here.
- **Rollback:** revert the #27 commits. No database migration, FrameFlow change, Provider change, or
  production rollback is required.
