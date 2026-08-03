# V4 Terminal Delivery and Selective Reflection Checklist

- [x] Confirm branch is based on freshly fetched `origin/main`.
- [x] Define scope, acceptance criteria, impact, and non-goals.
- [x] Write implementation order, test matrix, risks, and rollback plan.
- [x] Complete independent planning review round 1 (0 BLOCKER, 6 MUST_FIX).
- [x] Amend the plan for canonical accounting, legacy Delivery reads, FINAL identity, mutation scopes,
  lifecycle count, and semantic negative controls.
- [x] Pass focused planning re-review with no remaining BLOCKER/MUST_FIX.
- [x] Add and confirm failing Issue #29 regression tests.
- [x] Implement Issue #29 terminal failure/accounting behavior.
- [x] Implement V4 override and FINAL delivery invariants.
- [x] Pass Issue #29 checkpoint.
- [x] Add and confirm failing Issue #30 contract tests.
- [x] Write ADR-006 and reflection contracts.
- [x] Add and confirm failing gateway reflection tests.
- [x] Implement gateway reflection requests.
- [x] Add and confirm failing orchestration/recovery tests.
- [x] Implement persisted reflection stages and deterministic merge.
- [x] Add page 6/page 12 semantic prompt regressions.
- [x] Pass Issue #30 checkpoint (102 focused tests passed).
- [x] Run full unit/API/integration/E2E/regression/static/build gates (500 tests, boundaries,
  typecheck, and build passed).
- [x] Complete independent post-development review round 1 (3 BLOCKER, 5 MUST_FIX,
  1 acceptance-evidence gap, 1 SUGGESTION).
- [ ] Adjudicate, fix, and retest round 1 findings.
- [ ] Complete focused post-development review round 2 if required.
- [ ] Register and centrally process residual non-blocking findings.
- [ ] Reassess remaining open Issues with evidence.
- [ ] Verify staged diff excludes pre-existing user-owned changes.

## Round 1 accepted remediation scope

- [ ] Move quality/technical terminalization behind durable FINAL accounting without a retry loop.
- [ ] Remove remaining V4 internal failure exits to ordinary-user NEEDS_HUMAN.
- [ ] Give Slide Brief reflection the final Presentation Spec, Deck Plan, and Visual Contract.
- [ ] Bind Source Spec roles, chunks, goal, audience, focus, count, language, and mode to the request.
- [ ] Enforce every finding page and field against a real scoped change.
- [ ] Publish one V4.1 software/compiler identity with an explicit chain-1 recovery policy.
- [ ] Record bounded reflection audit metrics without prompts or source content.
- [ ] Preserve non-contract/internal error classification instead of relabeling it MODEL_JSON_INVALID.
- [ ] Run the paid, direct PPT Agent twelve-page acceptance case after code review passes.
