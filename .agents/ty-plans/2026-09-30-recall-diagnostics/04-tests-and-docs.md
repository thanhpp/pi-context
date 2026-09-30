# Task 4: Tests and Documentation

**Depends on:** [Task 3](03-eval-integration.md)

**Goal:** Complete deterministic checks and document artifact inspection, warnings, limits, and retention.

**Files:**

- Modify: `README.md`
- Modify: `test/eval-recall-artifacts.test.ts`
- Modify: `test/eval-recall-run.test.ts`
- Modify: `test/eval-recall-entry.test.ts`
- Modify: `test/eval-recall-pi.test.ts`
- Modify: `test/fixtures/fake-recall-pi.ts`
- Modify: `test/fixtures/fake-pi-process.ts`

**Reuses:** `npm run check` checks TypeScript. `npm test` runs deterministic tests through Node's test runner.

**Precondition:** Tasks 1–3 provide process evidence, bounded artifact writing, and evaluation integration. The option reader supports `PI_EVAL_ARTIFACT_ROOT`.

**Site conditions:** The project requires Node.js `>=22.19.0`. It uses Node's `--experimental-strip-types` flag. One run makes 34 seed calls and 48 question calls. Two runs make 164 benchmark call attempts. The evaluator does not retry calls automatically. The selected executable's `--version` preflight is not a model call. The entry must not make an extra login-probe call.

Artifacts default to `.benchmarks/recall/<UUID>` under the package root. A non-empty absolute `PI_EVAL_ARTIFACT_ROOT` selects another root. The `EvalOptions.artifactRoot` field stores that root. Entry tests must set the override to a temporary directory outside `TMPDIR`. Tests must not write artifacts under the package root.

The existing `README.md` has a Recall evaluation section and other user content. Edit only the Recall evaluation section. Preserve unrelated README content. The call log stores fact text, question text, answers, score inputs, process status, and parsed `pi_context` evidence. Each entry has a 16 MiB serialized limit, including its newline. The writer can omit evidence and warn while it keeps metadata. A partial final JSONL line is not a valid call entry. A `running` manifest is unfinished. A failed call or write does not prove a specific diagnosis.

Temporary workspaces and login links must be removed after completion or interruption. Diagnostic artifacts must remain. Paths and warnings go to standard error. Aggregate report output stays unchanged on standard output.

## Steps

1. Test the artifact reader with partial final lines and malformed complete lines.
2. Test evidence omission, metadata retention, and the 16 MiB line limit.
3. Complete run tests for seed metadata, fact stage and text, record outcome, question score inputs, and observed tool events.
4. Test failed and timed-out outcomes, writer failures, and temporary cleanup.
5. Keep `PI_EVAL_ARTIFACT_ROOT` separate from `tmpRoot` in every test.
6. Complete pi-runner tests for correlated and uncompleted tool events.
7. Test timeout, malformed output, nonzero exit, spawn failure, and stdout overflow.
8. Keep existing answer, status, record-count, prompt, score, and call-count assertions.
9. Complete entry tests for valid, empty, and relative artifact-root values.
10. Confirm invalid values fail before executable preflight.
11. Check artifact paths and warnings on standard error. Check aggregate output on standard output.
12. Test interruption cleanup with the fixture's deterministic hang mode. Send `SIGTERM` after the fake process starts.
13. Confirm interruption keeps the unfinished artifact and removes temporary isolation.
14. Add fixture modes only when tests need them. Fixtures must not contact a provider.
15. Update the Recall evaluation section in `README.md`. Explain the default path and override validation.
16. Document manifest fields and statuses, per-call evidence, the 16 MiB limit, omission warnings, and partial-line handling.
17. Explain evidence limits and local retention. State that artifacts remain after the temporary workspace and login link are deleted.
18. State that artifacts do not contain login files or the inherited environment.
19. Remove the extra login-probe recommendation. State that the evaluator adds no probe or automatic retry.
20. Document one separate operator-approved two-run command after deterministic checks. Use `openai/gpt-6-sol` and 164 benchmark call attempts.
21. Run `npm run check` and `npm test`. Confirm both commands pass without provider credentials or paid calls.
22. Confirm that tests created no artifact directory under the package root.

## Acceptance

- [ ] Deterministic tests cover success, failure, timeout, malformed output, stdout limits, interruption, and tool-call correlation.
- [ ] Tests cover writer failure, oversized evidence, and partial final lines.
- [ ] Tests use temporary artifact roots outside temporary isolation. Tests create no package-root artifacts and make no paid calls.
- [ ] Existing aggregate output, scores, prompts, and call counts stay unchanged.
- [ ] `README.md` explains paths, override, fields, size limit, warnings, incomplete evidence, privacy limits, cleanup, and retention.
- [ ] `README.md` documents the separate two-run command. It does not recommend an extra login probe.
- [ ] `npm run check` passes.
- [ ] `npm test` passes.
