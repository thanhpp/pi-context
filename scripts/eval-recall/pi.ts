import { spawn, type ChildProcess } from 'node:child_process';

export type Arm = 'extension' | 'control';
export type CallStatus = 'ok' | 'timeout' | 'failed';

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

export interface PiCallResult {
  status: CallStatus;
  answer: string;
  recordCalls: number;
  evidence: PiCallEvidence;
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

type JsonObject = Record<string, unknown>;

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const liveChildren = new Set<ChildProcess>();

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toolCallId(event: JsonObject): string | null {
  return typeof event.toolCallId === 'string' ? event.toolCallId : null;
}

function collectToolCalls(events: JsonObject[]): ToolCallEvidence[] {
  const toolCalls: ToolCallEvidence[] = [];
  for (const event of events) {
    if (event.toolName !== 'pi_context') continue;
    if (event.type === 'tool_execution_start') {
      const call: ToolCallEvidence = {
        toolCallId: toolCallId(event),
        completed: false,
      };
      if (isJsonObject(event.args)) call.args = event.args;
      toolCalls.push(call);
      continue;
    }
    if (event.type !== 'tool_execution_end') continue;

    const id = toolCallId(event);
    let matchingCall: ToolCallEvidence | undefined;
    if (id !== null) {
      for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
        const candidate = toolCalls[index];
        if (candidate.toolCallId === id && !candidate.completed) {
          matchingCall = candidate;
          break;
        }
      }
    }
    if (matchingCall === undefined) {
      matchingCall = { toolCallId: id, completed: true };
      toolCalls.push(matchingCall);
    } else {
      matchingCall.completed = true;
    }
    if (Object.hasOwn(event, 'result')) matchingCall.result = event.result;
    if (typeof event.isError === 'boolean') matchingCall.isError = event.isError;
  }
  return toolCalls;
}

export function buildPiArguments(input: PiCallInput): string[] {
  const common = ['-ne', '-ns', '-np', '-nc', '--offline', '--no-session', '--mode', 'json', '--model', input.model];
  const toolArguments = input.arm === 'extension'
    ? ['-e', input.extensionPath, '--tools', 'pi_context']
    : ['--no-tools'];
  return [...common, ...toolArguments, '-p', input.prompt];
}

function assistantText(event: JsonObject): string | undefined {
  const message = event.message;
  if (!isJsonObject(message) || message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((block): block is JsonObject => isJsonObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return text.trim() === '' ? undefined : text;
}

export function countSuccessfulRecords(toolCalls: readonly ToolCallEvidence[]): number {
  return toolCalls.filter(call => call.completed && call.args?.action === 'record' && isSuccessfulRecord(call)).length;
}

function isSuccessfulRecord(call: ToolCallEvidence): boolean {
  if (call.isError === true) return false;
  const result = call.result;
  if (!isJsonObject(result) || result.isError === true) return false;
  const details = result.details;
  return isJsonObject(details) && details.ok === true && details.action === 'record';
}

export function parseSessionOutput(stdout: string): ParsedSession {
  const partialFinalLine = stdout !== '' && !stdout.endsWith('\n');
  const invalid: ParsedSession = {
    valid: false,
    settled: false,
    answer: '',
    recordCalls: 0,
    toolCalls: [],
    malformedOutput: true,
    partialFinalLine,
  };
  if (stdout === '') return invalid;

  const lines = stdout.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines[lines.length - 1] === '') lines.pop();
  const events: JsonObject[] = [];
  let malformedOutput = false;
  for (const line of lines) {
    if (line === '') {
      malformedOutput = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedOutput = true;
      continue;
    }
    if (!isJsonObject(parsed)) {
      malformedOutput = true;
      continue;
    }
    events.push(parsed);
  }

  let settled = false;
  let answer = '';

  for (const event of events) {
    if (event.type === 'agent_settled') settled = true;
    else if (event.type === 'message_end') answer = assistantText(event) ?? answer;
  }

  const toolCalls = collectToolCalls(events);
  return {
    valid: !malformedOutput,
    settled,
    answer,
    recordCalls: countSuccessfulRecords(toolCalls),
    toolCalls,
    malformedOutput,
    partialFinalLine,
  };
}

export async function runPi(input: PiCallInput): Promise<PiCallResult> {
  return new Promise<PiCallResult>((resolve) => {
    let done = false;
    let terminalStatus: CallStatus | undefined;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let stdoutLimited = false;
    let spawnErrorCode: string | null = null;
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;

    const processEvidence = (parsed: ParsedSession): PiCallEvidence => {
      return {
        exitCode,
        signal,
        stdoutBytes,
        stdoutLimited,
        malformedOutput: parsed.malformedOutput,
        partialFinalLine: parsed.partialFinalLine,
        spawnErrorCode,
        toolCalls: parsed.toolCalls,
      };
    };
    const finish = (status: CallStatus): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      const parsed = parseSessionOutput(Buffer.concat(chunks, stdoutBytes).toString('utf8'));
      resolve({ status, answer: parsed.answer, recordCalls: parsed.recordCalls, evidence: processEvidence(parsed) });
    };

    try {
      child = spawn(input.executable ?? 'pi', [...(input.executableArgs ?? []), ...buildPiArguments(input)], {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, PI_CODING_AGENT_DIR: input.agentDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (isJsonObject(error) && typeof error.code === 'string') spawnErrorCode = error.code;
      finish('failed');
      return;
    }
    const running = child;
    liveChildren.add(running);

    running.stdout?.on('data', (chunk: Buffer) => {
      if (done || stdoutLimited) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_STDOUT_BYTES - stdoutBytes;
      if (bytes.length > remaining) {
        if (remaining > 0) {
          chunks.push(bytes.subarray(0, remaining));
          stdoutBytes += remaining;
        }
        stdoutLimited = true;
        terminalStatus = 'failed';
        signal = 'SIGKILL';
        running.kill('SIGKILL');
        return;
      }
      chunks.push(bytes);
      stdoutBytes += bytes.length;
    });
    running.stderr?.resume();

    timer = setTimeout(() => {
      terminalStatus ??= 'timeout';
      signal = 'SIGKILL';
      running.kill('SIGKILL');
    }, input.timeoutMs);

    running.on('error', (error: NodeJS.ErrnoException) => {
      liveChildren.delete(running);
      spawnErrorCode = typeof error.code === 'string' ? error.code : null;
      finish('failed');
    });
    running.on('close', (code, closeSignal) => {
      liveChildren.delete(running);
      exitCode = code;
      signal = closeSignal;
      if (done) return;
      if (terminalStatus !== undefined || code !== 0) {
        finish(terminalStatus ?? 'failed');
        return;
      }
      const parsed = parseSessionOutput(Buffer.concat(chunks, stdoutBytes).toString('utf8'));
      if (!parsed.valid || !parsed.settled) {
        finish('failed');
        return;
      }
      finish('ok');
    });
  });
}

export function killLivePiProcesses(): void {
  for (const child of liveChildren) child.kill('SIGKILL');
}
