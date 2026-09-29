import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createMemoryService } from '../src/memory.ts';
import { loadConfig } from '../src/config.ts';
import { resolveProject } from '../src/project.ts';
import { openMemoryStore } from '../src/store.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_ROOT = join(PACKAGE_ROOT, '.demo', randomUUID());
const FIXTURE_ROOT = join(DEMO_ROOT, 'workspace');
const AGENT_DIR = getAgentDir();
const FIRST_SESSION_FILE = join(DEMO_ROOT, 'first-session.jsonl');
const SECOND_SESSION_FILE = join(DEMO_ROOT, 'second-session.jsonl');
const FIRST_STDOUT_FILE = join(DEMO_ROOT, 'first.stdout.jsonl');
const SECOND_STDOUT_FILE = join(DEMO_ROOT, 'second.stdout.jsonl');
const FIRST_STDERR_FILE = join(DEMO_ROOT, 'first.stderr.log');
const SECOND_STDERR_FILE = join(DEMO_ROOT, 'second.stderr.log');
const REPORT_FILE = join(DEMO_ROOT, 'report.json');
const SESSION_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const FIRST_PROMPT = 'For this new offline issue tracker, use SQLite rather than PostgreSQL because deployment must use one local file and no database server. Confirm the decision briefly. Do not create or edit project files.';
const SECOND_PROMPT = 'Which database did we choose for this project, and why? Do not create or edit project files.';

type JsonObject = Record<string, unknown>;
type CorrelatedToolCall = {
  callId: string;
  action: string;
  isError: boolean;
  details?: JsonObject;
};
type PiRun = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stderrTruncated: boolean;
  spawnErrorCode?: string;
};

type DemoReport = {
  status: 'running' | 'passed' | 'failed';
  runDirectory: string;
  fixturePath: string;
  projectId: string | null;
  memoryDirectory: string | null;
  packageRoot: string;
  sessions: {
    first: { sessionFile: string; stdoutFile: string; stderrFile: string; exitCode: number | null; settled: boolean };
    second: { sessionFile: string; stdoutFile: string; stderrFile: string; exitCode: number | null; settled: boolean };
  };
  providerModelIdentity: string;
  recordToolCallIds: string[];
  retrievalToolCallIds: string[];
  decisionRecordId: string | null;
  firstAnswer: string;
  secondAnswer: string;
  checks: Record<string, boolean>;
  failureCode: string | null;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(error: unknown): string {
  if (isObject(error) && typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)) {
    return error.code;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED';
  return 'DEMO_FAILED';
}

function boundText(value: string, maxBytes: number): string {
  let result = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1);
  return result;
}

function runGit(args: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/iu.test(key)) delete env[key];
  }
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('GIT_FIXTURE_FAILED');
}

function parseJsonLines(filePath: string): { events: JsonObject[]; valid: boolean } {
  const source = readFileSync(filePath, 'utf8');
  const events: JsonObject[] = [];
  for (const rawLine of source.split('\n')) {
    if (rawLine.length === 0) continue;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    try {
      const event: unknown = JSON.parse(line);
      if (!isObject(event)) return { events, valid: false };
      events.push(event);
    } catch {
      return { events, valid: false };
    }
  }
  return { events, valid: true };
}

async function runPiSession(
  sessionFile: string,
  stdoutPath: string,
  stderrPath: string,
  prompt: string,
): Promise<PiRun> {
  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  const stdoutFinished = finished(stdoutFile);
  const stderrFinished = finished(stderrFile);
  const args = [
    '-e', PACKAGE_ROOT,
    '--mode', 'json',
    '--session', sessionFile,
    '-p', prompt,
  ];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('pi', args, {
      cwd: FIXTURE_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    stdoutFile.end();
    stderrFile.end();
    await Promise.all([stdoutFinished, stderrFinished]);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      outputLimitExceeded: false,
      stderrTruncated: false,
      spawnErrorCode: 'SPAWN_FAILED',
    };
  }

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimitExceeded = false;
  let stderrTruncated = false;
  let timedOut = false;
  let spawnErrorCode: string | undefined;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (outputLimitExceeded) return;
    const remaining = MAX_STDOUT_BYTES - stdoutBytes;
    if (chunk.length > remaining) {
      if (remaining > 0) stdoutFile.write(chunk.subarray(0, remaining));
      stdoutBytes = MAX_STDOUT_BYTES;
      outputLimitExceeded = true;
      child.kill('SIGKILL');
      return;
    }
    stdoutBytes += chunk.length;
    stdoutFile.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrTruncated) return;
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (chunk.length > remaining) {
      if (remaining > 0) stderrFile.write(chunk.subarray(0, remaining));
      stderrBytes = MAX_STDERR_BYTES;
      stderrTruncated = true;
      return;
    }
    stderrBytes += chunk.length;
    stderrFile.write(chunk);
  });

  const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SESSION_TIMEOUT_MS);
    timer.unref();
    child.once('error', error => {
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      spawnErrorCode = code === 'ENOENT' ? 'PI_NOT_FOUND' : 'SPAWN_FAILED';
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  stdoutFile.end();
  stderrFile.end();
  await Promise.all([stdoutFinished, stderrFinished]);
  return {
    exitCode: exitResult.code,
    signal: exitResult.signal,
    timedOut,
    outputLimitExceeded,
    stderrTruncated,
    ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }),
  };
}

function settled(events: JsonObject[]): boolean {
  return events.some(event => event.type === 'agent_settled');
}

function sessionId(events: JsonObject[]): string | null {
  const event = events.find(item => item.type === 'session' && typeof item.id === 'string');
  return event && typeof event.id === 'string' ? event.id : null;
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
  const answer = answers.at(-1);
  return answer ? answer : { text: '', message: null };
}

function correlatedToolCalls(events: JsonObject[]): CorrelatedToolCall[] {
  const starts = new Map<string, { action: string; toolName: string }>();
  const calls: CorrelatedToolCall[] = [];
  for (const event of events) {
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && isObject(event.args)) {
      starts.set(event.toolCallId, {
        action: typeof event.args.action === 'string' ? event.args.action : '',
        toolName: typeof event.toolName === 'string' ? event.toolName : '',
      });
      continue;
    }
    if (event.type !== 'tool_execution_end' || typeof event.toolCallId !== 'string') continue;
    const start = starts.get(event.toolCallId);
    if (!start || start.toolName !== 'pi_context' || !isObject(event.result)) continue;
    const result = event.result;
    const details = isObject(result.details) ? result.details : undefined;
    calls.push({
      callId: event.toolCallId,
      action: start.action,
      isError: result.isError !== false,
      ...(details === undefined ? {} : { details }),
    });
  }
  return calls;
}

function recordValue(call: CorrelatedToolCall): JsonObject | null {
  if (call.isError || !call.details || call.details.ok !== true || call.details.action !== 'record' ||
      !isObject(call.details.data) || !isObject(call.details.data.value)) return null;
  return call.details.data.value;
}

function returnedRecordIds(call: CorrelatedToolCall): string[] {
  if (call.isError || !call.details || call.details.ok !== true || !isObject(call.details.data)) return [];
  const data = call.details.data;
  if (call.action === 'read' && isObject(data.record) && isObject(data.record.memory) &&
      typeof data.record.memory.id === 'string') return [data.record.memory.id];
  if (call.action === 'search' && Array.isArray(data.results)) {
    return data.results.flatMap(result => (
      isObject(result) && isObject(result.memory) && typeof result.memory.id === 'string'
        ? [result.memory.id]
        : []
    ));
  }
  return [];
}

function modelIdentity(message: JsonObject | null): string {
  if (!message) return 'unavailable';
  const provider = typeof message.provider === 'string' ? message.provider : '';
  const model = typeof message.model === 'string' ? message.model : '';
  const responseModel = typeof message.responseModel === 'string' ? message.responseModel : '';
  const name = [provider, model, responseModel].filter(Boolean).join('/');
  return name || 'unavailable';
}

function localFileReason(text: string): boolean {
  return /\b(?:one|single)\s+local\s+(?:database\s+)?file\b|\b(?:one|single)\s+(?:database\s+)?file\b.{0,50}\blocal(?:ly)?\b/iu.test(text);
}

function noServerReason(text: string): boolean {
  return /\b(?:no|without|not need(?:s)?|does not need|doesn't need)\s+(?:an?\s+)?(?:(?:external|separate|dedicated)\s+)?(?:database\s+)?server\b|\bserverless\b/iu.test(text);
}

function workspaceHasNoCreatedFiles(): boolean {
  return readdirSync(FIXTURE_ROOT).every(name => name === '.git');
}

function writeReport(report: DemoReport): void {
  let text = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) {
    report.firstAnswer = boundText(report.firstAnswer, 2_000);
    report.secondAnswer = boundText(report.secondAnswer, 2_000);
    text = JSON.stringify(report, null, 2);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) {
    report.failureCode = report.failureCode ?? 'REPORT_LIMIT';
    report.status = 'failed';
    text = JSON.stringify({
      status: report.status,
      runDirectory: report.runDirectory,
      fixturePath: report.fixturePath,
      projectId: report.projectId,
      memoryDirectory: report.memoryDirectory,
      sessions: report.sessions,
      firstAnswer: report.firstAnswer,
      secondAnswer: report.secondAnswer,
      providerModelIdentity: report.providerModelIdentity,
      recordToolCallIds: report.recordToolCallIds,
      retrievalToolCallIds: report.retrievalToolCallIds,
      decisionRecordId: report.decisionRecordId,
      checks: report.checks,
      failureCode: report.failureCode,
    }, null, 2);
  }
  writeFileSync(REPORT_FILE, `${text}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function main(): Promise<void> {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const report: DemoReport = {
    status: 'running',
    runDirectory: DEMO_ROOT,
    fixturePath: FIXTURE_ROOT,
    projectId: null,
    memoryDirectory: null,
    packageRoot: PACKAGE_ROOT,
    sessions: {
      first: { sessionFile: FIRST_SESSION_FILE, stdoutFile: FIRST_STDOUT_FILE, stderrFile: FIRST_STDERR_FILE, exitCode: null, settled: false },
      second: { sessionFile: SECOND_SESSION_FILE, stdoutFile: SECOND_STDOUT_FILE, stderrFile: SECOND_STDERR_FILE, exitCode: null, settled: false },
    },
    providerModelIdentity: 'unavailable',
    recordToolCallIds: [],
    retrievalToolCallIds: [],
    decisionRecordId: null,
    firstAnswer: '',
    secondAnswer: '',
    checks: {
      firstSessionExitedSuccessfully: false,
      firstSessionSettled: false,
      firstJsonlValid: false,
      firstRecordedDecision: false,
      fixtureContainsNoProjectFiles: false,
      secondSessionExitedSuccessfully: false,
      secondSessionSettled: false,
      secondJsonlValid: false,
      retrievedSameDecisionRecord: false,
      answerNamesSQLite: false,
      answerStatesOneLocalFile: false,
      answerStatesNoDatabaseServer: false,
      recordHasFixtureAndFirstSessionProvenance: false,
    },
    failureCode: null,
  };

  try {
    runGit(['-C', FIXTURE_ROOT, 'init', '-q']);
    const resolution = await resolveProject(FIXTURE_ROOT, AGENT_DIR, await loadConfig(AGENT_DIR));
    if (!resolution.enabled) throw new Error('PROJECT_NOT_RESOLVED');
    report.projectId = resolution.project.id;
    report.memoryDirectory = resolution.project.memoryDir;

    const firstRun = await runPiSession(FIRST_SESSION_FILE, FIRST_STDOUT_FILE, FIRST_STDERR_FILE, FIRST_PROMPT);
    report.sessions.first.exitCode = firstRun.exitCode;
    if (firstRun.spawnErrorCode) report.failureCode = firstRun.spawnErrorCode;
    else if (firstRun.timedOut) report.failureCode = 'FIRST_SESSION_TIMEOUT';
    else if (firstRun.outputLimitExceeded) report.failureCode = 'FIRST_SESSION_OUTPUT_LIMIT';
    else if (firstRun.exitCode !== 0) report.failureCode = 'FIRST_SESSION_FAILED';
    const firstStream = parseJsonLines(FIRST_STDOUT_FILE);
    report.checks.firstSessionExitedSuccessfully = firstRun.exitCode === 0 && !firstRun.timedOut && !firstRun.outputLimitExceeded;
    report.checks.firstJsonlValid = firstStream.valid && !firstRun.outputLimitExceeded;
    const firstEvents = firstStream.events;
    report.sessions.first.settled = settled(firstEvents);
    report.checks.firstSessionSettled = report.sessions.first.settled;
    report.checks.fixtureContainsNoProjectFiles = workspaceHasNoCreatedFiles();
    const firstAnswer = textAnswer(firstEvents);
    report.firstAnswer = boundText(firstAnswer.text, 4_000);
    report.providerModelIdentity = modelIdentity(firstAnswer.message);

    const firstCalls = correlatedToolCalls(firstEvents);
    const recorded = firstCalls.flatMap(call => {
      const value = recordValue(call);
      if (!value || value.kind !== 'decision' || typeof value.id !== 'string' || typeof value.body !== 'string' ||
          !/\bSQLite\b/iu.test(value.body)) return [];
      return [{ call, value }];
    }).at(-1);
    if (recorded) {
      report.decisionRecordId = recorded.value.id as string;
      report.recordToolCallIds.push(recorded.call.callId);
      report.checks.firstRecordedDecision = true;
    }

    if (report.checks.firstSessionExitedSuccessfully && report.checks.firstSessionSettled &&
        report.checks.firstJsonlValid && report.checks.firstRecordedDecision &&
        report.checks.fixtureContainsNoProjectFiles) {
      const secondRun = await runPiSession(SECOND_SESSION_FILE, SECOND_STDOUT_FILE, SECOND_STDERR_FILE, SECOND_PROMPT);
      report.sessions.second.exitCode = secondRun.exitCode;
      if (secondRun.spawnErrorCode) report.failureCode = secondRun.spawnErrorCode;
      else if (secondRun.timedOut) report.failureCode = 'SECOND_SESSION_TIMEOUT';
      else if (secondRun.outputLimitExceeded) report.failureCode = 'SECOND_SESSION_OUTPUT_LIMIT';
      else if (secondRun.exitCode !== 0) report.failureCode = 'SECOND_SESSION_FAILED';
      const secondStream = parseJsonLines(SECOND_STDOUT_FILE);
      report.checks.secondSessionExitedSuccessfully = secondRun.exitCode === 0 && !secondRun.timedOut && !secondRun.outputLimitExceeded;
      report.checks.secondJsonlValid = secondStream.valid && !secondRun.outputLimitExceeded;
      const secondEvents = secondStream.events;
      report.sessions.second.settled = settled(secondEvents);
      report.checks.secondSessionSettled = report.sessions.second.settled;
      const secondAnswer = textAnswer(secondEvents);
      report.secondAnswer = boundText(secondAnswer.text, 4_000);

      const secondCalls = correlatedToolCalls(secondEvents);
      const decisionRecordId = report.decisionRecordId;
      if (decisionRecordId) {
        for (const call of secondCalls) {
          if (call.action !== 'search' && call.action !== 'read') continue;
          if (returnedRecordIds(call).includes(decisionRecordId)) {
            report.retrievalToolCallIds.push(call.callId);
          }
        }
      }
      report.checks.retrievedSameDecisionRecord = report.retrievalToolCallIds.length > 0;
      report.checks.answerNamesSQLite = /\bSQLite\b/iu.test(secondAnswer.text);
      report.checks.answerStatesOneLocalFile = localFileReason(secondAnswer.text);
      report.checks.answerStatesNoDatabaseServer = noServerReason(secondAnswer.text);

      const actualFirstSessionId = sessionId(firstEvents);
      if (actualFirstSessionId && report.decisionRecordId) {
        const service = createMemoryService(
          openMemoryStore(resolution.project, resolution.policy),
          {
            sessionId: actualFirstSessionId,
            worktreeRoot: resolution.project.worktreeRoot,
            head: null,
          },
        );
        const stored = await service.read(report.decisionRecordId);
        const belongsToFixture = stored.retention?.provenance.some(source => (
          source.sessionId === actualFirstSessionId &&
          source.worktreeRoot === resolution.project.worktreeRoot
        )) ?? false;
        report.checks.recordHasFixtureAndFirstSessionProvenance =
          belongsToFixture && stored.record.memory.kind === 'decision' &&
          workspaceHasNoCreatedFiles();
      }
    }
  } catch (error) {
    report.failureCode = safeCode(error);
  }

  const checks = Object.values(report.checks);
  report.status = checks.length > 0 && checks.every(Boolean) ? 'passed' : 'failed';
  writeReport(report);
  console.log(JSON.stringify({
    status: report.status,
    report: REPORT_FILE,
    fixturePath: report.fixturePath,
    memoryDirectory: report.memoryDirectory,
    firstSessionFile: report.sessions.first.sessionFile,
    secondSessionFile: report.sessions.second.sessionFile,
    firstStdoutFile: report.sessions.first.stdoutFile,
    secondStdoutFile: report.sessions.second.stdoutFile,
    firstStderrFile: report.sessions.first.stderrFile,
    secondStderrFile: report.sessions.second.stderrFile,
    providerModelIdentity: report.providerModelIdentity,
    artifactNotice: 'The retained session logs and fixture memory contain the synthetic SQLite database decision.',
    recordToolCallIds: report.recordToolCallIds,
    retrievalToolCallIds: report.retrievalToolCallIds,
    decisionRecordId: report.decisionRecordId,
    checks: report.checks,
  }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

await main();
