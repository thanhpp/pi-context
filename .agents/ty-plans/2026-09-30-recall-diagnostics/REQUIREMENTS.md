# Recall Diagnostics — Requirements

**Intent:** "Save per-case answers and recording outcomes before another paid run. These data can separate recording errors, retrieval errors, update errors, and scoring errors."

**Understanding:** Add local per-call evidence to recall evaluations so an operator can inspect missed cases without changing benchmark behavior.

## Requirements

- **R1** Each evaluation must create one unique local artifact folder when storage is available.
- **R2** Each seed call must save its run index, fact ID, fact stage, fact text, call status, answer, record-call count, and recording outcome.
- **R3** Each question call must save its run index, arm, case ID, case type, question, answer, call status, benchmark score, and scoring inputs.
- **R4** Each call must save observed `pi_context` requests and results, correlated by tool-call ID, including calls that do not complete.
- **R5** Artifacts must separate observed evidence from uncertain causes. A failed score alone must not assert a cause.
- **R6** Diagnostic write failures must produce warnings and must not stop later evaluation calls.
- **R7** Temporary workspaces, temporary memory, and login links must still be deleted after evaluation. Diagnostic artifacts must remain outside that temporary isolation.
- **R8** Diagnostic artifacts must not copy login files, credentials, or the inherited process environment.
- **R9** Existing prompts, score rules, call counts, and aggregate report output must remain unchanged.
- **R10** The implementation must use built-in libraries and must add no dependencies.
- **R11** Deterministic fixture tests must cover saved evidence and diagnostic write failures without paid model calls.
- **R12** Documentation must explain artifact locations, evidence limits, write warnings, and local retention.
- **R13** Each artifact folder must contain an append-only `calls.jsonl` file and a `manifest.json` file.
- **R14** Each serialized call entry, including its final newline, must use at most 16 MiB. An oversized entry must keep call metadata, mark evidence as omitted, and produce a warning.
- **R15** A reader must exclude an incomplete final JSONL line from valid call entries and report that evidence is incomplete.
- **R16** After a call-log append failure, the writer must stop later appends to that evaluation file while model calls continue.
- **R17** The evaluator must not retry model calls automatically or make an additional login-probe call.
- **R18** `PI_EVAL_ARTIFACT_ROOT` must accept only a non-empty absolute path when set. If it is unset, the evaluator must use `<packageRoot>/.benchmarks/recall`.

## Expected Behaviors

| Situation | Expected result |
|-----------|-----------------|
| An evaluation starts with writable storage | One UUID folder under the selected artifact root contains a manifest and an append-only call log. |
| A seed call does not record | Its artifact shows the observed record-call count and outcome without asserting a cause. |
| A question receives a failing score | Its answer, score, and scoring inputs remain available unless evidence must be omitted to meet the entry limit. |
| A `pi_context` tool call runs | Its request and result are correlated by tool-call ID; an uncompleted request remains marked incomplete. |
| A process fails, times out, emits malformed output, or exceeds the stdout limit | The artifact records the process status and the available parsed evidence. |
| A process or artifact log ends with an incomplete JSONL line | A reader excludes that line and reports incomplete evidence. |
| A call entry exceeds 16 MiB | The writer keeps call metadata, omits bulky evidence, and warns on standard error. |
| Artifact creation or writing fails | A warning appears on standard error. Evaluation calls continue. The writer does not retry a failed append. |
| `PI_EVAL_ARTIFACT_ROOT` is empty or relative | Option parsing rejects it before the executable preflight or model calls. |
| Evaluation finishes, fails, or receives an interrupt | Temporary isolation is removed. Saved diagnostic files remain outside it. An unfinished manifest does not claim completion. |
| Deterministic checks pass | The separate approved live check can run exactly two evaluations with `openai/gpt-6-sol`, for 164 benchmark call attempts, without automatic retries or a login probe. |

## Constraints

- Use built-in libraries. Add no dependency.
- Preserve existing prompts, score rules, model-call count, aggregate report text, and standard-output behavior.
- Write artifacts by default to `<packageRoot>/.benchmarks/recall/<UUID>`. `PI_EVAL_ARTIFACT_ROOT` can select another non-empty absolute root.
- Use temporary artifact roots in tests. Keep them separate from each evaluation's temporary isolation root.
- Keep artifacts outside temporary isolation. Do not copy login files, credentials, or process environment into artifacts.
- Source and deterministic-test tasks must make no paid model calls. After deterministic checks pass, the separately approved live check uses model `openai/gpt-6-sol`, exactly two runs, and 164 benchmark call attempts. Do not add automatic retries or an extra login-probe call.
- This brief changes planning files only. It does not implement source code or start paid calls.

## Non-goals

- Change superseded-answer scoring or any other score rule.
- Change memory recording, retrieval, or update behavior.
- Assign a definitive cause to a missed question.
- Retain temporary memory snapshots, temporary workspaces, or login links.
- Start paid calls from source tasks or deterministic tests. The two-run check is a separate operator-approved step after deterministic checks.

## Done Criteria

- Deterministic tests demonstrate per-call evidence, correlated tool evidence, temporary cleanup, incomplete-line handling, bounded entries, and continuation after diagnostic write failures.
- Failed, timed-out, malformed, and stdout-limited processes preserve their existing benchmark status and score behavior while exposing available diagnostic evidence.
- The aggregate report keeps its current scores, call counts, and standard-output text.
- `npm run check` and `npm test` pass without provider credentials or paid calls.
- Documentation explains artifact inspection, warnings, privacy limits, and local retention.
- After deterministic checks pass, the separate approved live check can complete two runs with 164 benchmark attempts and no retries or login probe.

## Decision Log

| # | Question | User's answer | Effect |
|---|----------|---------------|--------|
| 1 | Which evidence must the benchmark save for diagnosis? | Answers and tool results (Recommended) | R2–R5 require answers, scoring inputs, and memory-tool evidence. |
| 2 | How should the benchmark retain diagnostic artifacts? | Automatic local artifacts (Recommended) | R1 and R7 require automatic output and temporary isolation cleanup. |
| 3 | What must happen if the benchmark cannot write diagnostic evidence? | Continue with warning | R6 preserves evaluation calls after diagnostic write failures. |
| 4 | Which delivery scope and completion criteria should the plan use? | Diagnostics only (Recommended) | R9–R12 preserve semantics and require deterministic tests and documentation. |
| 5 | Do you confirm these requirements for the diagnostic plan? | Confirm requirements (Recommended) | R1–R12 and the original non-goals were confirmed. |
| 6 | Do you confirm the proposed per-call JSON files and manifest architecture? | One JSONL file | R13 selects append-only call evidence and a manifest. |
| 7 | How should diagnostic files handle large answers and tool results? | Bound each call file (Recommended) | R14 applies the 16 MiB limit to each JSONL call entry. |
| 8 | Do you confirm this JSONL architecture and the added R13–R15 requirements? | Confirm architecture (Recommended) | The user confirmed JSONL layout, bounded entries, incomplete-line handling, and append disabling after failure. |
| 9 | How can successful entry-point tests use a temporary artifact root? | The coordinator approved optional `PI_EVAL_ARTIFACT_ROOT`; the default remains under the package root. | R18 adds a non-empty absolute override and keeps test artifacts outside temporary isolation. |
| 10 | Does the plan remain plan-only with no paid validation? | Implementation and exactly two paid runs are now approved after deterministic checks. Use `openai/gpt-6-sol` and 164 benchmark calls. Do not add automatic retries or extra login-probe calls. | This plan covers implementation. Paid execution remains a separate operator-approved check, not a source task. |
