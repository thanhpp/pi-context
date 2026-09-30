🤖 # Task 5: Run orchestration

**Depends on:** [Task 1](01-corpus-and-text.md), [Task 2](02-score.md), [Task 3](03-pi-runner.md), [Task 4](04-report.md)

**Goal:** Create `run.ts`, which reads and checks the options, isolates every run in temporary directories, seeds memory in real `pi` sessions, asks the questions in both arms, and cleans up, with a corpus-aware fake `pi` and tests.

**Files:**

- Create: `scripts/eval-recall/run.ts`
- Create: `test/fixtures/fake-recall-pi.ts`
- Create: `test/eval-recall-run.test.ts`

**Reuses:** The modules that earlier tasks created, with these exact exports:

- `scripts/eval-recall/corpus.ts`: `CASES: EvalCase[]`, `allFacts(): SeedFact[]`, and the types `EvalCase` (`{ id, type, question, facts: Fact[], expectedKeywords, forbiddenKeywords }`), `Fact` (`{ id, text, stage: 'base' | 'update' }`) and `SeedFact` (`{ fact: Fact; kind: 'question' | 'distractor' }`). `allFacts()` returns 34 entries: all `base` facts of the cases, then the 10 distractors, then all `update` facts.
- `scripts/eval-recall/score.ts`: `scoreAnswer(evalCase: EvalCase, answer: string): boolean`.
- `scripts/eval-recall/pi.ts`: `runPi(input: PiCallInput): Promise<PiCallResult>`, `killLivePiProcesses(): void`, and the types `Arm` (`'extension' | 'control'`), `CallStatus` (`'ok' | 'timeout' | 'failed'`), `PiCallInput` (`{ cwd, agentDir, prompt, model, arm, extensionPath, timeoutMs, executable?, executableArgs? }`) and `PiCallResult` (`{ status, answer, recordCalls }`).
- `scripts/eval-recall/report.ts`: the types `QuestionOutcome` (`{ runIndex, arm, caseId, caseType, hit, status }`) and `SeedOutcome` (`{ runIndex, factId, kind, recorded, status }`).

**Precondition:** None.

**Site conditions:**

Repository conventions (apply to every file in this task):

- TypeScript, ES modules, Node 22.19 or later. Files run with `node --experimental-strip-types`. There is no build step.
- `npm run check` runs `tsc --noEmit` on `src/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`. The compiler options include `strict` and `erasableSyntaxOnly`. Do not use `enum`, `namespace` or constructor parameter properties. Import local files with the `.ts` extension.
- Tests use `node:test` and `node:assert/strict`. `npm test` runs `node --experimental-strip-types --test test/*.test.ts`.
- Add no dependency. Write no comment unless it states an invariant. Use descriptive names.
- Do not change any file under `src/`. The working tree has uncommitted deletions and edits that are not part of this task. Do not restore, stage or revert them.

Facts about `pi` and `pi-context` that this task needs:

- `pi-context` accepts any directory inside a Git repository as a project. It needs no configuration file for this. The memory is stored under `<agent directory>/memory/<project id>`. The project id comes from the Git common directory, so every session in one workspace shares memory, and a new workspace has an empty memory.
- `pi` reads its login from `<agent directory>/auth.json`. A new agent directory has no login, so the run needs a symbolic link named `auth.json` in the agent directory that points to the operator's real `auth.json`. The operator's agent directory is the value that `getAgentDir()` returns (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). The caller passes it as `options.realAgentDir`.
- `fs.rm(path, { recursive: true, force: true })` removes a symbolic link and never follows it to the target.
- `pi` writes `auth.json` with `writeFileSync` on the link path, so a token refresh rewrites the real file in place and the link stays. `pi` locks the file with `realpath: false`, so the lock directory `<agentDir>/auth.json.lock` is inside the isolation root and the cleanup removes it.
- A temporary agent directory has no `settings.json`, so `pi` defaults to the provider `google`. The model must therefore always come from `PI_EVAL_MODEL`.

`run.ts` exports exactly these names:

```ts
export interface EvalOptions {
  runs: number;
  model: string;
  timeoutMs: number;
  packageRoot: string;
  realAgentDir: string;
  tmpRoot: string;
  executable: string;
  executableArgs: readonly string[];
}
export type ReadOptionsResult = { ok: true; options: EvalOptions } | { ok: false; message: string };
export interface Isolation { root: string; agentDir: string; workspace: string }
export interface EvalResult { questions: QuestionOutcome[]; seeds: SeedOutcome[] }
export function buildSeedPrompt(factText: string): string
export function buildAnswerPrompt(question: string): string
export function readOptions(env: NodeJS.ProcessEnv, defaults: { packageRoot: string; realAgentDir: string }): ReadOptionsResult
export async function prepareIsolation(options: Pick<EvalOptions, 'tmpRoot' | 'realAgentDir'>): Promise<Isolation>
export async function removeIsolation(isolation: Isolation): Promise<void>
export function cleanupActiveIsolations(): void
export async function runEval(options: EvalOptions, log?: (line: string) => void): Promise<EvalResult>
```

Required behavior:

- `buildSeedPrompt(factText)` returns `Project update: ` + `factText` + ` Confirm in one short sentence.` The prompt never contains the words memory, remember, record or tool.
- `buildAnswerPrompt(question)` returns `Answer from what you know about this project. If you do not know, say "I don't know".` + two line feeds + `Question: ` + `question`.
- `readOptions(env, defaults)` checks these rules in this order and returns `{ ok: false, message }` for the first failure:
  1. `env.PI_CONTEXT_EVAL` must equal `1`. Message: `PI_CONTEXT_EVAL=1 is required because this script makes paid model calls.`
  2. `env.PI_EVAL_MODEL` must match the pattern `^[^/\s]+/\S+$` (provider, slash, model id). Message: `PI_EVAL_MODEL is required in provider/id form, for example openai-codex/<model id>.`
  3. `env.EVAL_RUNS`, when it is set and not empty, must match `^[1-9][0-9]*$`. The default is 3. Message: `EVAL_RUNS must be a positive integer.`
  On success it returns `runs`, `model`, `packageRoot` and `realAgentDir` from the inputs, `timeoutMs: 120000`, `tmpRoot: os.tmpdir()`, `executable: 'pi'` and `executableArgs: []`.
- `prepareIsolation` creates a new directory with `mkdtemp(join(options.tmpRoot, 'pi-context-eval-'))` (`root`). It creates `<root>/agent` (`agentDir`) and `<root>/workspace` (`workspace`). It creates the symbolic link `<agentDir>/auth.json` that points to the absolute path `resolve(options.realAgentDir, 'auth.json')`. A relative target would break inside the temporary directory when `PI_CODING_AGENT_DIR` is a relative path. It runs `git init -q` in the workspace with `spawnSync('git', ['init', '-q'], { cwd: workspace, env, timeout: 10000 })`, where `env` is a copy of `process.env` without the keys that start with `GIT_`. If `git` fails, it removes the root and throws `Error('GIT_INIT_FAILED')`. It adds `root` to a module-level set of active roots before it returns.
- `removeIsolation` removes `root` with `rm(root, { recursive: true, force: true })` and removes it from the active set. It never touches the target of the link.
- `cleanupActiveIsolations` removes every root in the active set synchronously with `rmSync(root, { recursive: true, force: true })` and empties the set.
- `runEval` runs `options.runs` runs, numbered from 1. Every run does the following in this order and always removes its isolation in a `finally` block, also when an error is thrown:
  1. `prepareIsolation`.
  2. Seed: for each entry of `allFacts()` in order, call `runPi` with `arm: 'extension'`, `prompt: buildSeedPrompt(entry.fact.text)`, `cwd` equal to the workspace, `agentDir`, `model`, `extensionPath: options.packageRoot`, `timeoutMs`, `executable` and `executableArgs` from the options. Push a `SeedOutcome` with `recorded: result.recordCalls >= 1`, the `kind` of the entry and the status of the result. The calls are sequential.
  3. Arm `extension`: for each case of `CASES` in order, call `runPi` with `arm: 'extension'` and `prompt: buildAnswerPrompt(case.question)`. Push a `QuestionOutcome` with `hit: result.status === 'ok' && scoreAnswer(case, result.answer)`. A question is asked even when its seed session recorded nothing.
  4. Arm `control`: the same as step 3 with `arm: 'control'`, in the same workspace and agent directory.
  5. `removeIsolation`.
- `runEval` calls `log` with one short line at the start of each phase: the run number, the phase name and the number of calls. `log` defaults to a function that does nothing.
- `runEval` never retries a call and never throws because a `pi` call failed or timed out.

Fake process fixture `test/fixtures/fake-recall-pi.ts` (a Node script that acts as `pi` and knows the corpus):

- It imports `CASES` and `allFacts` from `../../scripts/eval-recall/corpus.ts`.
- It reads `process.argv.slice(2)`. The prompt is the element after `-p`. The arm is `extension` when the arguments contain `-e`, otherwise `control`. The agent directory is `process.env.PI_CODING_AGENT_DIR`.
- For every call it appends one JSON line to `<agent directory>/fake-calls.jsonl` with these fields: `kind` (`seed` when the prompt starts with `Project update:`, otherwise `question`), `arm`, `id` (the fact ID for a seed call, the case ID for a question call), `agentDir`, `cwd` (`process.cwd()`) and `authLinkTarget` (the result of `readlinkSync` on `<agent directory>/auth.json`, or `null` when that call throws). When the environment variable `FAKE_CALLS_DIR` is set, it appends the same line to `<FAKE_CALLS_DIR>/fake-calls.jsonl` as well, because the run removes the agent directory.
- The store is the file `<agent directory>/fake-store.json`, a JSON array of stored fact IDs (missing file means empty).
- Seed call: it finds the entry of `allFacts()` whose `fact.text` the prompt contains. If the arm is `extension` and the fact ID is not in the comma-separated list `process.env.FAKE_RECORD_SKIP_FACT_IDS`, it adds the ID to the store and prints a successful `record` tool event pair. The answer text is `Noted.`
- Question call: it finds the case whose `question` the prompt contains. If the arm is `extension` and the case type is `present` or `superseded`, and the store holds at least one fact ID of the case, the answer is the text of the last stored fact of the case (the order of the `facts` array of the case). In every other situation the answer is `I don't know.`
- It prints these JSON-lines events: `{"type":"session","id":"fake-session"}`, the two `record` tool events when applicable (`tool_execution_start` with `toolCallId` `call-1`, `toolName` `pi_context`, `args` `{"action":"record"}`; `tool_execution_end` with the same ID and name, `result` `{"details":{"ok":true,"action":"record","data":{}}}` and the top-level field `"isError":false`), an assistant `message_end` event (`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"<answer>"}]}}`) and `{"type":"agent_settled"}`. It exits with code 0.
- The tests start it with `executable: process.execPath` and `executableArgs: ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/fake-recall-pi.ts', import.meta.url))]`.

## Steps

1. Create `test/fixtures/fake-recall-pi.ts` as specified above.
2. Create `scripts/eval-recall/run.ts` as specified above. Import `tmpdir` from `node:os` and `resolve` from `node:path`.
3. Create `test/eval-recall-run.test.ts`. Create a helper that makes a temporary `tmpRoot` directory and a temporary `realAgentDir` directory that contains a file `auth.json` with the content `{"marker":"real-login"}`, and returns `EvalOptions` with `runs`, `model: 'fake/model'`, `timeoutMs: 30000`, `packageRoot: '/unused'` and the fake `executable` and `executableArgs`.
4. Write these tests. Give every test that calls `runEval` the option `{ timeout: 180_000 }`.
   - `readOptions`, one assertion per rule: the environment without `PI_CONTEXT_EVAL` returns the first message; `PI_CONTEXT_EVAL=1` without a model returns the second message; the model `nomodel` and the model `a/` (no id) return the second message; `EVAL_RUNS` set to `0`, `abc` and `-1` returns the third message; a valid environment returns `runs: 3`, `timeoutMs: 120000`, `executable: 'pi'`, an empty `executableArgs`, and `runs: 5` when `EVAL_RUNS` is `5`. The first failing rule wins when several rules fail.
   - `buildSeedPrompt` and `buildAnswerPrompt` return the exact strings above. No fact text and no question of the corpus makes the seed prompt contain a word from the list memory, remember, record, tool (`containsToken` is not needed; use a case-insensitive regular expression with word boundaries).
   - `prepareIsolation` and `removeIsolation`: after `prepareIsolation`, the workspace contains a `.git` directory, `<agentDir>/auth.json` is a symbolic link whose target is `resolve(realAgentDir, 'auth.json')`, and `root` is inside `tmpRoot`. After `removeIsolation`, `root` does not exist, and the real `auth.json` still exists with the content `{"marker":"real-login"}`.
   - `cleanupActiveIsolations`: after `prepareIsolation` and then `cleanupActiveIsolations()`, `root` does not exist and the real `auth.json` still exists.
   - `runEval` with `runs: 2` and the fake process:
     - `seeds.length` is 68, and every seed outcome has `recorded: true` and status `ok`. Per run, 24 seed outcomes have kind `question` and 10 have kind `distractor`.
     - `questions.length` is 96 (24 questions, 2 arms, 2 runs). For arm `extension`, every outcome has `hit: true` (the fake answers stored facts, and abstains for `absent` and `adjacent`). For arm `control`, `hit` is `true` only for the case types `absent` and `adjacent` (24 hits of 48) and `false` for `present` and `superseded`.
     - The test sets `FAKE_CALLS_DIR` to a temporary directory before the run and restores the environment after the run. From the file `<FAKE_CALLS_DIR>/fake-calls.jsonl` the test checks: in each run, every seed call comes before every question call; in each run, every `update` fact seed call comes after every `base` fact seed call; the seed calls of a run are 34, the `extension` question calls are 24 and the `control` question calls are 24; the two runs used two different `agentDir` values and two different `cwd` values; every recorded `authLinkTarget` equals `resolve(realAgentDir, 'auth.json')`.
     - After the run, `tmpRoot` is empty (`readdir` returns an empty array) and the real `auth.json` still has its content.
   - `runEval` with `runs: 1` and `FAKE_RECORD_SKIP_FACT_IDS=present-region-fact`: the seed outcome for `present-region-fact` has `recorded: false` and status `ok`. All other question-kind seed outcomes have `recorded: true`. The question outcome of arm `extension` for `present-region` exists, has status `ok` and `hit: false`. All other arm `extension` outcomes for `present` cases have `hit: true`. Restore the environment after the test.
   - `runEval` with `runs: 1` and `executable: '/nonexistent/pi-binary'`: it resolves and does not throw; every seed outcome has `recorded: false` and status `failed`; every question outcome has `hit: false` and status `failed`; `tmpRoot` is empty afterwards.
5. Run `npm run check` and the test file. The file takes up to about 2 minutes because it starts about 250 short Node processes.

## Acceptance

- [ ] `npm run check` → exits with code 0.
- [ ] `node --experimental-strip-types --test test/eval-recall-run.test.ts` → all tests pass.
- [ ] `grep -n "GIT_" scripts/eval-recall/run.ts` → shows the code that removes the `GIT_` variables.
- [ ] `git status --short src/` → prints nothing.
