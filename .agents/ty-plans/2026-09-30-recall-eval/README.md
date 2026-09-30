🤖 # Recall Eval — Plan

> Execute the tasks in dependency order. Each task file is self-contained. The user's confirmed intent is in [REQUIREMENTS.md](REQUIREMENTS.md).

**Status (2026-09-30):** Tasks 1 to 6 are implemented and checked. Verification steps 1 to 6, 8 and 9 passed. Step 7, the paid check, is not run. The next steps are in [NEXT-STEPS.md](NEXT-STEPS.md).

**Goal:** Add an opt-in script to `pi-context` that seeds project memory in real `pi` sessions, asks 24 recall questions with and without the extension, and reports the hit rate for each question type.

**Context:** The package `pi-memory` has `test/eval-recall.ts`. It seeds a corpus, asks 15 questions with and without selective injection, and scores with any one keyword. `pi-context` has no injection: the model decides to call the `pi_context` tool. The comparison is therefore "extension loaded" against "no extension". The operator removed the LongMemEval-V2 benchmark from the working tree, so no recall check exists now. The new eval also tests cases that the `pi-memory` eval does not test: a missing fact, a newer fact that replaces an older one, and a fact that belongs to another subsystem.

**Architecture:** One entry file and six small modules under `scripts/eval-recall/`.

```
scripts/eval-recall.ts          entry: checks, signal handlers, run, report
scripts/eval-recall/
  text.ts                       normalizeText, containsToken (whole-word match)
  corpus.ts                     24 cases, 10 distractor facts, allFacts(), validateCorpus()
  score.ts                      scoreAnswer(): keyword and abstention rules
  pi.ts                         buildPiArguments, runPi, parseSessionOutput, killLivePiProcesses
  report.ts                     QuestionOutcome, SeedOutcome, formatReport
  run.ts                        readOptions, prepareIsolation, removeIsolation, runEval
test/fixtures/fake-pi-process.ts   canned fake pi, driven by prompt markers (tests pi.ts)
test/fixtures/fake-recall-pi.ts    corpus-aware fake pi (tests run.ts)
```

A run does this: create a temporary agent directory and a temporary `git init` workspace; send each of the 34 facts in its own `pi` session with the extension (the model decides whether to call `record`); then ask the 24 questions in a new `pi` process each, first with the extension, then with no extension and no tools. Facts with `update` stage go last, so every newer fact is recorded after its older fact.

Key decisions and the alternative that fails:

- **Real sessions for seeding, not direct store writes.** The score then covers the write path, the search path and the read path. A direct write would test only search and read, and it would hide a model that never records.
- **One fact for each seed session.** The model decides for each fact alone whether to record it, so the record rate is clean. Four facts in one session would let the model merge or skip facts and would hide which fact was lost.
- **Hybrid scoring, not "any one keyword" for every case.** For a `superseded` question, an answer that names the old and the new value contains the expected keyword and is wrong. For an `absent` or `adjacent` question, no keyword can be correct, so the answer must abstain. The `present` rule stays as in `pi-memory`.
- **Whole-word keyword matching.** A plain substring test lets `ses` match `uses` and `20` match `2024`.
- **`PI_EVAL_MODEL` is required.** A temporary agent directory has no `settings.json`, and `pi` then defaults to the provider `google`, which has no login.
- **Login by symbolic link.** The isolated agent directory links to the operator's real `auth.json`, so the subscription login works and no second copy of the credentials exists. The alternative, a copy, may fork an OAuth refresh token. The source of `pi` 0.87.1 writes `auth.json` with `writeFileSync` on the link path (`auth-storage.js` line 66), so a refresh writes the real file in place and the link survives. The lock uses `realpath: false`, so the eval lock is `<temporary agent directory>/auth.json.lock`: no other `pi` session may use the same login during a paid run. No test ran a real refresh, so the operator checks the login after the first paid run.
- **Arm B has `--no-tools`, arm A has `--tools pi_context`.** Both arms then have no file tools, so the model cannot read the project files. The only difference between the arms is the extension.
- **The runner copies the pattern of `scripts/two-session-demo.ts` and does not import it.** That file exports nothing and starts `main()` when imported.
- **`recorded` is per session, and the report separates question facts from distractors.** The extension is meant to skip some facts, so a skipped distractor is not an error.
- **`AGENTS.md` is a symbolic link to `README.md`.** Agents then read the same text as people, and the eval section exists in one file only. The link target is relative, so the link works in every clone. `npm pack` does not pack the link, because the `files` list of `package.json` does not name it.

**Gating conditions:**

- Node 22.19 or later (`package.json` `engines`). The planning machine has Node 25.7.0.
- `npm run check` passed with no error on 2026-09-30, before any task. If it fails when Task 1 starts, record the errors and add no new error.
- Unit tests need no `pi`, no login and no network. Only the paid run needs `pi` 0.87.1 on the path and a login file at `<agent directory>/auth.json` (the file exists at `~/.pi/agent/auth.json`; its content was not read).
- The working tree has uncommitted deletions (the LongMemEval-V2 files) and edits in `README.md` and `package.json`. No task restores, stages or reverts them. The unused fixtures `test/fixtures/fake-benchmark-pi.ts` and `test/fixtures/fake-judge-pi.ts` stay as they are.
- No task changes `src/`. If a task finds that it needs a change in `src/`, the executor must stop and report it.
- Coding rules for every task: `strict` TypeScript, no `enum` (the option `erasableSyntaxOnly` is on), imports with the `.ts` extension, `node:test` for tests, no new dependency, no comment unless it states an invariant.

**Output:** The script `npm run eval:recall`, six modules, two fake `pi` fixtures, seven test files, one `package.json` script line, one `README.md` section, and the symbolic link `AGENTS.md` to `README.md`.

## Tasks

| # | Task | Depends on | Covers | What it does | Status |
|---|------|------------|--------|--------------|--------|
| 1 | [corpus and text helpers](01-corpus-and-text.md) | — | R6, R7, R12 | Whole-word matcher, 24 cases, 10 distractors, corpus validator. | Done. The text and corpus tests pass. The corpus prints `24 10 34`. |
| 2 | [answer scoring](02-score.md) | 1 | R8, R12 | `scoreAnswer` with the keyword rule and the abstention rule. | Done. The score tests pass. With task 1: 23 of 23 tests. |
| 3 | [pi process runner](03-pi-runner.md) | — | R4, R11, R12, R16 | Exact `pi` arguments for both arms, timeout, output parsing, record-call count. | Done. 20 of 20 tests pass. `parseSessionOutput` counted 1 record call on a real `pi` 0.87.1 output. |
| 4 | [report formatting](04-report.md) | 1, 3 | R11, R12 | Outcome types and `formatReport` with rates, spread, record rate and failure counts. | Done. 7 of 7 tests pass. |
| 5 | [run orchestration](05-run-orchestration.md) | 1, 2, 3, 4 | R2, R3, R4, R5, R7, R9, R10, R12, R14, R15 | Options, isolation with the login link, seeding, both arms, cleanup, corpus-aware fake. | Done. 10 of 10 tests pass. |
| 6 | [entry point, docs and AGENTS.md link](06-entry-and-docs.md) | 4, 5 | R1, R2, R10, R12, R13, R15, R17 | Entry file, preflight checks, signal cleanup, npm script, README section, `AGENTS.md` link. | Done. 5 of 5 entry tests pass. The full suite passes 176 of 176 tests. |

Tasks 1 and 3 can start at the same time. Tasks 2 and 4 can run in parallel after Task 1 (Task 4 also needs Task 3).

## Verification

Run these in the repository root after Task 6. The first six commands make no model call.

1. `npm run check` → exits with code 0.
2. `npm test` → all tests pass.
3. `npm run eval:recall; echo "exit=$?"` → prints a message that names `PI_CONTEXT_EVAL=1` and `exit=1`.
4. `PI_CONTEXT_EVAL=1 npm run eval:recall; echo "exit=$?"` → prints a message that names `PI_EVAL_MODEL` and `exit=1`.
5. `git status --short src/` → prints nothing.
6. `readlink AGENTS.md` → prints `README.md`.
7. Paid check, only with the operator's approval: `PI_CONTEXT_EVAL=1 EVAL_RUNS=1 PI_EVAL_MODEL=openai-codex/<model id> npm run eval:recall` → prints the report with a row for each of `present`, `superseded`, `absent`, `adjacent` and `total`, the line `seed record rate:` and the two answer-count lines. It makes about 82 `pi` calls.
8. After the paid check: `pi -p "say ok" --model openai-codex/<model id>` → prints an answer and does not ask for a login. This is the check for the symbolic link.
9. After the paid check: `ls /tmp | grep pi-context-eval` → prints nothing (the run removed its directories).

Results on 2026-09-30:

- Steps 1 to 6 passed. `npm test` passed 176 of 176 tests. Both refusals printed their message and exited with code 1. `git status --short src/` printed nothing. `readlink AGENTS.md` printed `README.md`.
- Step 7 is not run. It makes about 82 `pi` calls, and the operator allowed only a small subset.
- In place of step 7, a smoke script in the session scratchpad made 3 real calls with `openai-codex/gpt-6-sol`: 1 seed and 1 question in each arm. All 3 calls returned `ok`. The seed session made 0 `record` calls, and both arms answered "I don't know."
- Two diagnostic calls asked for the `pi_context` tool by name. The tool loaded in arm A, and `parseSessionOutput` counted `recordCalls: 1` on the saved real output.
- Step 8 passed after these 6 calls: `pi -p "say ok"` answered and did not ask for a login. No token refresh occurred, so the link was not tested during a refresh.
- Step 9 passed: `ls /tmp | grep pi-context-eval` printed nothing.

## Out of Scope

- The uncommitted deletion of the LongMemEval-V2 benchmark and the edits in `README.md` and `package.json` (the operator's changes stay as they are).
- A CI workflow. The eval runs by hand because it makes paid calls.
- Coding-task evaluation, for example DreamBench-SWE. This eval measures recall of facts only.
- A judge model. All scoring is deterministic.
- A comparison with other memory plugins.
- Any change in `src/`.
- Token counts and costs in the report. `pi` reports usage, but no requirement asks for it. Add it later if the operator needs it.
