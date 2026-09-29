import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';

export const DATASET_REVISION = 'f152293e235517d504809563c833d7190b8c713b';
export const MAX_RENDERED_CHUNK_BYTES = 32 * 1024;

export type BenchmarkDomain = 'web' | 'enterprise';

export interface DatasetSourceHashes {
  'questions.jsonl': string;
  'trajectories.jsonl': string;
  'haystacks/lme_v2_small.json': string;
}

export interface QuestionCase {
  id: string;
  domain: BenchmarkDomain;
  questionType: string;
  question: string;
}

export interface TrajectoryState {
  stateIndex: number;
  action: string | null;
  accessibilityTree: string;
}

export interface Trajectory {
  id: string;
  domain: BenchmarkDomain;
  states: TrajectoryState[];
}

export interface BenchmarkDataset {
  datasetRevision: string | null;
  sourceHashes: DatasetSourceHashes;
  questions: QuestionCase[];
  excludedImageQuestionIds: string[];
  questionCount: number;
  trajectories: Map<string, Trajectory>;
  haystacks: Map<string, string[]>;
}

export interface DatasetLoadOptions {
  /** Supply explicit trusted hashes only for synthetic fixtures or a separately pinned snapshot. */
  expectedHashes?: DatasetSourceHashes;
  /** A custom snapshot has no revision unless its caller supplies one. */
  revision?: string;
}

export const PINNED_SOURCE_HASHES: DatasetSourceHashes = {
  'questions.jsonl': '0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7',
  'trajectories.jsonl': '363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6',
  'haystacks/lme_v2_small.json': '9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593',
};

const SOURCE_FILES = [
  { name: 'questions.jsonl', path: 'questions.jsonl' },
  { name: 'trajectories.jsonl', path: 'trajectories.jsonl' },
  { name: 'haystacks/lme_v2_small.json', path: 'haystacks/lme_v2_small.json' },
] as const;

interface RawQuestion {
  id?: unknown;
  domain?: unknown;
  question_type?: unknown;
  question?: unknown;
  image?: unknown;
}

interface RawState {
  state_index?: unknown;
  action?: unknown;
  accessibility_tree?: unknown;
}

interface RawTrajectory {
  id?: unknown;
  domain?: unknown;
  states?: unknown;
}

interface QuestionMetadata {
  question: QuestionCase;
  hasImage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDomain(value: unknown): value is BenchmarkDomain {
  return value === 'web' || value === 'enterprise';
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function requireId(value: unknown, field: string): string {
  if (!isSafeId(value)) throw new Error(`INVALID_ID: ${field}`);
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`INVALID_TEXT: ${field}`);
  }
  return value;
}

function requireDomain(value: unknown, field: string): BenchmarkDomain {
  if (!isDomain(value)) throw new Error(`INVALID_DOMAIN: ${field}`);
  return value;
}

function decodeUtf8(bytes: Buffer, field: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`INVALID_UTF8: ${field}`);
  }
}

function parseJsonLines(text: string, field: string): unknown[] {
  const rows: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const stripped = line.trim();
    if (stripped.length === 0) continue;
    try {
      rows.push(JSON.parse(stripped) as unknown);
    } catch {
      throw new Error(`INVALID_JSONL: ${field}:${index + 1}`);
    }
  }
  return rows;
}

function parseChecksumFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/u.exec(line);
    if (!match?.[1] || !match[2]) throw new Error(`INVALID_CHECKSUMS: line ${index + 1}`);
    const path = match[2].trim();
    if (entries.has(path)) throw new Error(`DUPLICATE_CHECKSUM_PATH: ${path}`);
    entries.set(path, match[1].toLowerCase());
  }
  return entries;
}

async function hashFile(filePath: string, relativePath: string): Promise<string> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new Error(`MISSING_DATA_FILE: ${relativePath}`);
    }
    throw error;
  }
}

async function parseTrajectoryFile(
  filePath: string,
  referencedIds: ReadonlySet<string>,
): Promise<Map<string, Trajectory>> {
  const trajectories = new Map<string, Trajectory>();
  const seenIds = new Set<string>();
  let lineNumber = 0;
  let input: ReturnType<typeof createReadStream>;
  try {
    input = createReadStream(filePath, { encoding: 'utf8' });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new Error('MISSING_DATA_FILE: trajectories.jsonl');
    }
    throw error;
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const stripped = line.trim();
      if (stripped.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(stripped) as unknown;
      } catch {
        throw new Error(`INVALID_JSONL: trajectories.jsonl:${lineNumber}`);
      }
      if (!isRecord(value)) throw new Error(`INVALID_TRAJECTORY: line ${lineNumber}`);
      const row = value as RawTrajectory;
      const id = requireId(row.id, `trajectories.jsonl:${lineNumber}.id`);
      if (seenIds.has(id)) throw new Error(`DUPLICATE_TRAJECTORY_ID: ${id}`);
      seenIds.add(id);
      const domain = requireDomain(row.domain, `trajectories.jsonl:${lineNumber}.domain`);
      if (!referencedIds.has(id)) continue;

      if (!Array.isArray(row.states) || row.states.length === 0) {
        throw new Error(`INVALID_STATES: ${id}`);
      }
      const states: TrajectoryState[] = [];
      let previousIndex = -1;
      for (const [statePosition, rawState] of row.states.entries()) {
        if (!isRecord(rawState)) throw new Error(`INVALID_STATE: ${id}:${statePosition}`);
        const state = rawState as RawState;
        const stateIndex = state.state_index;
        if (!Number.isSafeInteger(stateIndex) || (stateIndex as number) < 0 || (stateIndex as number) <= previousIndex) {
          throw new Error(`INVALID_STATE_INDEX: ${id}:${statePosition}`);
        }
        previousIndex = stateIndex as number;
        const action = state.action;
        if (action !== null && (typeof action !== 'string' || action.trim().length === 0)) {
          throw new Error(`INVALID_ACTION: ${id}:${statePosition}`);
        }
        const accessibilityTree = requireText(
          state.accessibility_tree,
          `trajectories.jsonl:${id}.states[${statePosition}].accessibility_tree`,
        );
        states.push({ stateIndex: stateIndex as number, action: action as string | null, accessibilityTree });
      }
      trajectories.set(id, { id, domain, states });
    }
  } catch (error) {
    input.destroy();
    throw error;
  }

  for (const id of referencedIds) {
    if (!seenIds.has(id)) throw new Error(`UNKNOWN_TRAJECTORY_ID: ${id}`);
    if (!trajectories.has(id)) throw new Error(`MISSING_TRAJECTORY_TEXT: ${id}`);
  }
  return trajectories;
}

function readTopLevelObjectKeys(text: string): string[] {
  let cursor = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(text[cursor] ?? '')) cursor += 1;
  };
  const readString = (): { value: string; end: number } => {
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor];
      cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        return { value: JSON.parse(text.slice(start, cursor)) as string, end: cursor };
      }
    }
    throw new Error('INVALID_HAYSTACK_JSON');
  };
  const skipValue = (): void => {
    skipWhitespace();
    const start = cursor;
    const first = text[cursor];
    if (first === '"') {
      cursor = readString().end;
      return;
    }
    if (first === '[' || first === '{') {
      const closers: string[] = [first === '[' ? ']' : '}'];
      cursor += 1;
      let escaped = false;
      while (cursor < text.length && closers.length > 0) {
        const char = text[cursor];
        cursor += 1;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          while (cursor < text.length) {
            const stringChar = text[cursor];
            cursor += 1;
            if (escaped) {
              escaped = false;
            } else if (stringChar === '\\') {
              escaped = true;
            } else if (stringChar === '"') {
              break;
            }
          }
        } else if (char === '[') {
          closers.push(']');
        } else if (char === '{') {
          closers.push('}');
        } else if (char === ']' || char === '}') {
          if (closers.pop() !== char) throw new Error('INVALID_HAYSTACK_JSON');
        }
      }
      if (closers.length > 0) throw new Error('INVALID_HAYSTACK_JSON');
      return;
    }
    while (cursor < text.length && !/[\s,}\]]/u.test(text[cursor] ?? '')) cursor += 1;
    if (cursor === start) throw new Error('INVALID_HAYSTACK_JSON');
  };

  skipWhitespace();
  if (text[cursor] !== '{') throw new Error('INVALID_HAYSTACK_JSON');
  cursor += 1;
  const keys: string[] = [];
  skipWhitespace();
  if (text[cursor] === '}') return keys;
  while (cursor < text.length) {
    skipWhitespace();
    if (text[cursor] !== '"') throw new Error('INVALID_HAYSTACK_JSON');
    const key = readString();
    keys.push(key.value);
    cursor = key.end;
    skipWhitespace();
    if (text[cursor] !== ':') throw new Error('INVALID_HAYSTACK_JSON');
    cursor += 1;
    skipValue();
    skipWhitespace();
    if (text[cursor] === '}') return keys;
    if (text[cursor] !== ',') throw new Error('INVALID_HAYSTACK_JSON');
    cursor += 1;
  }
  throw new Error('INVALID_HAYSTACK_JSON');
}

function parseHaystack(text: string, questionMetadata: ReadonlyMap<string, QuestionMetadata>): Map<string, string[]> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('INVALID_HAYSTACK_JSON');
  }
  if (!isRecord(value)) throw new Error('INVALID_HAYSTACK_OBJECT');
  const orderedKeys = readTopLevelObjectKeys(text);
  const seenQuestionIds = new Set<string>();
  for (const questionId of orderedKeys) {
    requireId(questionId, 'haystack question id');
    if (seenQuestionIds.has(questionId)) throw new Error(`DUPLICATE_HAYSTACK_QUESTION_ID: ${questionId}`);
    seenQuestionIds.add(questionId);
  }

  const haystacks = new Map<string, string[]>();
  const referencedIds = new Set<string>();
  for (const [questionId, rawIds] of Object.entries(value)) {
    if (!questionMetadata.has(questionId)) throw new Error(`UNKNOWN_HAYSTACK_QUESTION_ID: ${questionId}`);
    if (!Array.isArray(rawIds) || rawIds.length !== 100) {
      throw new Error(`INVALID_HAYSTACK_SIZE: ${questionId}`);
    }
    const seenTrajectoryIds = new Set<string>();
    const trajectoryIds: string[] = [];
    for (const [index, rawId] of rawIds.entries()) {
      const trajectoryId = requireId(rawId, `haystack ${questionId}[${index}]`);
      if (seenTrajectoryIds.has(trajectoryId)) {
        throw new Error(`DUPLICATE_HAYSTACK_TRAJECTORY_ID: ${questionId}:${trajectoryId}`);
      }
      seenTrajectoryIds.add(trajectoryId);
      referencedIds.add(trajectoryId);
      trajectoryIds.push(trajectoryId);
    }
    haystacks.set(questionId, trajectoryIds);
  }
  if (haystacks.size !== questionMetadata.size) throw new Error('HAYSTACK_QUESTION_COUNT_MISMATCH');
  for (const questionId of questionMetadata.keys()) {
    if (!haystacks.has(questionId)) throw new Error(`MISSING_HAYSTACK: ${questionId}`);
  }
  return haystacks;
}

async function requireSourceHashes(
  root: string,
  expectedHashes: DatasetSourceHashes,
): Promise<DatasetSourceHashes> {
  const checksumPath = join(root, 'checksums.sha256');
  let checksumText: string;
  try {
    checksumText = decodeUtf8(await readFile(checksumPath), 'checksums.sha256');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') throw new Error('MISSING_DATA_FILE: checksums.sha256');
    throw error;
  }
  const checksumEntries = parseChecksumFile(checksumText);
  const sourceHashes = {} as DatasetSourceHashes;
  for (const source of SOURCE_FILES) {
    const expected = expectedHashes[source.name];
    if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error(`INVALID_EXPECTED_HASH: ${source.name}`);
    if (checksumEntries.get(source.name) !== expected) {
      throw new Error(`PUBLISHED_HASH_MISMATCH: ${source.name}`);
    }
    const actual = await hashFile(join(root, source.path), source.name);
    if (actual !== expected) throw new Error(`DATA_HASH_MISMATCH: ${source.name}`);
    sourceHashes[source.name] = actual;
  }
  return sourceHashes;
}

async function readRequiredText(root: string, relativePath: string): Promise<string> {
  try {
    return decodeUtf8(await readFile(join(root, relativePath)), relativePath);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') throw new Error(`MISSING_DATA_FILE: ${relativePath}`);
    throw error;
  }
}

export async function loadDataset(root: string, options: DatasetLoadOptions = {}): Promise<BenchmarkDataset> {
  if (!isAbsolute(root)) throw new Error('DATA_ROOT_NOT_ABSOLUTE');
  try {
    await access(root);
  } catch {
    throw new Error('DATA_ROOT_MISSING');
  }

  const expectedHashes = options.expectedHashes ?? PINNED_SOURCE_HASHES;
  const sourceHashes = await requireSourceHashes(root, expectedHashes);
  const questionRows = parseJsonLines(await readRequiredText(root, 'questions.jsonl'), 'questions.jsonl');
  const questionMetadata = new Map<string, QuestionMetadata>();
  const questions: QuestionCase[] = [];
  const excludedImageQuestionIds: string[] = [];

  for (const [index, value] of questionRows.entries()) {
    if (!isRecord(value)) throw new Error(`INVALID_QUESTION: line ${index + 1}`);
    const row = value as RawQuestion;
    const id = requireId(row.id, `questions.jsonl:${index + 1}.id`);
    if (questionMetadata.has(id)) throw new Error(`DUPLICATE_QUESTION_ID: ${id}`);
    const domain = requireDomain(row.domain, `questions.jsonl:${id}.domain`);
    const questionType = requireText(row.question_type, `questions.jsonl:${id}.question_type`);
    const question = requireText(row.question, `questions.jsonl:${id}.question`);
    const hasImage = row.image !== null;
    if (hasImage && (typeof row.image !== 'string' || row.image.trim().length === 0)) {
      throw new Error(`INVALID_QUESTION_IMAGE_FIELD: ${id}`);
    }
    const questionCase = { id, domain, questionType, question };
    questionMetadata.set(id, { question: questionCase, hasImage });
    if (hasImage) excludedImageQuestionIds.push(id);
    else questions.push(questionCase);
  }

  const haystackText = await readRequiredText(root, 'haystacks/lme_v2_small.json');
  const haystacks = parseHaystack(haystackText, questionMetadata);
  const referencedIds = new Set<string>();
  for (const ids of haystacks.values()) for (const id of ids) referencedIds.add(id);
  const trajectories = await parseTrajectoryFile(join(root, 'trajectories.jsonl'), referencedIds);

  for (const [questionId, trajectoryIds] of haystacks) {
    const question = questionMetadata.get(questionId)?.question;
    if (!question) throw new Error(`UNKNOWN_HAYSTACK_QUESTION_ID: ${questionId}`);
    for (const trajectoryId of trajectoryIds) {
      const trajectory = trajectories.get(trajectoryId);
      if (!trajectory) throw new Error(`UNKNOWN_TRAJECTORY_ID: ${trajectoryId}`);
      if (trajectory.domain !== question.domain) {
        throw new Error(`CROSS_DOMAIN_HAYSTACK: ${questionId}:${trajectoryId}`);
      }
    }
  }

  if (!questions.some(question => question.domain === 'web')) throw new Error('NO_ELIGIBLE_QUESTIONS: web');
  if (!questions.some(question => question.domain === 'enterprise')) {
    throw new Error('NO_ELIGIBLE_QUESTIONS: enterprise');
  }

  return {
    datasetRevision: options.revision ?? (options.expectedHashes === undefined ? DATASET_REVISION : null),
    sourceHashes,
    questions,
    excludedImageQuestionIds: excludedImageQuestionIds.sort(compareText),
    questionCount: questionRows.length,
    trajectories,
    haystacks,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectCases(
  dataset: BenchmarkDataset,
  set: 'pilot' | 'full',
  pilotIds: readonly string[],
): QuestionCase[] {
  if (set === 'full') return [...dataset.questions].sort((left, right) => compareText(left.id, right.id));
  if (pilotIds.length === 0) throw new Error('EMPTY_PILOT_IDS');
  const byId = new Map(dataset.questions.map(question => [question.id, question]));
  const seen = new Set<string>();
  return pilotIds.map(id => {
    if (!isSafeId(id)) throw new Error(`INVALID_PILOT_ID: ${id}`);
    if (seen.has(id)) throw new Error(`DUPLICATE_PILOT_ID: ${id}`);
    seen.add(id);
    const question = byId.get(id);
    if (!question) throw new Error(`INELIGIBLE_PILOT_ID: ${id}`);
    return question;
  });
}

function splitUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error('UTF8_CHUNK_LIMIT_TOO_SMALL');
  if (text.length === 0) return [''];
  const bytes = Buffer.from(text, 'utf8');
  const pieces: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length);
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    if (end <= offset) throw new Error('UTF8_SPLIT_FAILED');
    pieces.push(bytes.subarray(offset, end).toString('utf8'));
    offset = end;
  }
  return pieces;
}

function appendObservation(chunks: string[], heading: string, observation: string): void {
  const whole = `${heading}:\n${observation}`;
  if (Buffer.byteLength(whole, 'utf8') <= MAX_RENDERED_CHUNK_BYTES) {
    chunks.push(whole);
    return;
  }

  const partHeaderBytes = Buffer.byteLength(`${heading} (part 000000/000000):\n`, 'utf8');
  const payloadLimit = MAX_RENDERED_CHUNK_BYTES - partHeaderBytes - 8;
  const pieces = splitUtf8(observation, payloadLimit);
  pieces.forEach((piece, index) => {
    const partHeading = `${heading} (part ${index + 1}/${pieces.length}):\n`;
    const chunk = `${partHeading}${piece}`;
    if (Buffer.byteLength(chunk, 'utf8') > MAX_RENDERED_CHUNK_BYTES) {
      throw new Error('RENDERED_CHUNK_LIMIT_EXCEEDED');
    }
    chunks.push(chunk);
  });
}

export function renderTrajectory(trajectory: Trajectory): string[] {
  const chunks: string[] = [];
  for (const state of trajectory.states) {
    appendObservation(
      chunks,
      `State ${state.stateIndex} action`,
      state.action ?? '(no action)',
    );
    appendObservation(
      chunks,
      `State ${state.stateIndex} accessibility tree`,
      state.accessibilityTree,
    );
  }
  return chunks;
}
