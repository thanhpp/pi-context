import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaseType, FactStage } from './corpus.ts';
import type { Arm, CallStatus, PiCallEvidence, ToolCallEvidence } from './pi.ts';
import { SCORING_VERSIONS, type ScoreReason, type ScoringVersion } from './score.ts';

const MAX_CALL_LINE_BYTES = 16 * 1024 * 1024;

export interface SeedCallMetadata {
  kind: 'seed';
  runIndex: number;
  factId: string;
  factStage: FactStage;
  factText: string;
  factKind: 'question' | 'distractor';
  status: CallStatus;
  recorded: boolean;
  recordCalls: number;
}

export interface QuestionCallMetadata {
  kind: 'question';
  runIndex: number;
  arm: Arm;
  caseId: string;
  caseType: CaseType;
  question: string;
  status: CallStatus;
  score: boolean;
  scoringVersion?: ScoringVersion;
  scoreReason?: ScoreReason;
  scoringInputs: {
    expectedKeywords: readonly string[];
    forbiddenKeywords: readonly string[];
    abstentionPhrases: readonly string[];
  };
}

export type CallMetadata = SeedCallMetadata | QuestionCallMetadata;

export interface CallEvidence {
  answer: string;
  process: PiCallEvidence;
}

export interface CallEntry {
  metadata: CallMetadata;
  evidence: CallEvidence;
}

export interface StoredCallEntry {
  metadata: CallMetadata;
  evidence?: CallEvidence;
  evidenceOmitted: boolean;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  scoringVersion?: ScoringVersion;
  recordAccountingVersion?: 2;
  id: string;
  status: 'running' | 'complete' | 'incomplete' | 'write_failed';
  model: string;
  runs: number;
  expectedCalls: number;
  startedAt: string;
  completedAt?: string;
}

export interface AppendCallResult {
  appended: boolean;
  evidenceOmitted: boolean;
  warning?: string;
}

export interface ArtifactWriter {
  directory: string;
  appendCall(entry: CallEntry): Promise<AppendCallResult>;
  finish(status: 'complete' | 'incomplete'): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCallStatus(value: unknown): value is CallStatus {
  return value === 'ok' || value === 'timeout' || value === 'failed';
}

function isFactStage(value: unknown): value is FactStage {
  return value === 'base' || value === 'update';
}

function isCaseType(value: unknown): value is CaseType {
  return value === 'present' || value === 'absent' || value === 'superseded' || value === 'adjacent';
}

function isCallMetadata(value: unknown): value is CallMetadata {
  if (!isObject(value) || !Number.isInteger(value.runIndex) || !isCallStatus(value.status)) return false;
  if (value.kind === 'seed') {
    return typeof value.factId === 'string'
      && isFactStage(value.factStage)
      && typeof value.factText === 'string'
      && (value.factKind === 'question' || value.factKind === 'distractor')
      && typeof value.recorded === 'boolean'
      && Number.isInteger(value.recordCalls);
  }
  if (value.kind === 'question') {
    if (value.arm !== 'extension' && value.arm !== 'control') return false;
    if (typeof value.caseId !== 'string' || !isCaseType(value.caseType) || typeof value.question !== 'string') return false;
    if (typeof value.score !== 'boolean' || !isObject(value.scoringInputs)) return false;
    if (value.scoringVersion !== undefined && !SCORING_VERSIONS.includes(value.scoringVersion as ScoringVersion)) return false;
    if (value.scoreReason !== undefined && ![
      'hit', 'empty_answer', 'invalid_response', 'forbidden_keyword', 'missing_keyword',
      'missing_abstention', 'unexpected_abstention', 'call_not_ok',
    ].includes(value.scoreReason as string)) return false;
    return isStringArray(value.scoringInputs.expectedKeywords)
      && isStringArray(value.scoringInputs.forbiddenKeywords)
      && isStringArray(value.scoringInputs.abstentionPhrases);
  }
  return false;
}

function isToolCallEvidence(value: unknown): value is ToolCallEvidence {
  if (!isObject(value)) return false;
  return (typeof value.toolCallId === 'string' || value.toolCallId === null)
    && typeof value.completed === 'boolean'
    && (value.args === undefined || isObject(value.args))
    && (value.isError === undefined || typeof value.isError === 'boolean');
}

function isPiCallEvidence(value: unknown): value is PiCallEvidence {
  if (!isObject(value)) return false;
  return (typeof value.exitCode === 'number' || value.exitCode === null)
    && (typeof value.signal === 'string' || value.signal === null)
    && typeof value.stdoutBytes === 'number'
    && typeof value.stdoutLimited === 'boolean'
    && typeof value.malformedOutput === 'boolean'
    && typeof value.partialFinalLine === 'boolean'
    && (typeof value.spawnErrorCode === 'string' || value.spawnErrorCode === null)
    && Array.isArray(value.toolCalls)
    && value.toolCalls.every(isToolCallEvidence);
}

function isCallEvidence(value: unknown): value is CallEvidence {
  return isObject(value) && typeof value.answer === 'string' && isPiCallEvidence(value.process);
}

function isStoredCallEntry(value: unknown): value is StoredCallEntry {
  if (!isObject(value) || !isCallMetadata(value.metadata) || typeof value.evidenceOmitted !== 'boolean') return false;
  return value.evidence === undefined || isCallEvidence(value.evidence);
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export async function createArtifactWriter(
  root: string,
  metadata: { model: string; runs: number; expectedCalls: number; scoringVersion?: ScoringVersion; recordAccountingVersion?: 2 },
): Promise<ArtifactWriter> {
  await mkdir(root, { recursive: true });
  const id = randomUUID();
  const directory = join(root, id);
  await mkdir(directory);
  const manifestPath = join(directory, 'manifest.json');
  const callsPath = join(directory, 'calls.jsonl');
  const startedAt = new Date().toISOString();
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    ...(metadata.scoringVersion === undefined ? {} : { scoringVersion: metadata.scoringVersion }),
    ...(metadata.recordAccountingVersion === undefined ? {} : { recordAccountingVersion: metadata.recordAccountingVersion }),
    id,
    status: 'running',
    model: metadata.model,
    runs: metadata.runs,
    expectedCalls: metadata.expectedCalls,
    startedAt,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await writeFile(callsPath, '', { flag: 'wx' });

  let appendDisabled = false;
  let appendFailure = false;
  let appendQueue: Promise<void> = Promise.resolve();
  let finished = false;
  let finishing = false;

  const appendOne = async (entry: CallEntry): Promise<AppendCallResult> => {
    if (appendDisabled) return { appended: false, evidenceOmitted: false };

    let line: string;
    let evidenceOmitted = false;
    let warning: string | undefined;
    try {
      line = jsonLine({ metadata: entry.metadata, evidence: entry.evidence, evidenceOmitted: false });
      if (Buffer.byteLength(line, 'utf8') > MAX_CALL_LINE_BYTES) {
        evidenceOmitted = true;
        line = jsonLine({ metadata: entry.metadata, evidenceOmitted: true });
        warning = 'Call evidence was omitted because the serialized entry exceeded 16 MiB.';
      }
    } catch {
      return {
        appended: false,
        evidenceOmitted: false,
        warning: 'The call entry could not be serialized as JSON.',
      };
    }

    if (Buffer.byteLength(line, 'utf8') > MAX_CALL_LINE_BYTES) {
      return {
        appended: false,
        evidenceOmitted,
        warning: 'Call metadata exceeded the 16 MiB entry limit and was not written.',
      };
    }

    try {
      await appendFile(callsPath, line, 'utf8');
      return { appended: true, evidenceOmitted, ...(warning === undefined ? {} : { warning }) };
    } catch {
      appendDisabled = true;
      appendFailure = true;
      return {
        appended: false,
        evidenceOmitted,
        warning: 'The call log append failed. Later appends are disabled.',
      };
    }
  };

  return {
    directory,
    appendCall(entry: CallEntry): Promise<AppendCallResult> {
      if (finishing || finished) return Promise.resolve({ appended: false, evidenceOmitted: false });
      const result = appendQueue.then(() => appendOne(entry));
      appendQueue = result.then(() => undefined, () => undefined);
      return result;
    },
    async finish(status: 'complete' | 'incomplete'): Promise<void> {
      if (finishing || finished) return;
      finishing = true;
      await appendQueue;
      finished = true;
      const finalManifest: ArtifactManifest = {
        ...manifest,
        status: appendFailure ? 'write_failed' : status,
        completedAt: new Date().toISOString(),
      };
      await writeFile(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');
    },
  };
}

export function parseCallsJsonl(text: string): {
  entries: StoredCallEntry[];
  invalidLines: number;
  incompleteFinalLine: boolean;
} {
  const entries: StoredCallEntry[] = [];
  if (text === '') return { entries, invalidLines: 0, incompleteFinalLine: false };
  const incompleteFinalLine = text !== '' && !text.endsWith('\n');
  const lines = text.split('\n');
  if (!incompleteFinalLine && lines[lines.length - 1] === '') lines.pop();
  else if (incompleteFinalLine) lines.pop();

  let invalidLines = 0;
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (!isStoredCallEntry(parsed)) {
      invalidLines += 1;
      continue;
    }
    const entry: StoredCallEntry = {
      metadata: parsed.metadata,
      evidenceOmitted: parsed.evidenceOmitted,
    };
    if (parsed.evidence !== undefined) entry.evidence = parsed.evidence;
    entries.push(entry);
  }
  return { entries, invalidLines, incompleteFinalLine };
}
