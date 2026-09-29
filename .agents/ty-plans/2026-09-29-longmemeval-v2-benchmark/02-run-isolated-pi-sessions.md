🤖
# Task 2: Run isolated Pi sessions

**Depends on:** [Task 1](01-assess-fit-and-select-data.md)

**Goal:** Start bounded, model-pinned Pi subprocesses and return final answers, usage, and memory-action evidence.

**Files:**

- Create: `scripts/longmemeval-v2/pi.ts`
- Create: `test/longmemeval-v2-pi.test.ts`
- Create: `test/fixtures/fake-benchmark-pi.ts`

**Reuses:** `runPiSession(sessionFile: string, stdoutPath: string, stderrPath: string, prompt: string): Promise<PiRun>`, `parseJsonLines(filePath: string): { events: JsonObject[]; valid: boolean }`, `textAnswer(events: JsonObject[]): { text: string; message: JsonObject | null }`, and `correlatedToolCalls(events: JsonObject[]): CorrelatedToolCall[]` in `scripts/two-session-demo.ts` show the existing subprocess and event pattern. These functions are private to the demo; use the pattern without moving or changing the demo. `resolveProject(cwd: string, agentDir: string, config: ContextConfig): Promise<ProjectResolution>` in `src/project.ts` uses Git identity plus agent directory for shared memory. Pi 0.87.1 [CLI](https://github.com/earendil-works/pi) supports `-ne` with explicit `-e`, `--session`, `--mode json`, `--provider`, `--model`, `--thinking`, `--tools`, and `--no-tools`.

**Precondition:** Task 1 is complete. A caller must supply a freshly initialized, otherwise empty Git workspace for each run/domain and unique output files per session. The selected Luna/Sol model must be visible in `pi --list-models` and have working authentication; do not copy credentials into the fixture or logs.

**Site conditions:** pi-context is an opt-in tool: the model chooses whether to call `record`, `search`, and `read`. It inserts bundled guidance in `before_agent_start` (`src/extension.ts`, `createPiContextExtension`). Separate sessions with the same Git common directory and agent directory share memory; history text must not be in the question session transcript. The control receives the question only, has no plugin, and pays no ingestion cost. Pi JSON mode can exit zero after an assistant `error` or `aborted` result; `agent_settled` and the final message must also be checked. Pi JSONL `message_end.message.usage` is final per assistant response; `message_update.usage` is cumulative within that response and must not be added. Tool results can carry separate nested usage. The model field and reasoning setting must match between modes; treat an actual provider/model mismatch as failure, not a valid comparison.

## Steps

1. Export `type UsageTotals` with input, output, cacheRead, cacheWrite, totalTokens, and nullable reported USD; export `type PiSessionInput` with `cwd`, `sessionFile`, `stdoutPath`, `stderrPath`, `prompt`, `model`, `thinking`, `mode: 'memory' | 'control'`, `extensionPath`, `timeoutMs`, and `maxStdoutBytes`. Export `runPiSession(input: PiSessionInput): Promise<PiSessionResult>` with answer, usage, tool actions, actual model identity, and completed session metadata. Require a fully qualified `openai-codex/<Luna-or-Sol-id>` and an allowed thinking level. `test/fixtures/fake-benchmark-pi.ts` may supply a test-only executable path through `PiSessionInput`.
2. Spawn `pi` with `shell: false`, `--mode json`, a unique `--session` file, `--provider openai-codex`, the exact `--model` and `--thinking`, and `-ne -ns -np -nc`. For memory mode add `-e <absolute-package-root> --tools pi_context`; for control use `--no-tools` with no extension. Do not load unrelated global resources. Write private JSONL and stderr logs with 0600 permissions in a 0700 run directory. Bound output bytes and wall time; consume stdout continuously.
3. Parse newline-delimited JSON by LF only. Require valid JSONL, successful process exit, `agent_settled`, a final nonempty assistant answer, no error/abort stop reason, and expected model identity. Sum final `message_end` assistant usage once per message; add separately reported nested tool usage once when present. Pair pi_context actions by `toolCallId` and mark write/retrieval failures, `PROJECT_NOT_CONFIGURED`, quota errors, and guidance conflicts invalid. Return errors with stage/session identifiers. Do not log authorization headers or provider credentials.
4. Test both argument vectors, two fresh session files with one shared Git workspace, failure despite exit zero, malformed events, log overflow, timeout, absent usage, cumulative-update double counting, and no plugin call in control. Mock the subprocess; `npm test` must not call a provider.

## Acceptance

- [ ] A memory invocation includes `-e` and `--tools pi_context`; a control invocation includes no explicit extension and `--no-tools`.
- [ ] A memory answer run can use a new session file in the same Git workspace without inheriting history messages.
- [ ] `node --experimental-strip-types --test test/longmemeval-v2-pi.test.ts` → all offline subprocess and usage checks pass.
