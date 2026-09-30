🤖 # Recall Eval — Next Steps

> The code of all six tasks is done and checked. The paid check (step 7 of [README.md](README.md)) is not run. This guide tells the operator how to continue.

## Current state

- `npm run eval:recall` exists. Without `PI_CONTEXT_EVAL=1` and `PI_EVAL_MODEL`, it refuses to start and makes no `pi` call.
- `npm test` passes 176 of 176 tests and makes no model call.
- 6 real calls ran on 2026-09-30 with `openai-codex/gpt-6-sol`:
  - 3 calls of a smoke script: 1 seed, 1 question in arm A (`extension`) and 1 question in arm B (`control`). All returned `ok`.
  - 2 diagnostic calls. They show that the `pi_context` tool loads in arm A and that the parser counts a real `record` call.
  - 1 login check. The login worked after the calls.
- In the smoke seed, the model did not record the fact. The seed prompt is neutral and does not ask the model to record. One sample does not give a rate.
- No token refresh occurred during these calls. The link `auth.json` has not been tested during a refresh.

## Before each paid run

1. Stop all other `pi` sessions that use the same login. The eval locks the link path `<temporary agent directory>/auth.json.lock`, not your real `auth.json`.
2. Select the approved executable before `npm run`: `export PI_EVAL_EXECUTABLE="$(command -v pi)"`. Check that `"$PI_EVAL_EXECUTABLE" --version` prints `0.99.1`. The operator approved this version instead of `0.87.1`.
3. Check the login: `"$PI_EVAL_EXECUTABLE" -p "say ok" --model openai/gpt-6-sol`. The command must answer and must not ask for a login.
4. Use `openai/gpt-6-sol`, as the operator selected. Use the same model for every run that you want to compare.

npm puts `node_modules/.bin` first in `PATH`. Without an explicit executable, the repository-local pi `0.87.1` takes precedence over the shell pi `0.99.1`. The earlier single evaluation failed all 82 calls with the local executable. An isolated local call reported `No API key found for openai.` The shell executable passed the same isolated control call. Set `PI_EVAL_EXECUTABLE` to prevent this mismatch.

## Step 1: one paid run

One run makes about 82 `pi` calls: 34 seed calls, 24 calls in arm A and 24 calls in arm B. The calls are sequential. Each call can take up to 120 s before it times out.

Run this command in the repository root:

```sh
PI_CONTEXT_EVAL=1 EVAL_RUNS=1 PI_EVAL_MODEL=openai/gpt-6-sol \
  npm run --silent eval:recall > ~/pi-context-eval-$(date +%Y%m%d-%H%M).txt
```

- The report goes to standard output, so the command above saves it in a file.
- The progress lines go to standard error, so you see them in the terminal. There is one line at the start of each phase, for example `run 1: seed, 34 calls`.
- `--silent` keeps the `npm` banner out of the report file.
- If you must stop the run, press Ctrl+C. The script stops the live `pi` processes, removes its temporary directories and exits with code 130.

## Step 2: checks after the run

1. Check the login: `"$PI_EVAL_EXECUTABLE" -p "say ok" --model openai/gpt-6-sol`. This is the first real test of the link during a possible token refresh. If `pi` asks for a login, log in again and record the problem in this plan folder.
2. Check that no temporary directory remains: `ls /tmp | grep pi-context-eval` must print nothing.
3. Check that the report has these parts:
   - a table with the rows `present`, `superseded`, `absent`, `adjacent` and `total`;
   - the line `seed record rate:`;
   - the lines `extension answers:` and `control answers:`.

## Step 3: read the report

The table has these columns: `case type`, `extension`, `control`, `difference`, `extension range`, `control range`. Each case type has 6 questions in each run. `difference` is the extension rate minus the control rate, in percentage points.

Arm B has no memory. Thus arm B must abstain on every question, and these results are expected for arm B:

| Case type | Expected result of arm B | What arm A shows |
|---|---|---|
| `present` | Near 0 %. No keyword is known. | Whether the extension recalls a stored fact. |
| `superseded` | Near 0 %. | Whether the extension gives the newer value and not the older value. |
| `absent` | Near 100 %. The model abstains. | Whether the extension invents a fact that was never stored. |
| `adjacent` | Near 100 %. | Whether the extension gives a fact of another subsystem as the answer. |

Do not use the `total` row alone. A positive `difference` on `present` and `superseded` and a negative `difference` on `absent` and `adjacent` can cancel out in `total`.

A good result for the extension is:

- a high `extension` rate on `present` and `superseded`;
- an `extension` rate on `absent` and `adjacent` that is near the `control` rate.

## Step 4: find the cause of a low score

Use the report lines in this order:

1. If `timeouts` or `failures` is more than 0, look at those calls first. A timed-out or failed question counts as a miss.
2. If the `seed record rate` for question facts is low, the model did not store the facts. Then the `present` and `superseded` scores are low because of the write path. This is a result about the extension, for example its tool description or its skill text. It is not a fault in the eval script.
3. If the `seed record rate` for question facts is high but `present` is low, the search path or the read path of the extension is the probable cause.
4. If `superseded` is low but `present` is high, the extension probably returns the older fact beside the newer fact.
5. If `absent` or `adjacent` is much lower in arm A than in arm B, the extension causes false answers.

A low `seed record rate` for distractor facts is not an error. The extension is meant to skip some facts.

## Step 5: the full run

Do the full run only when step 1 has 0 timeouts and 0 failures, or when you know their cause.

```sh
PI_CONTEXT_EVAL=1 PI_EVAL_MODEL=openai/gpt-6-sol \
  npm run --silent eval:recall > ~/pi-context-eval-$(date +%Y%m%d-%H%M).txt
```

- The default is 3 runs, about 246 `pi` calls.
- The `extension range` and `control range` columns show the lowest and highest rate over the runs. A wide range means that one run is not enough to compare two versions of the extension.
- Every run starts with an empty memory.

## Error messages

| Message | Cause | Action |
|---|---|---|
| `PI_CONTEXT_EVAL=1 is required because this script makes paid model calls.` | `PI_CONTEXT_EVAL` is not `1`. | Set `PI_CONTEXT_EVAL=1`. |
| `PI_EVAL_MODEL is required in provider/id form, for example openai-codex/<model id>.` | `PI_EVAL_MODEL` is not set or has no slash. | Set `PI_EVAL_MODEL=openai/gpt-6-sol`. |
| `EVAL_RUNS must be a positive integer.` | `EVAL_RUNS` is `0`, negative or not a number. | Remove `EVAL_RUNS` or set a number from 1. |
| `pi is not on the PATH. Install pi and retry.` | No explicit executable is set, and the process cannot find `pi`. | Set `PI_EVAL_EXECUTABLE` to the approved executable's absolute path. |
| `PI_EVAL_EXECUTABLE must be an absolute path to the pi executable.` | The explicit path is empty or relative. | Set an absolute path. |
| `Cannot run pi executable <path>. Check PI_EVAL_EXECUTABLE and retry.` | The explicit executable is missing or its version command fails. | Check the path and its execute permission. |
| `The login file <path> does not exist. Log in with pi first.` | `<agent directory>/auth.json` does not exist. | Log in with `pi`. |
| `GIT_INIT_FAILED` | `git init` failed in the temporary workspace. | Check that `git` is on the path and that `/tmp` is writable. |

## Limits of the current script

- The report does not show which question missed. To find a miss, you must add per-question output. That change needs a new plan.
- The report does not show token counts or costs.
- The script writes no result file. Save the standard output yourself, as the commands above do.
- The seed prompt never asks the model to record. The `seed record rate` thus measures what the model does by itself.
- No CI job runs the eval, because every run makes paid calls.

## Possible next work

These items are outside the current plan. Each item needs a new plan before code changes.

- Add per-question output, for example one line per question with the arm, the case ID and the hit, to find the cause of misses.
- Add token counts and costs from the `pi` usage data.
- Run the eval with a second model to see if the record rate depends on the model.
- If the `seed record rate` is low, change the tool description or the skill text of the extension, and then run step 1 again with the same model.
