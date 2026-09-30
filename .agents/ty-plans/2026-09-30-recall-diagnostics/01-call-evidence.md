# Task 1: Call Evidence

**Depends on:** None

**Goal:** Add bounded process and `pi_context` tool-call evidence without changing benchmark outcomes.

**Files:**

- Modify: `scripts/eval-recall/pi.ts`
- Modify: `test/eval-recall-pi.test.ts`
- Modify: `test/fixtures/fake-pi-process.ts`

**Reuses:** `parseSessionOutput` in `scripts/eval-recall/pi.ts` parses pi JSONL events. `runPi` starts one pi process and decides its status, answer, and record count.

**Precondition:** None.

**Site conditions:** The current exported signatures are:

```ts
buildPiArguments(input: PiCallInput): string[]
parseSessionOutput(stdout: string): ParsedSession
runPi(input: PiCallInput): Promise<PiCallResult>
killLivePiProcesses(): void
```

`PiCallInput` contains `cwd`, `agentDir`, `prompt`, `model`, `arm`, `extensionPath`, and `timeoutMs`. It also has optional `executable` and `executableArgs` fields. `CallStatus` is `'ok' | 'timeout' | 'failed'`.

The process runner captures at most 16 MiB of stdout. It returns `timeout` when its timer fires. It returns `failed` for a nonzero exit, invalid JSONL, an unsettled session, a spawn error, or stdout overflow. It returns `ok` only for a zero exit with valid, settled output. It returns the last non-empty assistant answer. It counts only successful `pi_context` record calls. A record count needs a matching record start. Its end event must have `details.ok === true` and `details.action === 'record'`. Do not change these status, answer, or count rules.

The child currently inherits `process.env`. Diagnostic evidence must not copy that environment. It must not read login files.

Add these exported types in `scripts/eval-recall/pi.ts`. Attach `evidence: PiCallEvidence` to `PiCallResult`:

```ts
export interface ToolCallEvidence {
  toolCallId: string | null;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  completed: boolean;
}

export interface PiCallEvidence {
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number;
  stdoutLimited: boolean;
  malformedOutput: boolean;
  partialFinalLine: boolean;
  spawnErrorCode: string | null;
  toolCalls: ToolCallEvidence[];
}

export interface ParsedSession {
  valid: boolean;
  settled: boolean;
  answer: string;
  recordCalls: number;
  toolCalls: ToolCallEvidence[];
  malformedOutput: boolean;
  partialFinalLine: boolean;
}

export interface PiCallResult {
  status: CallStatus;
  answer: string;
  recordCalls: number;
  evidence: PiCallEvidence;
}
```

`toolCalls` must include each parsed start and end event for `pi_context`. Correlate events by `toolCallId`. Preserve request `args`, results, and the end event's error flag. Keep an unmatched start with `completed: false`. Keep a result-only event if no matching start exists. Do not store unrelated tool events or stderr text. Do not store the environment or login data. Set `partialFinalLine` when captured stdout does not end in a newline. Record malformed output, stdout overflow, exit code, signal, and spawn error code. These fields must not change `CallStatus`.

## Steps

1. Add the exported evidence interfaces. Add `evidence: PiCallEvidence` to `PiCallResult`.
2. Extend `ParsedSession` or its parser result with tool calls, malformed-output state, and final-line completeness.
3. Collect valid complete JSONL events around malformed lines. Preserve current benchmark parsing.
4. Keep the answer empty and record count zero for invalid output.
5. Keep valid but unsettled output as a failed `runPi` result.
6. Capture exit code, signal, stdout byte count, limit state, and spawn error code.
7. On timeout or stdout overflow, parse the captured prefix for tool evidence.
8. Mark that process evidence incomplete or limited.
9. Add deterministic tool, uncompleted-request, partial-line, and overflow scenarios to `test/fixtures/fake-pi-process.ts`.
10. Keep its recording-refusal, timeout, malformed, nonzero, and unsettled scenarios.
11. Extend `test/eval-recall-pi.test.ts` to check each evidence case and the 16 MiB limit.
12. Keep the current argument and benchmark-result assertions.

## Acceptance

- [ ] `PiCallResult.evidence` uses the exact exported shape above and contains no environment or login data.
- [ ] Tool evidence preserves observed requests, results, correlation, error flags, and unmatched starts.
- [ ] Existing `status`, `answer`, and `recordCalls` results stay unchanged for all existing fixture scenarios.
- [ ] `node --experimental-strip-types --test test/eval-recall-pi.test.ts` passes.
