🤖 # Recall Eval — Requirements

**Intent:** "Design a similar pi-memory eval for the pi-context package."

**Understanding:** Add an opt-in script to `pi-context` that runs real `pi` sessions to seed project memory, then asks recall questions with the extension loaded and with it not loaded, and reports the hit rate per case type, as `test/eval-recall.ts` does for pi-memory.

## Requirements

- **R1** The script `scripts/eval-recall.ts` runs with `npm run eval:recall`. The `package.json` script uses `node --experimental-strip-types`, like the existing `demo` script.
- **R2** The script makes paid model calls, so it refuses to start unless the environment variable `PI_CONTEXT_EVAL=1` is set. Without it, the script prints one message that names the variable, makes no `pi` call, and exits with a non-zero code.
- **R3** Every run uses a new temporary agent directory (`PI_CODING_AGENT_DIR`) and a new temporary project directory that `pi-context` accepts as a project. The script never reads or writes `~/.pi`, with one exception: the `auth.json` link of R15. The script removes both directories when it exits, including after an error.
- **R4** The eval has two arms. Arm A ("extension") loads `src/extension.ts` with `pi -e`. Arm B ("control") loads no extension and has no memory.
- **R5** Arm A seeds memory through real `pi` sessions. Each fact goes to its own seed session, and the model decides whether to record it through the `pi_context` tool. The script never writes to the store itself. Each question goes to a new `pi` process with no facts in the prompt.
- **R6** The corpus has 24 questions: 6 for each case type `present`, `absent`, `superseded` and `adjacent`. The corpus also has at least 10 distractor facts that no question needs. Every question has an ID that is unique in the corpus.
- **R7** A `superseded` question has an old fact and a new fact for the same subject. The script records the old fact in an earlier session than the new fact.
- **R8** Scoring is deterministic. It uses no judge model.
  - `present`: the answer passes when it contains any one expected keyword.
  - `superseded`: the answer passes when it contains any one expected keyword and no forbidden keyword.
  - `absent` and `adjacent`: the answer passes when it contains an abstention phrase (for example "I don't know") and no forbidden keyword. For `adjacent`, the forbidden keyword is the value of the stored fact that belongs to another subsystem.
  - Matching ignores letter case and treats the typographic apostrophe as the plain apostrophe.
- **R9** `EVAL_RUNS` sets the number of runs. The default is 3. Every run starts with an empty memory.
- **R10** `PI_EVAL_MODEL` selects the model in `provider/id` form, for example `openai-codex/<model id>`. The script passes it to `pi` as `--model`. A temporary agent directory has no `settings.json`, and `pi` then defaults to the provider `google`, so the script refuses to start when `PI_EVAL_MODEL` is not set. The script prints one message that names the variable, makes no `pi` call, and exits with a non-zero code. There is no `PI_EVAL_PROVIDER` variable.
- **R11** The report shows, for each case type and in total: the hit count and hit rate of arm A, the hit count and hit rate of arm B, the difference, and the lowest and highest hit rate over the runs. The report also shows how many `pi` calls timed out or failed. The report also shows the record rate of arm A, for question facts and for distractor facts separately: the number of seed sessions with at least one successful `record` call divided by the number of seed sessions. The script counts the calls from the `tool_execution_end` events of the `pi_context` tool. The two rates are separate because the extension is meant to skip some facts, so a distractor fact that is not recorded is not an error.
- **R14** If a seed session records no fact, the script still asks the question in arm A and counts the answer as scored. The script does not exclude the question and does not abort the run.
- **R15** The isolated agent directory gets the operator's OpenAI subscription login through a symbolic link named `auth.json` that points to the operator's real `auth.json`. The script computes the real path from the operator's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). The script never copies the file and never prints its content. The link target is the absolute path `resolve(<operator agent directory>, 'auth.json')`. The cleanup removes the link and never removes or changes the target.
- **R16** Every `pi` call runs with the flags `-ne -ns -np -nc --offline --no-session --mode json`, the flag `--model <PI_EVAL_MODEL>`, and the prompt after `-p`. Arm A also runs with `-e <repository root> --tools pi_context`. Arm B runs with `--no-tools` and no `-e`.
- **R12** Tests run with `npm test`, make no model call, and use a fake `pi` from `test/fixtures/`. They check corpus validity, scoring for every case type, the opt-in refusal, the refusal when `PI_EVAL_MODEL` is not set, the exact `pi` arguments of each arm, the cleanup of temporary directories, and that the cleanup keeps the target of the `auth.json` link.
- **R13** The change adds the `eval:recall` script to `package.json` and one short section to `README.md`. It changes no other line in those two files.
- **R17** The change creates `AGENTS.md` in the repository root as a symbolic link with the relative target `README.md`. The change does not create a separate `AGENTS.md` file with its own text.

## Expected Behaviors

| Situation | Expected result |
|-----------|-----------------|
| `npm run eval:recall` with `PI_CONTEXT_EVAL` not set | One message, no `pi` call, non-zero exit code |
| `PI_CONTEXT_EVAL=1 npm run eval:recall` | 3 runs of 24 questions in each arm, then the report |
| `pi` is not on the path | The script prints that `pi` is missing and exits with a non-zero code before it creates any directory |
| `PI_EVAL_MODEL` is not set | One message that names the variable, no `pi` call, non-zero exit code |
| The operator's `auth.json` does not exist | The script prints that the login file is missing and exits with a non-zero code before it creates any directory |
| A seed session records no fact | The question is still asked in arm A and scored. The record rate in the report is below 100 percent |
| One fact per seed session | The script sends each fact in its own `pi` process. The prompt states the fact as a project decision or preference and never names memory, the tool or the word "record" |
| One `pi` call exceeds the timeout (proposed default: 120 seconds) | The script counts a miss, counts one timeout in the report, and does not retry |
| One `pi` call exits with an error | The script counts a miss, counts one failure in the report, and continues |
| The script gets an interrupt signal during a run | The script removes its temporary directories before it exits |
| Arm A seed sessions record fewer facts than the corpus has | The `seed record rate:` line shows the recorded count and the total for question facts and for distractor facts, so a write failure is visible |
| An answer to a `superseded` question names both the old and the new value | The answer fails |
| An answer to an `absent` question gives a confident guess | The answer fails |

## Constraints

- Node 22.19 or later, as in `package.json`. No new dependency. Use only Node built-in modules and the existing dependencies.
- Only `pi` runs the model. The script does not call a model API directly.
- The script does not change any file under `src/`. If the eval needs a hook in `src/`, the executor must stop and report it.
- The script reports scores and asserts no threshold. It exits with code 0 after a complete report, whatever the scores are.
- The login must work with the operator's OpenAI subscription, which is a login and not an API key. `pi` reads it from `<agent directory>/auth.json`.
- During a paid run, no other `pi` session may use the same login. `pi` locks `auth.json` with `proper-lockfile` and `realpath: false` (`auth-storage.js` lines 39 and 85-86), so the lock of the eval is `<temporary agent directory>/auth.json.lock` and not the lock of the operator. A token refresh in two processes at the same time can then overwrite the other refresh.
- One paid run makes about 246 `pi` calls with the defaults: per run about 34 seed sessions, 24 answers in arm A and 24 answers in arm B, times 3 runs.

## Non-goals

- Do not touch the uncommitted deletion of the LongMemEval-V2 benchmark files, or the existing edits to `README.md` and `package.json`. The plan only adds its own lines.
- No CI workflow. The eval runs by hand.
- No coding-task evaluation, for example DreamBench-SWE. The eval measures recall of facts only.
- No judge model.
- No comparison with other memory plugins.

## Done Criteria

- `npm run check` and `npm test` pass and make no model call.
- `npm run eval:recall` without `PI_CONTEXT_EVAL=1` exits with a non-zero code and makes no `pi` call.
- `PI_CONTEXT_EVAL=1 EVAL_RUNS=1 PI_EVAL_MODEL=<provider/id> npm run eval:recall` prints the report. The operator runs this paid command. The planner and the executor do not run it without the operator's approval.
- After that paid run, the operator checks that the real login still works: `pi -p "say ok" --model <provider/id>` prints an answer and does not ask for a login. This is the manual check for the symbolic link. The source of `pi` 0.87.1 writes `auth.json` with `writeFileSync` on the link path (`auth-storage.js` line 66), which writes the target in place, so the link survives a refresh. No test ran a real refresh through a link.
- `readlink AGENTS.md` prints `README.md`.
- `git status` shows no change to `src/` and no change to the LongMemEval-V2 deletions.

## Decision Log

| # | Question | User's answer | Effect |
|---|----------|---------------|--------|
| 1 | How does the eval put facts into memory? | Two real sessions | R5 added: seeding through the `pi_context` tool. |
| 2 | Which cases must the eval cover? | Present, absent, superseded, adjacent | R6, R7 added. |
| 3 | How does the eval score an answer? (first answer) | Any one keyword, like pi-memory | Conflicts with case 2. I explained the conflict. |
| 4 | How many runs and which model? | 3 runs, model from env | R9, R10 added. |
| 5 | How does scoring work for each case type? | Hybrid | R8 added. Replaces the answer to question 3. |
| 6 | What are the entry point and the opt-in rule? | `npm run eval:recall` with opt-in | R1, R2 added. |
| 7 | How large is the fact corpus? | About 24 questions, 6 per case type | R6 added. |
| 8 | Which of these must the plan exclude? | LongMemEval-V2 deletions, CI workflow, coding tasks, changes to `src/` | Four non-goals and one constraint added. |
| 9 | How does the script choose the model, given that a temporary agent directory has no `settings.json`? | Require PI_EVAL_MODEL | R10 replaced: required variable in `provider/id` form. `PI_EVAL_PROVIDER` removed. |
| 10 | How does the isolated pi process get your login? | "Use the pi with OpenAI subscription", then "Symlink auth.json" | R15 added. The constraint about the subscription login added. The manual check added to Done Criteria. |
| 11 | How does the script score an adjacent question? | Same as absent | R8 changed: `adjacent` uses the abstention rule. |
| 12 | What happens when session 1 fails to record a fact? | Ask anyway, count a miss | R14 added. R11 extended with the record rate. |
| 13 | Which module layout does the script use? | Split modules | Plan tasks follow the layout: `corpus.ts`, `score.ts`, `pi.ts`, `run.ts`, `report.ts` and the entry file. |
| 14 | How many facts does one seed session send? | One fact per session | Expected Behaviors row and cost constraint added. |
| 15 | Confirm the architecture? | Confirm architecture | R16 added (exact `pi` arguments, from the sketch). Step 5 starts. |
| 16 | (Planner clarification after the code check) What does the record rate count? | Not asked. The extension is meant to skip some facts. | R11 changed: the record rate is reported separately for question facts and distractor facts. The layout gets one more small module, `text.ts`, so that the corpus and the scoring share one token matcher. |
| 17 | (After planning) Add a step to update `AGENTS.md`. | "Add a step to update the AGENTS.md", then "Update README.md instead. Create a symlink to AGENTS.md" | The first request had a false premise: the repository has no `AGENTS.md`. R17 added: `AGENTS.md` is a symbolic link to `README.md`. Task 6 creates it. |
| 18 | (Review) Does the abstention list match a model that searched and found nothing? | Not asked. Review finding. | R8 unchanged. Task 2 adds `couldn't find`, `could not find`, `didn't find`, `did not find` and `not found` to the abstention phrases, because arm A otherwise loses `absent` and `adjacent` hits that arm B gets. |
