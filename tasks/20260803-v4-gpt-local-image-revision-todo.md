# V4 GPT Local Image Revision Checklist

- [x] Plan independently reviewed with no unresolved BLOCKER.
- [x] Repair contract and revision-key compatibility tests written red, then implemented green.
- [x] Controlled prior-artifact validation tests written red, then implemented green.
- [x] GPT `/images/edits` routing, model, batch, and concurrency tests written red, then implemented green.
- [x] Edit-aware lookup proves accepted/unknown submissions never repeat POST; only authoritative NOT_SUBMITTED may recover under the same Key.
- [x] Revision batches persist `accountingModel` and `operationMode`; config drift and administrator recovery never fall back to Nano.
- [x] Ten Nano initial pages plus two full GPT edit rounds remain exactly 30 image units / current 300-credit host ceiling.
- [x] Idempotency, restart, unknown-submission, and accounting recovery tests written red, then implemented green.
- [x] Page review, deck review, and raster PPTX integration path passes.
- [x] API/configuration documentation and release identity are consistent.
- [x] `bun run check` and `git diff --check` pass.
- [x] Independent code review round 1 findings were adjudicated and remediated.
- [x] Independent code review round 2 confirmed the behavioral remediations; its test-only TypeScript finding was fixed and the full gate rerun.
- [x] FrameFlow, production, user analysis documents, README, and output artifacts remain untouched.
