# Recall Diagnostics — Plan

> Execute tasks in dependency order. Each task file is self-contained. The confirmed intent is in [REQUIREMENTS.md](REQUIREMENTS.md).

**Goal:** Save bounded per-call recall evidence so an operator can inspect failures without changing benchmark results.

**Context:** The recall evaluator keeps only aggregate seed and question outcomes. It deletes each temporary workspace and login link after a run. Answers and observed `pi_context` events are not retained. An operator cannot inspect a miss after cleanup. Implementation is approved. One separate two-run paid check is approved after deterministic checks.

**Architecture:**

- `scripts/eval-recall/pi.ts` will attach bounded process evidence to each call result. It will keep existing status, answer, and record-count rules.
- The process evidence will correlate observed `pi_context` requests and results by `toolCallId`. It will mark uncompleted calls.
- `scripts/eval-recall/artifacts.ts` will create `.benchmarks/recall/<UUID>/manifest.json` and `calls.jsonl`. It will use Node built-ins only.
- The writer will append one record after each completed call. It will enforce the 16 MiB entry limit, including the newline. It will omit bulky evidence and warn when an entry exceeds that limit. It will stop appending after an append failure.
- The writer will expose a reader that excludes an incomplete final JSONL line.
- `scripts/eval-recall/run.ts` will add seed and question metadata and scoring inputs. It will append them after each existing call. Storage failures will not stop evaluation calls.
- `scripts/eval-recall.ts` will print the artifact path and warnings to standard error. The aggregate report on standard output will stay unchanged.
- The default root is `<packageRoot>/.benchmarks/recall`. The optional `PI_EVAL_ARTIFACT_ROOT` value must be a non-empty absolute path.
- Artifacts must stay outside temporary isolation. Cleanup deletes files inside isolation, so that location would lose the evidence.
- Artifacts must not contain the inherited environment or login data.
- The plan adds no retry or login probe. Either action would add calls and could add paid calls.

**Gating conditions:** The project requires Node.js `>=22.19.0`. It uses Node's `--experimental-strip-types` flag for TypeScript source. `.gitignore` already excludes `.benchmarks/`. Run `npm run check` and `npm test` for deterministic validation. Tests must set `PI_EVAL_ARTIFACT_ROOT` to a temporary absolute directory. That directory must be outside `TMPDIR` isolation. Run the separate live check only after both deterministic commands pass. Use model `openai/gpt-6-sol`, two runs, and 164 benchmark call attempts. Source tasks must not start the live check.

**Output:** Each evaluation has one manifest and one append-only call log. The entries have bounded seed and question evidence. They include process and tool-event diagnostics. Deterministic tests cover limits, failures, incomplete lines, cleanup, and output streams. The README explains inspection, limits, warnings, and retention.

## Tasks

| # | Task | Depends on | Covers | What it does |
|---|------|------------|--------|--------------|
| 1 | [Call evidence](01-call-evidence.md) | — | R4, R5, R9 | Add process and correlated `pi_context` evidence without changing existing call results. |
| 2 | [Artifact writer](02-artifact-writer.md) | 1 | R1, R6, R10, R13, R14, R15, R16 | Add the UUID artifact store, bounded JSONL writer, manifest, and incomplete-line reader. |
| 3 | [Evaluation integration](03-eval-integration.md) | 1, 2 | R2, R3, R6, R7, R8, R9, R17, R18 | Save each seed and question call while preserving outcomes, cleanup, and output streams. |
| 4 | [Tests and documentation](04-tests-and-docs.md) | 3 | R7, R9, R11, R12 | Complete deterministic checks and document artifacts and the separate paid check. |

## Verification

Run deterministic checks first:

```sh
npm run check
npm test
```

Both commands must pass without provider credentials or paid model calls. Fixtures must not contact a provider. Tests must use temporary artifact roots outside temporary isolation roots.

After both commands pass, run one separate, approved two-run evaluation:

```sh
PI_EVAL_EXECUTABLE="$(command -v pi)" \
PI_CONTEXT_EVAL=1 \
PI_EVAL_MODEL=openai/gpt-6-sol \
EVAL_RUNS=2 \
npm run eval:recall
```

This command requests 164 benchmark call attempts. The evaluator must not retry a call or make an extra login-probe call. The executable version preflight is not a model call. Do not run another paid command.

## Out of Scope

- Change prompts, score rules, call order, call count, or aggregate standard output.
- Change memory recording, retrieval, or update behavior.
- Assign a definitive cause to a failed score.
- Store temporary workspaces, memory snapshots, login links, login files, credentials, or the inherited environment in artifacts.
- Add dependencies, automatic retries, or login-probe calls.
- Start paid calls from implementation or deterministic-test tasks. The two-run check is separate. Run it only after deterministic validation.
