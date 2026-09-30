🤖 # Task 6: Entry point, npm script, README section and AGENTS.md link

**Depends on:** [Task 4](04-report.md), [Task 5](05-run-orchestration.md)

**Goal:** Create the entry file `scripts/eval-recall.ts`, add the `eval:recall` npm script, add a README section, create `AGENTS.md` as a symbolic link to `README.md`, and test the refusal paths.

**Files:**

- Create: `scripts/eval-recall.ts`
- Create: `test/eval-recall-entry.test.ts`
- Modify: `package.json` (add one line to the `scripts` block)
- Modify: `README.md` (append one section at the end)
- Create: `AGENTS.md` (a symbolic link with the relative target `README.md`, not a file with its own text)

**Reuses:**

- `scripts/eval-recall/run.ts`: `readOptions(env: NodeJS.ProcessEnv, defaults: { packageRoot: string; realAgentDir: string }): ReadOptionsResult` where `ReadOptionsResult` is `{ ok: true; options: EvalOptions } | { ok: false; message: string }` and `EvalOptions` has the fields `runs`, `model`, `timeoutMs`, `packageRoot`, `realAgentDir`, `tmpRoot`, `executable`, `executableArgs`; `runEval(options: EvalOptions, log?: (line: string) => void): Promise<{ questions: QuestionOutcome[]; seeds: SeedOutcome[] }>`; `cleanupActiveIsolations(): void`.
- `scripts/eval-recall/pi.ts`: `killLivePiProcesses(): void`.
- `scripts/eval-recall/report.ts`: `formatReport(input: { model: string; runs: number; questions: readonly QuestionOutcome[]; seeds: readonly SeedOutcome[] }): string`.
- `getAgentDir` from `@earendil-works/pi-coding-agent`. It returns the operator's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). `scripts/two-session-demo.ts` imports it the same way: `import { getAgentDir } from '@earendil-works/pi-coding-agent';`.
- The line `PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')` in `scripts/two-session-demo.ts` shows how to find the repository root from a file in `scripts/`.

**Precondition:** None.

**Site conditions:**

Repository conventions (apply to every file in this task):

- TypeScript, ES modules, Node 22.19 or later. Files run with `node --experimental-strip-types`. There is no build step.
- `npm run check` runs `tsc --noEmit` on `src/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`. The compiler options include `strict` and `erasableSyntaxOnly`. Do not use `enum`, `namespace` or constructor parameter properties. Import local files with the `.ts` extension.
- Tests use `node:test` and `node:assert/strict`. `npm test` runs `node --experimental-strip-types --test test/*.test.ts`.
- Add no dependency. Write no comment unless it states an invariant. Use descriptive names.
- Do not change any file under `src/`.
- `package.json` and `README.md` have uncommitted edits from the operator (the operator removed the LongMemEval-V2 lines). Keep those edits. Add only the lines that this task names. The working tree also has uncommitted deletions of the old LongMemEval-V2 files. Do not restore, stage or revert them.
- The `scripts` block of `package.json` is now: `"check": "tsc --noEmit"`, `"test": "node --experimental-strip-types --test test/*.test.ts"`, `"demo": "node --experimental-strip-types scripts/two-session-demo.ts"`.
- The top-level headings of `README.md` are, in order: `## Use`, `## Configuration`, `## Retention and cleanup`, `## Trust and prompt behavior`, `## Deterministic checks and live demonstration`. The new section goes after the last one.

Required behavior of `scripts/eval-recall.ts` (it exports nothing and runs `main` at the top level, like `scripts/two-session-demo.ts`):

1. It computes `packageRoot` (the repository root) and calls `readOptions(process.env, { packageRoot, realAgentDir: getAgentDir() })`. When the result has `ok: false`, it writes `message` to stderr and exits with code 1. It makes no `pi` call and creates no directory.
2. It checks that `pi` is on the path with `spawnSync('pi', ['--version'], { encoding: 'utf8', timeout: 20000 })`. When the result has an `error` or a status other than 0, it writes `pi is not on the PATH. Install pi and retry.` to stderr and exits with code 1.
3. It checks that `resolve(options.realAgentDir, 'auth.json')` exists (`existsSync`). When it does not exist, it writes `The login file <that path> does not exist. Log in with pi first.` to stderr and exits with code 1.
4. It registers handlers for `SIGINT` and `SIGTERM` with `process.once`. Each handler calls `killLivePiProcesses()`, then `cleanupActiveIsolations()`, then `process.exit(130)` for `SIGINT` and `process.exit(143)` for `SIGTERM`.
5. It calls `runEval(options, line => console.error(line))`, then prints `formatReport({ model: options.model, runs: options.runs, questions, seeds })` to stdout with `console.log`. The exit code is 0 after a complete report, whatever the scores are.
6. If `runEval` throws, it writes the error message to stderr and exits with code 1.

The step order matters: the checks 1 to 3 run before any temporary directory exists.

README section. Append this text at the end of `README.md`, after one empty line. The outer fence below has four backticks because the text contains its own fenced block:

````markdown
## Recall evaluation

`npm run eval:recall` measures whether a model recalls project facts with this extension and without it. The script makes paid model calls, so it refuses to start unless `PI_CONTEXT_EVAL=1` is set.

| Variable | Meaning |
|---|---|
| `PI_CONTEXT_EVAL` | Must be `1`. |
| `PI_EVAL_MODEL` | Required. The model in `provider/id` form, for example `openai-codex/<model id>`. |
| `EVAL_RUNS` | The number of runs. The default is 3. |

```sh
PI_CONTEXT_EVAL=1 PI_EVAL_MODEL=openai-codex/<model id> EVAL_RUNS=1 npm run eval:recall
```

Each run creates a temporary agent directory and a temporary Git workspace. The script never reads or writes your memory in `~/.pi`. The temporary agent directory holds a symbolic link named `auth.json` that points to your real `auth.json`, so `pi` can use your login. The script removes the link at the end and never removes the target. A token refresh during the run writes the new token into your real `auth.json` through the link. Do not run another `pi` session with the same login during the run, because the eval locks the link path and not your real file. After the first run, check that your login still works: `pi -p "say ok" --model <provider/id>`.

Each run sends 34 facts, one fact in each `pi` session, and then asks 24 questions in two arms: with this extension, and with no extension and no tools. The question types are `present`, `superseded`, `absent` and `adjacent`. Scoring uses keywords and needs no judge model. With the defaults, the script makes about 246 `pi` calls.

The report shows the hit rate of each arm for each question type, the lowest and highest rate over the runs, the rate at which the seed sessions recorded a fact, and the number of timeouts and failures. The script reports scores and asserts no threshold.
````

## Steps

1. Create `scripts/eval-recall.ts` as specified above.
2. Edit `package.json`: add the line `"eval:recall": "node --experimental-strip-types scripts/eval-recall.ts"` after the `"demo"` line of the `scripts` block, and add the comma after the `"demo"` line. Change no other line.
3. Append the README section above to `README.md`. Change no other line.
4. In the repository root, run `ln -s README.md AGENTS.md`. The target must be the relative path `README.md`, not an absolute path. Do not write text into `AGENTS.md`.
5. Create `test/eval-recall-entry.test.ts`. It runs the entry file with `spawnSync(process.execPath, ['--experimental-strip-types', <absolute path of scripts/eval-recall.ts>], { env, encoding: 'utf8', timeout: 60000 })`, with an explicit `env` object and never the parent environment. The `env` of every test sets `HOME` and `PI_CODING_AGENT_DIR` to temporary directories, because the entry imports `@earendil-works/pi-coding-agent` at the top level and that import may read the agent directory. Every test creates a temporary directory for `TMPDIR` and asserts afterwards that `readdirSync` of that directory returns an empty array (no directory was created). Write these tests:
   - `env` has no `PI_CONTEXT_EVAL`: exit code 1, stderr contains `PI_CONTEXT_EVAL=1`.
   - `PI_CONTEXT_EVAL=1` and no `PI_EVAL_MODEL`: exit code 1, stderr contains `PI_EVAL_MODEL`.
   - `PI_CONTEXT_EVAL=1`, `PI_EVAL_MODEL=fake/model`, and `PATH` set to an empty temporary directory: exit code 1, stderr contains `pi is not on the PATH`.
   - The same variables, `PATH` set to a temporary directory that holds an executable file named `pi` with the content `#!/bin/sh` and `exit 0` (mode 0755), and `PI_CODING_AGENT_DIR` set to an empty temporary directory (with no `auth.json`): exit code 1, stderr contains `auth.json`. Skip this test when `process.platform` is `win32` (`{ skip: process.platform === 'win32' }`).
   - `package.json` has the script `eval:recall` with the value `node --experimental-strip-types scripts/eval-recall.ts` (read the file with `JSON.parse`).
6. Run `npm run check`, `npm test` and the commands in the acceptance list.

## Acceptance

- [ ] `npm run check` → exits with code 0.
- [ ] `npm test` → all tests pass and no model call happens.
- [ ] `npm run eval:recall; echo "exit=$?"` → prints a message that names `PI_CONTEXT_EVAL=1` and `exit=1`.
- [ ] `PI_CONTEXT_EVAL=1 npm run eval:recall; echo "exit=$?"` → prints a message that names `PI_EVAL_MODEL` and `exit=1`.
- [ ] `git diff -U0 package.json` → the only added line that this task made is the `"eval:recall"` line (the comma change on the `"demo"` line is allowed). The operator's earlier edits remain.
- [ ] `readlink AGENTS.md` → prints `README.md`.
- [ ] `git status --short AGENTS.md` → prints `?? AGENTS.md`.
- [ ] `npm pack --dry-run --json --ignore-scripts | grep -c AGENTS.md` → prints `0`.
- [ ] `git status --short src/` → prints nothing.
