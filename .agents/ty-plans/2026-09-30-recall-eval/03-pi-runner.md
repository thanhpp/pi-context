🤖 # Task 3: Pi process runner

**Depends on:** None

**Goal:** Create `pi.ts`, which builds the `pi` arguments for each arm, runs one `pi` process with a timeout, and parses its JSON-lines output, with a fake `pi` fixture and tests.

**Files:**

- Create: `scripts/eval-recall/pi.ts`
- Create: `test/fixtures/fake-pi-process.ts`
- Create: `test/eval-recall-pi.test.ts`

**Reuses:** None. The functions `spawn` and `execFile` come from `node:child_process`. `scripts/two-session-demo.ts` has a similar runner (`runPiSession`) but exports nothing and starts `main()` when imported, so copy the pattern and do not import the file. Do not edit `scripts/two-session-demo.ts`.

**Precondition:** None.

**Site conditions:**

Repository conventions (apply to every file in this task):

- TypeScript, ES modules, Node 22.19 or later. Files run with `node --experimental-strip-types`. There is no build step.
- `npm run check` runs `tsc --noEmit` on `src/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`. The compiler options include `strict` and `erasableSyntaxOnly`. Do not use `enum`, `namespace` or constructor parameter properties. Import local files with the `.ts` extension.
- Tests use `node:test` and `node:assert/strict`. `npm test` runs `node --experimental-strip-types --test test/*.test.ts`.
- Add no dependency. Write no comment unless it states an invariant. Use descriptive names.
- The working tree has uncommitted deletions and edits that are not part of this task. Do not restore, stage or revert them. The files `test/fixtures/fake-benchmark-pi.ts` and `test/fixtures/fake-judge-pi.ts` are unused leftovers. Do not edit or delete them.

Facts about the `pi` command (version 0.87.1, checked with `pi --help` and the package documentation):

- `-p <prompt>` runs the prompt without a terminal UI. `--mode json` writes JSON-lines events to stdout. Each line is one JSON object that ends with a line feed (LF).
- `-ne` disables extension discovery (explicit `-e` paths still load). `-ns` disables skills. `-np` disables prompt templates. `-nc` disables `AGENTS.md` and `CLAUDE.md` discovery. `--offline` disables startup network operations. `--no-session` does not save a session. `--model <provider/id>` selects the model. `-e <path>` loads an extension from a file or a directory. `--tools pi_context` allows only the tool `pi_context`. `--no-tools` disables all tools.
- The environment variable `PI_CODING_AGENT_DIR` sets the agent directory. `pi` reads `auth.json` from it, and the extension `pi-context` stores memory under it.
- There is no flag for the working directory. The process working directory decides the project.
- Events that this task reads:
  - `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}`. The answer is the text of the last assistant `message_end` event whose text blocks are not empty after `trim`. Join the text blocks with a line feed.
  - `{"type":"tool_execution_start","toolCallId":"...","toolName":"pi_context","args":{"action":"record"}}` and `{"type":"tool_execution_end","toolCallId":"...","toolName":"pi_context","result":{"content":[...],"details":{"ok":true,"action":"record"}},"isError":false}`. The field `isError` is at the top level of the event, beside `result` (`pi-agent-core/dist/agent-loop.js` lines 613-618). The extension also puts `isError: true` inside `result` when its envelope has `ok: false` (`src/extension.ts` line 274). A successful `record` call is a `tool_execution_end` event whose `toolCallId` matches a `tool_execution_start` event with `toolName` equal to `pi_context` and `args.action` equal to `record`, where `result.details.ok` is `true`, `result.details.action` is `record`, the event field `isError` is not `true`, and `result.isError` is not `true`.
  - `{"type":"agent_settled"}` means that `pi` has no more work. A run without this event is not complete.
- A final assistant response with the stop reason `error` or `aborted` makes `pi` exit with a non-zero code.

`pi.ts` exports exactly these names:

```ts
export type Arm = 'extension' | 'control';
export type CallStatus = 'ok' | 'timeout' | 'failed';
export interface PiCallInput {
  cwd: string;
  agentDir: string;
  prompt: string;
  model: string;
  arm: Arm;
  extensionPath: string;
  timeoutMs: number;
  executable?: string;
  executableArgs?: readonly string[];
}
export interface PiCallResult { status: CallStatus; answer: string; recordCalls: number }
export interface ParsedSession { valid: boolean; settled: boolean; answer: string; recordCalls: number }
export function buildPiArguments(input: PiCallInput): string[]
export function parseSessionOutput(stdout: string): ParsedSession
export async function runPi(input: PiCallInput): Promise<PiCallResult>
export function killLivePiProcesses(): void
```

Required behavior:

- `buildPiArguments` returns exactly this array. The prompt is the last element.
  - Arm `extension`: `['-ne', '-ns', '-np', '-nc', '--offline', '--no-session', '--mode', 'json', '--model', <model>, '-e', <extensionPath>, '--tools', 'pi_context', '-p', <prompt>]`.
  - Arm `control`: `['-ne', '-ns', '-np', '-nc', '--offline', '--no-session', '--mode', 'json', '--model', <model>, '--no-tools', '-p', <prompt>]`.
- `parseSessionOutput` splits the text on `\n`. It removes one trailing `\r` from each line and ignores the last segment when it is empty. It returns `valid: false` when the text is empty, when any other line is empty, or when any line is not a JSON object. When `valid` is `false`, the other fields are `false`, `false`, `''` and `0`. When `valid` is `true`, `settled` is `true` if an `agent_settled` event exists, `answer` is the text defined above (or `''`), and `recordCalls` is the number of successful `record` calls defined above.
- `runPi` starts the process with `spawn(input.executable ?? 'pi', [...(input.executableArgs ?? []), ...buildPiArguments(input)], { cwd: input.cwd, shell: false, windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: input.agentDir }, stdio: ['ignore', 'pipe', 'pipe'] })`. The value of `PI_CODING_AGENT_DIR` from the parent environment is always replaced by `input.agentDir`.
- `runPi` collects stdout in memory. If stdout exceeds 16 MiB (`16 * 1024 * 1024` bytes), `runPi` kills the process with `SIGKILL` and the status is `failed`. `runPi` reads and discards stderr (`child.stderr.resume()`).
- After `input.timeoutMs` milliseconds, `runPi` kills the process with `SIGKILL` and the status is `timeout`. `runPi` never retries.
- The status is `failed` when the process cannot start, when the exit code is not 0, when stdout is over the limit, when `parseSessionOutput` returns `valid: false`, or when it returns `settled: false`. Otherwise the status is `ok`.
- The result has `answer` and `recordCalls` from `parseSessionOutput` only when the status is `ok`. For `timeout` and `failed`, the result has `answer: ''` and `recordCalls: 0`.
- `runPi` resolves exactly once. It clears the timer when the process ends. It keeps every running child process in a module-level set. `killLivePiProcesses` sends `SIGKILL` to each child in the set.

Fake process fixture `test/fixtures/fake-pi-process.ts` (a Node script that acts as `pi`):

- It reads its arguments with `process.argv.slice(2)`. The prompt is the element after `-p`.
- It writes the file `fake-pi.capture.json` into its working directory. The content is `{"args": <all arguments>, "agentDir": <value of process.env.PI_CODING_AGENT_DIR, or null>}`.
- It prints JSON-lines events to stdout, one JSON object per line, based on the prompt:
  - `fixture:ok` prints `{"type":"session","id":"fake-session"}`, then an assistant `message_end` event with the text `fixture answer`, then `{"type":"agent_settled"}`, and exits with code 0.
  - `fixture:record` prints a `tool_execution_start` event (`toolCallId` `call-1`, `toolName` `pi_context`, `args` `{"action":"record"}`), then a `tool_execution_end` event (`result` `{"details":{"ok":true,"action":"record","data":{}}}` and the top-level field `"isError":false`), then the events of `fixture:ok`.
  - `fixture:record-failure` is like `fixture:record`, but `result` is `{"isError":true,"details":{"ok":false,"action":"record"}}` and the top-level field is `"isError":false`. This is the shape that the extension produces for a refused write.
  - `fixture:timeout` prints nothing and keeps running (`setInterval(() => {}, 1000)`).
  - `fixture:malformed` prints the line `{not-json}` and exits with code 0.
  - `fixture:exit-error` prints the events of `fixture:ok` and exits with code 1.
  - `fixture:unsettled` prints the events of `fixture:ok` without the `agent_settled` event and exits with code 0.
- The tests start the fixture with `executable: process.execPath` and `executableArgs: ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/fake-pi-process.ts', import.meta.url))]`.

## Steps

1. Create `test/fixtures/fake-pi-process.ts` as specified above.
2. Create `scripts/eval-recall/pi.ts` as specified above.
3. Create `test/eval-recall-pi.test.ts`. Each test that starts a process creates a temporary directory for `cwd` and another for `agentDir` with `mkdtemp`, and removes them at the end.
4. Write these tests:
   - `buildPiArguments` returns the exact arrays for both arms.
   - `parseSessionOutput`: valid output gives the answer, `settled: true` and the count of successful `record` calls; an empty string gives `valid: false`; the line `{not-json}` gives `valid: false`; an empty line between two events gives `valid: false`; a `record` call with `result.details.ok: false` and top-level `isError: false` is not counted; a `record` call with `result.details.ok: true` and top-level `isError: true` is not counted; a `record` call for another tool name is not counted; output without `agent_settled` gives `settled: false`.
   - `runPi` with `fixture:ok`: status `ok`, answer `fixture answer`, `recordCalls` 0. The capture file has `agentDir` equal to the `agentDir` of the input, even when the test sets `process.env.PI_CODING_AGENT_DIR` to another value first (restore the value after the test). For the arm `extension`, the captured arguments contain `-e` and `pi_context`. For the arm `control`, they contain `--no-tools` and do not contain `-e`.
   - `runPi` with `fixture:record`: `recordCalls` is 1. With `fixture:record-failure`: `recordCalls` is 0 and the status is `ok`.
   - `runPi` with `fixture:timeout` and `timeoutMs: 300`: status `timeout`, `answer` is `''`.
   - `runPi` with `fixture:malformed`, `fixture:exit-error` and `fixture:unsettled`: status `failed` for each.
   - `runPi` with `executable: '/nonexistent/pi-binary'`: status `failed`.
   - `killLivePiProcesses()` does not throw when no process is running.
5. Run `npm run check` and the test file.

## Acceptance

- [ ] `npm run check` → exits with code 0.
- [ ] `node --experimental-strip-types --test test/eval-recall-pi.test.ts` → all tests pass.
- [ ] `grep -c "PI_CODING_AGENT_DIR" scripts/eval-recall/pi.ts` → prints 1 or more.
- [ ] `git status --short scripts/two-session-demo.ts test/fixtures/fake-benchmark-pi.ts test/fixtures/fake-judge-pi.ts` → prints nothing.
