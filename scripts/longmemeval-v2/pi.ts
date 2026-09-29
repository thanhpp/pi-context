import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { finished } from 'node:stream/promises';

const STDERR_LIMIT_BYTES = 1024 * 1024;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const INVALID_CONTEXT_CODES = new Set(['PROJECT_NOT_CONFIGURED', 'QUOTA_EXCEEDED', 'GUIDANCE_CONFLICT']);
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;

type TokenField = (typeof TOKEN_FIELDS)[number];
type JsonObject = Record<string, unknown>;

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reportedUsd: number | null;
};

export type PiSessionInput = {
  cwd: string;
  sessionFile: string;
  stdoutPath: string;
  stderrPath: string;
  prompt: string;
  model: string;
  thinking: string;
  mode: 'memory' | 'control';
  extensionPath: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  testOnlyExecutablePath?: string;
  testOnlyExecutableArgs?: readonly string[];
  /** Add environment values for this Pi child only. */
  env?: NodeJS.ProcessEnv;
};

export type PiToolAction = {
  callId: string;
  action: string;
  isError: boolean;
  valid: boolean;
  errorCodes: string[];
  details?: JsonObject;
};

export type PiModelIdentity = {
  provider: string;
  model: string;
  responseModel: string | null;
};

export type PiSessionMetadata = {
  cwd: string;
  sessionFile: string;
  stdoutPath: string;
  stderrPath: string;
  sessionId: string | null;
  exitCode: number | null;
  settled: boolean;
  stderrTruncated: boolean;
  mode: 'memory' | 'control';
  model: string;
  thinking: string;
};

export type PiSessionEvidence = {
  valid: boolean;
  answer: string;
  usage: UsageTotals;
  toolActions: PiToolAction[];
  actualModel: PiModelIdentity | null;
  actualModelIdentity: string | null;
  session: PiSessionMetadata;
  validationIssues: string[];
};

export type PiSessionResult = PiSessionEvidence & { valid: true };

export class PiSessionError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly sessionFile: string;
  readonly sessionId: string | null;
  readonly evidence?: PiSessionEvidence;

  constructor(options: {
    code: string;
    stage: string;
    sessionFile: string;
    sessionId?: string | null;
    evidence?: PiSessionEvidence;
  }) {
    const sessionId = options.sessionId ?? null;
    super(`${options.code} at ${options.stage} for ${sessionId ?? options.sessionFile}`);
    this.name = 'PiSessionError';
    this.code = options.code;
    this.stage = options.stage;
    this.sessionFile = options.sessionFile;
    this.sessionId = sessionId;
    this.evidence = options.evidence;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function fail(
  code: string,
  stage: string,
  sessionFile: string,
  sessionId?: string | null,
  evidence?: PiSessionEvidence,
): never {
  throw new PiSessionError({ code, stage, sessionFile, sessionId, evidence });
}

function validateInput(input: PiSessionInput): void {
  if (!input || typeof input !== 'object') fail('INPUT_INVALID', 'input', 'unknown-session');
  const sessionFile = typeof input.sessionFile === 'string' ? input.sessionFile : 'unknown-session';
  if (input.model && /^openai-codex\/[^/]+$/u.test(input.model) && /(?:luna|sol)$/iu.test(input.model)) {
    // The provider prefix and selected model family are part of the benchmark contract.
  } else {
    fail('MODEL_INVALID', 'input', sessionFile);
  }
  if (!THINKING_LEVELS.has(input.thinking)) fail('THINKING_INVALID', 'input', sessionFile);
  if (input.mode !== 'memory' && input.mode !== 'control') fail('MODE_INVALID', 'input', sessionFile);
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    fail('PROMPT_INVALID', 'input', sessionFile);
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) fail('TIMEOUT_INVALID', 'input', sessionFile);
  if (!Number.isSafeInteger(input.maxStdoutBytes) || input.maxStdoutBytes < 1) {
    fail('OUTPUT_LIMIT_INVALID', 'input', sessionFile);
  }
  const requiredPaths = [input.cwd, input.sessionFile, input.stdoutPath, input.stderrPath];
  if (requiredPaths.some(path => typeof path !== 'string' || !path.startsWith('/'))) {
    fail('PATH_INVALID', 'input', sessionFile);
  }
  if (input.mode === 'memory' && (typeof input.extensionPath !== 'string' || !input.extensionPath.startsWith('/'))) {
    fail('EXTENSION_PATH_INVALID', 'input', sessionFile);
  }
  if (input.testOnlyExecutablePath !== undefined && !input.testOnlyExecutablePath.startsWith('/')) {
    fail('TEST_EXECUTABLE_PATH_INVALID', 'input', sessionFile);
  }
  if (input.testOnlyExecutableArgs?.some(argument => typeof argument !== 'string')) {
    fail('TEST_EXECUTABLE_ARGS_INVALID', 'input', sessionFile);
  }
}

function modelId(model: string): string {
  return model.slice('openai-codex/'.length);
}

function makeArguments(input: PiSessionInput, sessionFile: string): string[] {
  const args = [
    '--mode', 'json',
    '--session', sessionFile,
    '--provider', 'openai-codex',
    '--model', modelId(input.model),
    '--thinking', input.thinking,
    '-ne', '-ns', '-np', '-nc',
  ];
  if (input.mode === 'memory') {
    args.push('-e', resolve(input.extensionPath), '--tools', 'pi_context');
  } else {
    args.push('--no-tools');
  }
  args.push('-p', input.prompt);
  return args;
}

async function prepareRunDirectory(input: PiSessionInput): Promise<{
  cwd: string;
  sessionFile: string;
  stdoutPath: string;
  stderrPath: string;
  runDirectory: string;
}> {
  const cwd = resolve(input.cwd);
  const sessionFile = resolve(input.sessionFile);
  const stdoutPath = resolve(input.stdoutPath);
  const stderrPath = resolve(input.stderrPath);
  const runDirectory = dirname(stdoutPath);
  if (dirname(stderrPath) !== runDirectory || dirname(sessionFile) !== runDirectory ||
      stdoutPath === stderrPath || sessionFile === stdoutPath || sessionFile === stderrPath) {
    fail('OUTPUT_PATH_INVALID', 'prepare', sessionFile);
  }
  try {
    const cwdInfo = await stat(cwd);
    if (!cwdInfo.isDirectory()) fail('WORKSPACE_INVALID', 'prepare', sessionFile);
    const existingSession = await lstat(sessionFile).then(() => true, error => {
      if (isObject(error) && error.code === 'ENOENT') return false;
      throw error;
    });
    if (existingSession) fail('SESSION_FILE_EXISTS', 'prepare', sessionFile);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(runDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      fail('RUN_DIRECTORY_INVALID', 'prepare', sessionFile);
    }
    await chmod(runDirectory, 0o700);
    await realpath(runDirectory);
    return { cwd, sessionFile, stdoutPath, stderrPath, runDirectory };
  } catch (error) {
    if (error instanceof PiSessionError) throw error;
    fail('RUN_DIRECTORY_FAILED', 'prepare', sessionFile);
  }
}

function waitForOpen(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolveOpen, rejectOpen) => {
    const onOpen = (): void => {
      stream.off('error', onError);
      resolveOpen();
    };
    const onError = (): void => {
      stream.off('open', onOpen);
      rejectOpen(new Error('LOG_OPEN_FAILED'));
    };
    stream.once('open', onOpen);
    stream.once('error', onError);
  });
}

function captureStream(
  source: NodeJS.ReadableStream,
  target: ReturnType<typeof createWriteStream>,
  limit: number,
  onOverflow: () => void,
): { bytes: number; overflowed: boolean; writeError: boolean } {
  let bytes = 0;
  let overflowed = false;
  let writeError = false;
  target.on('error', () => {
    writeError = true;
    onOverflow();
  });
  source.on('error', () => {
    writeError = true;
    onOverflow();
  });
  source.on('data', (rawChunk: Buffer | string) => {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const remaining = Math.max(0, limit - bytes);
    const writeLength = Math.min(remaining, chunk.length);
    if (writeLength > 0) {
      bytes += writeLength;
      if (!target.write(chunk.subarray(0, writeLength))) {
        source.pause();
        target.once('drain', () => source.resume());
      }
    }
    if (writeLength < chunk.length && !overflowed) {
      overflowed = true;
      onOverflow();
    }
  });
  return {
    get bytes() { return bytes; },
    get overflowed() { return overflowed; },
    get writeError() { return writeError; },
  };
}

async function executePi(
  input: PiSessionInput,
  paths: Awaited<ReturnType<typeof prepareRunDirectory>>,
): Promise<{ exitCode: number | null; timedOut: boolean; stdoutOverflowed: boolean; stderrTruncated: boolean }> {
  const stdoutFile = createWriteStream(paths.stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderrFile = createWriteStream(paths.stderrPath, { flags: 'wx', mode: 0o600 });
  const stdoutDone = finished(stdoutFile).then(() => undefined, () => undefined);
  const stderrDone = finished(stderrFile).then(() => undefined, () => undefined);
  try {
    await Promise.all([waitForOpen(stdoutFile), waitForOpen(stderrFile)]);
    await Promise.all([chmod(paths.stdoutPath, 0o600), chmod(paths.stderrPath, 0o600)]);
  } catch {
    stdoutFile.destroy();
    stderrFile.destroy();
    await Promise.all([stdoutDone, stderrDone]);
    fail('LOG_CREATE_FAILED', 'prepare', paths.sessionFile);
  }

  let child: ReturnType<typeof spawn>;
  try {
    const command = input.testOnlyExecutablePath ?? 'pi';
    const commandPrefix = input.testOnlyExecutableArgs ?? [];
    child = spawn(command, [...commandPrefix, ...makeArguments(input, paths.sessionFile)], {
      cwd: paths.cwd,
      shell: false,
      windowsHide: true,
      env: input.env === undefined ? process.env : { ...process.env, ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    stdoutFile.end();
    stderrFile.end();
    await Promise.all([stdoutDone, stderrDone]);
    fail('SPAWN_FAILED', 'spawn', paths.sessionFile);
  }

  let timedOut = false;
  let stdoutOverflowed = false;
  let stderrTruncated = false;
  let spawnFailure = false;
  const stopChild = (): void => { child.kill('SIGKILL'); };
  const stdoutCapture = captureStream(child.stdout!, stdoutFile, input.maxStdoutBytes, () => {
    stdoutOverflowed = true;
    stopChild();
  });
  const stderrCapture = captureStream(child.stderr!, stderrFile, STDERR_LIMIT_BYTES, () => {
    stderrTruncated = true;
  });
  const exitCode = await new Promise<number | null>(resolveExit => {
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, input.timeoutMs);
    timer.unref();
    child.once('error', () => {
      spawnFailure = true;
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  stdoutFile.end();
  stderrFile.end();
  await Promise.all([stdoutDone, stderrDone]);
  stderrTruncated ||= stderrCapture.overflowed;
  if (stdoutCapture.writeError || stderrCapture.writeError) {
    fail('LOG_WRITE_FAILED', 'run', paths.sessionFile);
  }
  if (spawnFailure) fail('SPAWN_FAILED', 'spawn', paths.sessionFile);
  return { exitCode, timedOut, stdoutOverflowed, stderrTruncated };
}

function parseJsonLines(source: string): { events: JsonObject[]; valid: boolean } {
  if (source.length === 0) return { events: [], valid: false };
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events: JsonObject[] = [];
  for (const line of lines) {
    if (line.length === 0) return { events, valid: false };
    try {
      const event: unknown = JSON.parse(line);
      if (!isObject(event)) return { events, valid: false };
      events.push(event);
    } catch {
      return { events, valid: false };
    }
  }
  return { events, valid: events.length > 0 };
}

function sessionId(events: JsonObject[]): string | null {
  const event = events.find(item => item.type === 'session' && typeof item.id === 'string');
  return event && typeof event.id === 'string' ? event.id : null;
}

function settled(events: JsonObject[]): boolean {
  return events.some(event => event.type === 'agent_settled');
}

function textAnswer(events: JsonObject[]): { text: string; message: JsonObject | null } {
  const answers = events.flatMap(event => {
    if (event.type !== 'message_end' || !isObject(event.message) || event.message.role !== 'assistant') return [];
    const message = event.message;
    if (!Array.isArray(message.content)) return [];
    const text = message.content.flatMap(block => (
      isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )).join('\n').trim();
    return text.length > 0 ? [{ text, message }] : [];
  });
  return answers.at(-1) ?? { text: '', message: null };
}

function actualModel(message: JsonObject | null): PiModelIdentity | null {
  if (!message) return null;
  const provider = typeof message.provider === 'string' ? message.provider : '';
  const model = typeof message.model === 'string' ? message.model : '';
  if (!provider || !model) return null;
  return {
    provider,
    model,
    responseModel: typeof message.responseModel === 'string' ? message.responseModel : null,
  };
}

function identityText(identity: PiModelIdentity | null): string | null {
  if (!identity) return null;
  return [identity.provider, identity.model, identity.responseModel].filter(Boolean).join('/');
}

function readCount(usage: JsonObject, field: TokenField): number {
  const value = usage[field];
  if (value === undefined) return 0;
  if (!isSafeCount(value)) throw new Error('USAGE_INVALID');
  return value;
}

function usageCost(usage: JsonObject): number | null {
  const cost = usage.cost;
  const total = typeof cost === 'number' ? cost : isObject(cost) ? cost.total : undefined;
  if (total === undefined) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) throw new Error('USAGE_INVALID');
  return total;
}

function firstNestedUsage(value: unknown, seen: Set<object> = new Set()): JsonObject | null {
  if (!isObject(value) || seen.has(value)) return null;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'usage' && isObject(nested)) return nested;
    const found = firstNestedUsage(nested, seen);
    if (found) return found;
  }
  return null;
}

function sumUsage(events: JsonObject[]): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    reportedUsd: null,
  };
  let hasUsage = false;
  let costsComplete = true;
  let usd = 0;
  const seenMessages = new Set<string>();
  const seenToolCalls = new Set<string>();
  const records: JsonObject[] = [];

  for (const event of events) {
    if (event.type === 'message_end' && isObject(event.message)) {
      const message = event.message;
      const usage = message.usage;
      if (message.role === 'assistant' && isObject(usage)) {
        const id = typeof message.id === 'string' ? message.id : undefined;
        if (id !== undefined && seenMessages.has(id)) continue;
        if (id !== undefined) seenMessages.add(id);
        records.push(usage);
      }
    }
    if (event.type === 'tool_execution_end') {
      const callId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
      if (callId !== undefined && seenToolCalls.has(callId)) continue;
      if (callId !== undefined) seenToolCalls.add(callId);
      const nested = firstNestedUsage(event.result);
      if (nested) records.push(nested);
    }
  }

  for (const record of records) {
    hasUsage = true;
    const input = readCount(record, 'input');
    const output = readCount(record, 'output');
    const cacheRead = readCount(record, 'cacheRead');
    const cacheWrite = readCount(record, 'cacheWrite');
    const totalTokens = record.totalTokens === undefined
      ? input + output + cacheRead + cacheWrite
      : readCount(record, 'totalTokens');
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.totalTokens += totalTokens;
    const cost = usageCost(record);
    if (cost === null) costsComplete = false;
    else usd += cost;
  }
  if (hasUsage && costsComplete) totals.reportedUsd = usd;
  return totals;
}

function toolActions(events: JsonObject[]): PiToolAction[] {
  const starts = new Map<string, { action: string; toolName: string }>();
  const ends = new Map<string, JsonObject>();
  for (const event of events) {
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      const args = isObject(event.args) ? event.args : {};
      starts.set(event.toolCallId, {
        action: typeof args.action === 'string' ? args.action : '',
        toolName: typeof event.toolName === 'string' ? event.toolName : '',
      });
    }
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      ends.set(event.toolCallId, event);
    }
  }

  const calls: PiToolAction[] = [];
  for (const [callId, start] of starts) {
    if (start.toolName !== 'pi_context') continue;
    const end = ends.get(callId);
    const result = end && isObject(end.result) ? end.result : null;
    const details = result && isObject(result.details) ? result.details : undefined;
    const isError = !result || result.isError !== false || details?.ok !== true;
    const errorCodes = isError ? findContextCodes(result ?? end ?? {}) : [];
    calls.push({
      callId,
      action: start.action,
      isError,
      valid: !isError && errorCodes.length === 0,
      errorCodes,
      ...(details === undefined ? {} : { details }),
    });
  }
  for (const [callId, end] of ends) {
    if (starts.has(callId) || end.toolName !== 'pi_context') continue;
    calls.push({ callId, action: '', isError: true, valid: false, errorCodes: ['TOOL_START_MISSING'] });
  }
  return calls;
}

function findContextCodes(value: unknown, found = new Set<string>(), seen = new Set<object>()): string[] {
  if (typeof value === 'string') {
    for (const code of INVALID_CONTEXT_CODES) {
      if (new RegExp(`(?:^|[^A-Z0-9_])${code}(?:$|[^A-Z0-9_])`, 'u').test(value)) found.add(code);
    }
    return [...found];
  }
  if (Array.isArray(value)) {
    for (const nested of value) findContextCodes(nested, found, seen);
    return [...found];
  }
  if (!isObject(value) || seen.has(value)) return [...found];
  seen.add(value);
  for (const nested of Object.values(value)) findContextCodes(nested, found, seen);
  return [...found];
}

function invalidContextCodes(events: JsonObject[]): string[] {
  const found = new Set<string>();
  for (const event of events) {
    if (event.type !== 'extension_status') continue;
    for (const code of findContextCodes(event)) found.add(code);
  }
  return [...found];
}

function makeEvidence(
  input: PiSessionInput,
  paths: Awaited<ReturnType<typeof prepareRunDirectory>>,
  run: { exitCode: number | null; stderrTruncated: boolean },
  events: JsonObject[],
): PiSessionEvidence {
  const answer = textAnswer(events);
  const identity = actualModel(answer.message);
  const actions = toolActions(events);
  const issues = invalidContextCodes(events);
  for (const action of actions) issues.push(...action.errorCodes);
  if (actions.some(action => !action.valid)) issues.push('PI_CONTEXT_ACTION_INVALID');
  if (input.mode === 'control' && actions.length > 0) issues.push('CONTROL_TOOL_CALL');
  const uniqueIssues = [...new Set(issues)];
  return {
    valid: uniqueIssues.length === 0,
    answer: answer.text,
    usage: sumUsage(events),
    toolActions: actions,
    actualModel: identity,
    actualModelIdentity: identityText(identity),
    session: {
      cwd: paths.cwd,
      sessionFile: paths.sessionFile,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      sessionId: sessionId(events),
      exitCode: run.exitCode,
      settled: settled(events),
      stderrTruncated: run.stderrTruncated,
      mode: input.mode,
      model: input.model,
      thinking: input.thinking,
    },
    validationIssues: uniqueIssues,
  };
}

export async function runPiSession(input: PiSessionInput): Promise<PiSessionResult> {
  validateInput(input);
  const paths = await prepareRunDirectory(input);
  const run = await executePi(input, paths);
  if (run.timedOut) fail('SESSION_TIMEOUT', 'run', paths.sessionFile);
  if (run.stdoutOverflowed) fail('STDOUT_LIMIT', 'run', paths.sessionFile);
  if (run.exitCode !== 0) fail('PI_EXIT_NONZERO', 'run', paths.sessionFile);

  let source: string;
  try {
    const bytes = await readFile(paths.stdoutPath);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('STDOUT_READ_FAILED', 'parse', paths.sessionFile);
  }
  const parsed = parseJsonLines(source);
  if (!parsed.valid) fail('JSONL_INVALID', 'parse', paths.sessionFile);
  const id = sessionId(parsed.events);
  let evidence: PiSessionEvidence;
  try {
    evidence = makeEvidence(input, paths, run, parsed.events);
  } catch {
    fail('USAGE_INVALID', 'usage', paths.sessionFile, id);
  }
  if (!evidence.session.settled) fail('AGENT_NOT_SETTLED', 'validate', paths.sessionFile, id, evidence);

  const assistantMessages = parsed.events.flatMap(event => (
    event.type === 'message_end' && isObject(event.message) && event.message.role === 'assistant'
      ? [event.message]
      : []
  ));
  if (assistantMessages.some(message => message.stopReason === 'error' || message.stopReason === 'aborted')) {
    fail('ASSISTANT_ERROR', 'validate', paths.sessionFile, id, evidence);
  }
  if (!evidence.answer || !evidence.answer.trim()) fail('ANSWER_EMPTY', 'validate', paths.sessionFile, id, evidence);
  const expectedModel = modelId(input.model);
  const modelMismatch = assistantMessages.some(message => {
    const identity = actualModel(message);
    return !identity || identity.provider !== 'openai-codex' || identity.model !== expectedModel ||
      (identity.responseModel !== null && identity.responseModel !== expectedModel);
  });
  if (modelMismatch || !evidence.actualModel) fail('MODEL_MISMATCH', 'validate', paths.sessionFile, id, evidence);
  if (evidence.validationIssues.length > 0) {
    const knownCode = evidence.validationIssues.find(code => INVALID_CONTEXT_CODES.has(code));
    fail(knownCode ?? evidence.validationIssues[0]!, 'validate', paths.sessionFile, id, evidence);
  }
  return { ...evidence, valid: true };
}
