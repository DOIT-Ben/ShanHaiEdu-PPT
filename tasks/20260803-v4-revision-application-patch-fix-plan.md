# V4 Revision Application Patch Remediation Plan

## 1. Scope

### Objective

Fix the direct twelve-slide V4 acceptance failure proven by Run
`run-f78cb2723595007a94dbd9abacfd`. The Run completed five-stage planning, generated all twelve
Nano Banana pages concurrently, settled one initial batch, completed three page-local redraws, and
then failed while applying the fourth-round deck revision with:

- step error: `REVISION_APPLICATION_FAILED`;
- diagnostic: `REVISION_SCOPE_VIOLATION`;
- two exhausted contract attempts;
- no fourth-round media submission;
- terminal accounting `FINAL` with 36 authorized, 15 submitted/settled, and 21 released units.

The root cause is the V4 revision application output capability. The current gateway contract asks
the model to echo a complete `VisualDeckV4ProposalDraft` while deterministic validation requires all
global fields and every unplanned slide to remain byte-for-byte identical. The real revision plan
targeted eight pages with nine mixed operations, but the complete-echo contract allowed incidental
changes outside those operation scopes. Prompt instructions and a second full-output repair attempt
did not remove that capability.

For the current V4.1 compiler (`visual-deck-v4-chain-2`), replace the complete proposal echo with a
strict page-patch result. Core code, not the model, carries all frozen/global/unplanned values forward.
Keep legacy `visual-deck-v4-chain-1` revision application on its existing full-draft contract so
already persisted runs remain recoverable under their original Provider schema and idempotency keys.

This work changes only `/srv/codex-workspace/PPT-Agent`. It does not modify FrameFlow, the gateway,
Nano Banana, host billing, public `/v1` request/response shapes, quality thresholds, revision limits,
or production.

### Acceptance criteria

#### A. Strict chain-2 patch contract

- The internal structured result has exactly three arrays: `contentPatches`, `layoutPatches`, and
  `redrawOnlyPageNumbers`.
- A content patch contains exactly `pageNumber` plus the editable content, source-lineage, and
  directly related visual fields of one Slide Brief. It cannot echo `role`, global planning fields,
  compiler identity, or another complete Slide Brief/Proposal.
- A layout patch contains exactly `pageNumber`, `visualMetaphor`, `composition`,
  `informationHierarchy`, `previousSlideRelation`, and `nextSlideRelation`.
- The JSON Schema sent for chain-2 revision application excludes `sourceUnderstanding`,
  `presentationSpec`, `deckPlan`, `visualContract`, `slideBriefs`, `compilerVersion`, and frozen role.
- Chain-1 continues to use `VisualDeckV4ProposalDraft` and the existing schema identity.

#### B. Deterministic scope and merge

- Every page with an `UPDATE_CONTENT` operation has exactly one content patch or appears exactly once
  in `redrawOnlyPageNumbers` when the persisted Slide Brief already expresses the correction and the
  approved operation instruction only needs to drive a new image.
- Every page with `RELAYOUT` but no `UPDATE_CONTENT` has exactly one layout patch or appears exactly
  once in `redrawOnlyPageNumbers` under the same rule.
- A page targeted only by `REGENERATE_IMAGE` has no model patch and inherits its Slide Brief exactly.
- Mixed operations on one page use one content patch when content is present; otherwise one layout
  patch when layout is present. Asset regeneration remains owned by the persisted revision plan.
- Duplicate, unplanned, missing, wrong-kind, out-of-range, and no-op patches are rejected before any
  media submission. A legitimate unchanged plan is expressed through `redrawOnlyPageNumbers`, not a
  fabricated field edit or a repeated no-op patch.
- The core merges accepted patches by `pageNumber`; global fields, role, non-target pages, and fields
  outside the operation kind remain deep-equal to the base proposal.
- Existing source-lineage preservation, required operation sources, visible number/formula,
  slide-count/order, and Proposal/Blueprint validation remain mandatory.

#### C. Recovery and compatibility

- Contract repair receives bounded patch-contract issues and uses the existing second contract key;
  Provider-transient retries keep their existing stable key and attempt limits.
- No successful or unknown Provider request is resubmitted under a different key.
- Unsupported compiler versions still fail before model execution.
- Legacy V2/V3 and V4 chain-1 behavior and tests remain unchanged. Chain-1 compatibility is proven at
  both the Gateway request layer and the Runner parse/compile/persist/replay layer.

#### D. Verification

- Test-first regression proves the old implementation rejects a valid patch response before the fix.
- Focused gateway and revision-runner tests pass, followed by all tests, TypeScript, core-boundary
  checks, diff checks, and build.
- Independent code review reports no BLOCKER/MUST_FIX after at most two rounds.
- One new isolated direct run with the same `11_PPT大纲.md`, GPT `gpt-5.6`, Responses Structured
  Outputs, MiniMax disabled, Nano Banana concurrency 12, a new database, Run, and creation key reaches
  a verified twelve-page PPTX or exposes a separately evidenced new defect. FrameFlow is not used.

## 2. Non-goals

- Do not weaken or bypass deck/page quality review, issue resolution, delivery identity, or final
  accounting.
- Do not change `maxRevisionRounds`, score thresholds, automatic revision policy, or add an override.
- Do not accept model edits to unplanned pages or silently discard an unsafe complete-proposal output.
- Do not redesign revision planning, page-review prompts, deck-review prompts, image prompts,
  concurrency, or billing.
- Do not add another model call, an unbounded retry loop, MiniMax fallback, or Chat Completions.
- Do not modify FrameFlow or deploy production.

## 3. Implementation design

### 3.1 Patch schemas

Add strict internal Zod schemas in `src/visual-deck-v4-contracts.ts`:

- `VisualDeckV4ContentRevisionPatch`: `pageNumber`, content/source fields, three visual planning
  fields, and the two nullable cross-slide relations;
- `VisualDeckV4LayoutRevisionPatch`: `pageNumber` and only those visual planning fields/relations;
- `VisualDeckV4RevisionApplicationResult`: strict `contentPatches`, `layoutPatches`, and
  `redrawOnlyPageNumbers` arrays with unique page numbers within and across all three collections.

The schema is static and Provider-compatible. Operation-specific page membership remains a core
validation rule because the approved plan is runtime state, not part of the JSON Schema type.

### 3.2 Deterministic merge

For chain-2 V4 revisions, parse the patch result and derive expected patch ownership from the plan:

1. group operations by slide page;
2. assign content precedence over layout on pages containing both;
3. require exact equality between expected and returned page coverage, accepting either the
   operation-appropriate patch or an explicit redraw-only page;
4. merge only the schema-permitted fields onto cloned base Slide Briefs;
5. require each returned patch to create a real permitted change, while redraw-only pages inherit the
   base Slide Brief byte-for-byte and rely on the persisted operation instruction during image prompt
   compilation;
6. compile the merged base proposal through the existing V4 compiler;
7. run existing `validateV4Revision` and full Proposal/Blueprint validation.

Pure image-regeneration pages never enter model output. They remain unchanged in the proposal and
are redrawn later from the approved plan plus review correction memory.

### 3.3 Gateway routing and compatibility

`GatewayCoursewareModel.apply` selects by persisted compiler identity:

- chain-2: patch-only prompt, patch schema, and a new internal schema name;
- chain-1: existing full-draft prompt/schema/name unchanged;
- non-V4: existing BlueprintDraft flow unchanged.

The public port remains `Promise<unknown>` and no host API contract changes.

## 4. Test-first order

1. Add a failing runner test using the real nine-operation/eight-page shape from Run
   `run-f78cb2723595007a94dbd9abacfd`: pages 1 and 9 use redraw-only because their Slide Briefs already
   express the intended correction, pages 8 and 10 use layout patches, and pages 3/5/6/7 are pure
   regeneration. Require deterministic merge, exact preservation of globals and non-target pages,
   and media continuation.
2. Add failing negative runner tests for missing, duplicate, unplanned, wrong-kind, no-op, role/global
   injection, and invalid source-lineage patches.
3. Add failing chain-2 recovery tests proving: an invalid accepted patch switches only to the one
   deterministic repair key; Provider transient/timeout retries keep the current key; restart recovery
   reuses the persisted key; and an ambiguous Provider failure never starts contract repair under a
   new key.
4. Add a failing Gateway request-contract test proving chain-2 sends the patch-only strict JSON Schema
   and prompt, while chain-1 still sends the old complete-draft schema. Add a Runner test proving a
   chain-1 full Draft still parses, compiles, persists, and replays without entering the patch parser.
5. Implement schemas, compiler-version routing in both Gateway and Runner, deterministic page
   ownership, merge, and repair issue mapping in small slices, running focused tests after each slice.
6. Run all local gates and independent review. Fix accepted BLOCKER/MUST_FIX findings in one batch;
   round two only rechecks those findings.
7. Run one new paid, isolated twelve-page direct acceptance only after every local gate is green.

## 5. Expected files

- `src/visual-deck-v4-contracts.ts`
- `src/core/revision-application-runner.ts`
- `src/adapters/gateway-courseware-model.ts`
- `tests/revision-application-runner.test.ts`
- `tests/gateway-courseware-model.test.ts`
- `docs/decisions/ADR-007-visual-deck-v4-revision-patches.md`

No public OpenAPI, host-integration, FrameFlow, billing, or deployment file should change for this
defect.

## 6. Risks and rollback

- **Mixed-operation ambiguity:** deterministic content precedence prevents two patches from racing on
  one page; tests cover content+layout+asset combinations.
- **Silent no-op:** exact coverage requires the model to choose an actual patch or an explicit
  redraw-only disposition. Redraw-only is valid because V4 media prompt compilation also consumes the
  persisted operation instruction; subsequent page/deck review remains the semantic verifier.
- **Legacy recovery:** compiler-based routing keeps chain-1 on the full-output contract; tests prove
  both paths.
- **Source drift:** existing lineage validation runs after merge and remains stricter than the model
  prompt.
- **Provider schema compatibility:** the chain-2 schema is object-and-array based without dynamic
  optional fields; request-contract tests inspect the emitted strict schema.
- **Rollback:** revert only the expected file set. There is no database migration, public contract
  removal, FrameFlow change, or production rollback.
