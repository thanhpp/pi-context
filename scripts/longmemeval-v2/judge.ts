import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const JUDGE_MODEL = 'gpt-6-sol';
const JUDGE_PROVIDER = 'openai-codex';
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_TIMEOUT_MS = 299_999;

const ABSTENTION_SYSTEM_PROMPT = 'You are a strict grader for flawed-premise (abstention) questions. Judge whether a model answer correctly identifies that the question premise is wrong, consistent with the reference answer. If the model follows the flawed premise and gives a concrete answer under that premise, it must be graded 0. If the model\'s final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. Paraphrases are allowed when they preserve the same core flaw described by the reference answer.';
const GOTCHAS_SYSTEM_PROMPT = 'You are a strict grader for gotchas-style insight questions. The reference answer describes the key insight(s). Grade 1 if the model response includes at least one correct insight point from the reference answer (paraphrase allowed), and does not contradict any reference point. If the model\'s direction is wrong, or it contains contradictions against any reference point, grade 0. If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.';

type JsonObject = Record<string, unknown>;
type FailureCode =
  | 'INPUT_INVALID'
  | 'RUN_DIRECTORY_INVALID'
  | 'AUTH_DIRECTORY_INVALID'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'PROCESS_ERROR'
  | 'AUTH_ERROR'
  | 'MODEL_ERROR'
  | 'JSONL_INVALID'
  | 'AGENT_NOT_SETTLED'
  | 'ASSISTANT_ERROR'
  | 'ASSISTANT_MESSAGE_COUNT_INVALID'
  | 'MODEL_MISMATCH'
  | 'JUDGE_OUTPUT_INVALID'
  | 'JUDGE_FAILED';

type BinaryJudgement = { label: 0 | 1; reason: string };

type JudgePrompts = { system: string; user: string };

type ProcessResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  stdoutOverflowed: boolean;
  spawnFailed: boolean;
};

export type SemanticJudgeInput = {
  question: string;
  answer: string;
  responseRaw: string;
  parsedAnswer: string;
  evaluator: 'llm_abstention_checker' | 'llm_gotchas_checker';
  cwd: string;
  authDirectory: string;
  testOnlyExecutablePath?: string;
  testOnlyExecutableArgs?: readonly string[];
  testOnlyTimeoutMs?: number;
};

export type SemanticJudgeResult = {
  score: boolean;
  errorCode: string | null;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(errorCode: FailureCode): SemanticJudgeResult {
  return { score: false, errorCode };
}

function validateInput(input: SemanticJudgeInput): FailureCode | null {
  if (!isObject(input)) return 'INPUT_INVALID';
  if (typeof input.question !== 'string' || typeof input.answer !== 'string' ||
      typeof input.responseRaw !== 'string' || typeof input.parsedAnswer !== 'string' ||
      (input.evaluator !== 'llm_abstention_checker' && input.evaluator !== 'llm_gotchas_checker')) {
    return 'INPUT_INVALID';
  }
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) ||
      typeof input.authDirectory !== 'string' || !isAbsolute(input.authDirectory)) {
    return 'INPUT_INVALID';
  }
  if (input.testOnlyExecutablePath !== undefined &&
      (typeof input.testOnlyExecutablePath !== 'string' || !isAbsolute(input.testOnlyExecutablePath))) {
    return 'INPUT_INVALID';
  }
  if (input.testOnlyExecutableArgs !== undefined &&
      (!Array.isArray(input.testOnlyExecutableArgs) || input.testOnlyExecutableArgs.some(value => typeof value !== 'string'))) {
    return 'INPUT_INVALID';
  }
  if (input.testOnlyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(input.testOnlyTimeoutMs) || input.testOnlyTimeoutMs < 1 || input.testOnlyTimeoutMs > MAX_TIMEOUT_MS)) {
    return 'INPUT_INVALID';
  }
  return null;
}

async function isPrivateDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

async function hasPrivateAuthDirectory(path: string): Promise<boolean> {
  if (!(await isPrivateDirectory(path))) return false;
  try {
    const authFile = await lstat(resolve(path, 'auth.json'));
    return authFile.isFile() || authFile.isSymbolicLink();
  } catch {
    return false;
  }
}

function makePrompts(input: SemanticJudgeInput): JudgePrompts {
  const question = input.question.trim();
  const answer = input.answer.trim();
  const responseRaw = input.responseRaw.trim();
  const parsedAnswer = input.parsedAnswer.trim();

  if (input.evaluator === 'llm_abstention_checker') {
    return {
      system: ABSTENTION_SYSTEM_PROMPT,
      user: `Evaluate whether the model correctly handled a flawed-premise question.\n\nQuestion:\n${question}\n\nReference answer (the expected flaw-aware conclusion):\n${answer}\n\nModel full response:\n${responseRaw}\n\nModel extracted final answer:\n${parsedAnswer}\n\nScoring rubric:\n- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion equivalent to the reference answer.\n- Label 1 also if the model explicitly says it lacks access to the user's specific live environment/instance/configuration and therefore cannot verify, provided it does not give a concrete premise-following answer.\n- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.\n- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not make the explicit environment-access limitation clear.\n- Label 0 if contradictory.\n\nOutput JSON only:\n{\"label\": 0 or 1, \"reason\": \"short rationale\"}`,
    };
  }
  return {
    system: GOTCHAS_SYSTEM_PROMPT,
    user: `Evaluate whether the model answer captures the gotcha insight.\n\nQuestion:\n${question}\n\nReference answer (insight points):\n${answer}\n\nModel full response:\n${responseRaw}\n\nModel extracted final answer:\n${parsedAnswer}\n\nScoring rubric:\n- Label 1 if the model includes at least one correct insight point from the reference answer (paraphrase acceptable), and does not contradict any reference point.\n- Label 1 even if only part of a multi-point reference answer is covered, as long as there is no contradiction.\n- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.\n- Label 0 if any point in the model response contradicts any reference point.\n- Label 0 if the response is irrelevant or generic without insight.\n\nOutput JSON only:\n{\"label\": 0 or 1, \"reason\": \"short rationale\"}`,
  };
}

function stripMarkdownFence(text: string): string {
  const stripped = text.trim();
  if (stripped.startsWith('```') && stripped.endsWith('```')) {
    const lines = stripped.split(/\r?\n/u);
    if (lines.length >= 3) return lines.slice(1, -1).join('\n').trim();
  }
  return stripped;
}

function stringifyReason(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function parseBinaryJudgement(text: string): BinaryJudgement {
  if (typeof text !== 'string') throw new Error('JUDGE_OUTPUT_INVALID');
  const cleaned = stripMarkdownFence(text);
  if (!cleaned) throw new Error('JUDGE_OUTPUT_INVALID');

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/u);
  if (jsonMatch) {
    try {
      const payload: unknown = JSON.parse(jsonMatch[0]);
      if (isObject(payload)) {
        const label = payload.label;
        if ((typeof label === 'number' && (label === 0 || label === 1)) ||
            (typeof label === 'string' && (label === '0' || label === '1'))) {
          return { label: Number(label) as 0 | 1, reason: stringifyReason(payload.reason) };
        }
      }
    } catch {
      // The pinned evaluator tries its fallback patterns after invalid JSON.
    }
  }

  let labelMatch = cleaned.match(/"label"\s*:\s*([01])/iu);
  if (!labelMatch) labelMatch = cleaned.match(/'label'\s*:\s*([01])/iu);
  if (!labelMatch) labelMatch = cleaned.match(/\blabel\b\s*[:=]\s*([01])/iu);
  if (labelMatch) return { label: Number(labelMatch[1]) as 0 | 1, reason: cleaned };
  throw new Error('JUDGE_OUTPUT_INVALID');
}

function makeArguments(prompts: JudgePrompts): string[] {
  return [
    '--mode', 'json',
    '--provider', JUDGE_PROVIDER,
    '--model', JUDGE_MODEL,
    '--thinking', 'high',
    '--system-prompt', prompts.system,
    '--no-session',
    '--no-tools',
    '-ne', '-ns', '-np', '-nc', '-na',
    '-p', prompts.user,
  ];
}

function appendBounded(chunks: Buffer[], currentLength: number, chunk: Buffer, limit: number): number {
  const length = Math.min(chunk.length, Math.max(0, limit - currentLength));
  if (length > 0) chunks.push(chunk.subarray(0, length));
  return currentLength + length;
}

async function executePi(input: SemanticJudgeInput, prompts: JudgePrompts): Promise<ProcessResult> {
  let child: ReturnType<typeof spawn>;
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: resolve(input.authDirectory),
    };
    delete env.OPENAI_API_KEY;
    child = spawn(
      input.testOnlyExecutablePath ?? 'pi',
      [...(input.testOnlyExecutableArgs ?? []), ...makeArguments(prompts)],
      {
        cwd: resolve(input.cwd),
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    return {
      exitCode: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      stdoutOverflowed: false,
      spawnFailed: true,
    };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLength = 0;
  let stderrLength = 0;
  let stdoutOverflowed = false;
  let timedOut = false;
  let spawnFailed = false;
  const stopChild = (): void => { child.kill('SIGKILL'); };
  child.stdout?.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const nextLength = appendBounded(stdoutChunks, stdoutLength, chunk, MAX_STDOUT_BYTES);
    if (nextLength < stdoutLength + chunk.length) {
      stdoutOverflowed = true;
      stopChild();
    }
    stdoutLength = nextLength;
  });
  child.stderr?.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    stderrLength = appendBounded(stderrChunks, stderrLength, chunk, MAX_STDERR_BYTES);
  });

  const exitCode = await new Promise<number | null>(resolveExit => {
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, input.testOnlyTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once('error', () => { spawnFailed = true; });
    child.once('close', code => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    timedOut,
    stdoutOverflowed,
    spawnFailed,
  };
}

function parseJsonLines(source: string): JsonObject[] | null {
  if (source.length === 0) return null;
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return null;
  const events: JsonObject[] = [];
  for (const line of lines) {
    if (!line.trim()) return null;
    try {
      const event: unknown = JSON.parse(line);
      if (!isObject(event)) return null;
      events.push(event);
    } catch {
      return null;
    }
  }
  return events.length > 0 ? events : null;
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => collectStrings(item, depth + 1));
  if (!isObject(value)) return [];
  return Object.values(value).flatMap(item => collectStrings(item, depth + 1));
}

function classifyFailureText(text: string): 'AUTH_ERROR' | 'MODEL_ERROR' | null {
  const normalized = text.replace(/[_-]/gu, ' ');
  if (/\b(?:auth(?:entication|orization)?|oauth|credential|unauthori[sz]ed|login required|invalid grant|token (?:expired|invalid|missing))\b/iu.test(normalized)) {
    return 'AUTH_ERROR';
  }
  if (/\bmodel\b[^\n]{0,160}\b(?:not found|does not exist|unavailable|not available|unsupported|unknown|access denied)\b/iu.test(normalized) ||
      /\b(?:unknown model|model access denied|model unavailable)\b/iu.test(normalized)) {
    return 'MODEL_ERROR';
  }
  return null;
}

function eventFailure(events: JsonObject[]): FailureCode | null {
  for (const event of events) {
    if (event.type === 'model_error') {
      return classifyFailureText(collectStrings(event).join('\n')) ?? 'MODEL_ERROR';
    }
    if (event.type === 'error' || event.type === 'provider_error') {
      return classifyFailureText(collectStrings(event).join('\n')) ?? 'PROCESS_ERROR';
    }
    if (event.type !== 'message_end' || !isObject(event.message) || event.message.role !== 'assistant') continue;
    const message = event.message;
    if (message.stopReason !== 'error' && message.stopReason !== 'aborted') continue;
    return classifyFailureText(collectStrings(message).join('\n')) ?? 'ASSISTANT_ERROR';
  }
  return null;
}

function assistantText(message: JsonObject): string {
  if (!Array.isArray(message.content)) return '';
  return message.content.flatMap(block => (
    isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  )).join('\n').trim();
}

export async function judgeSemanticCase(input: SemanticJudgeInput): Promise<SemanticJudgeResult> {
  try {
    const invalidInput = validateInput(input);
    if (invalidInput) return failure(invalidInput);
    if (!(await isPrivateDirectory(input.cwd))) return failure('RUN_DIRECTORY_INVALID');
    if (!(await hasPrivateAuthDirectory(input.authDirectory))) return failure('AUTH_DIRECTORY_INVALID');

    const prompts = makePrompts(input);
    const run = await executePi(input, prompts);
    if (run.timedOut) return failure('TIMEOUT');
    if (run.stdoutOverflowed) return failure('OUTPUT_LIMIT');

    let stdout: string;
    try {
      stdout = new TextDecoder('utf-8', { fatal: true }).decode(run.stdout);
    } catch {
      return failure(classifyFailureText(run.stderr.toString('utf8')) ?? 'JSONL_INVALID');
    }
    const events = parseJsonLines(stdout);
    const stderrFailure = classifyFailureText(run.stderr.toString('utf8'));
    if (run.spawnFailed) return failure(stderrFailure ?? 'PROCESS_ERROR');
    if (run.exitCode !== 0) {
      return failure(stderrFailure ?? (events ? eventFailure(events) : null) ?? 'PROCESS_ERROR');
    }
    if (!events) return failure(stderrFailure ?? 'JSONL_INVALID');

    const processFailure = eventFailure(events);
    if (processFailure) return failure(processFailure);
    if (!events.some(event => event.type === 'agent_settled')) return failure('AGENT_NOT_SETTLED');

    const assistantMessages = events.flatMap(event => (
      event.type === 'message_end' && isObject(event.message) && event.message.role === 'assistant'
        ? [event.message]
        : []
    ));
    if (assistantMessages.length !== 1) return failure('ASSISTANT_MESSAGE_COUNT_INVALID');
    const message = assistantMessages[0];
    if (!message || message.stopReason !== 'stop') return failure('ASSISTANT_ERROR');
    if (message.provider !== JUDGE_PROVIDER || message.model !== JUDGE_MODEL ||
        typeof message.responseModel !== 'string' || message.responseModel.length === 0 ||
        message.responseModel !== JUDGE_MODEL) {
      return failure('MODEL_MISMATCH');
    }

    let judgement: BinaryJudgement;
    try {
      judgement = parseBinaryJudgement(assistantText(message));
    } catch {
      return failure('JUDGE_OUTPUT_INVALID');
    }
    const isUnknown = input.parsedAnswer.trim().toLowerCase() === 'unknown';
    return { score: judgement.label === 1 && !isUnknown, errorCode: null };
  } catch {
    return failure('JUDGE_FAILED');
  }
}
