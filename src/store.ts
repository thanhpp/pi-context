import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lock as acquireFileLock } from 'proper-lockfile';
import type { ProjectPolicy } from './config.ts';
import { ContextError } from './errors.ts';
import { ecc } from './ecc.ts';
import type { MemoryRecord } from './ecc.ts';
import type { ProjectIdentity } from './project.ts';

const CONTROL_LIMIT = 4_096;
const METADATA_LIMIT = 16 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 30_000;
const GITIGNORE = '*\n!.gitignore\n';
const RECORD_DIRECTORIES = new Set([
  'contexts', 'decisions', 'facts', 'handoffs', 'lessons', 'notes', 'preferences', 'runbooks',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MEMORY_KINDS = new Set<MemoryRecord['kind']>([
  'context', 'decision', 'fact', 'handoff', 'lesson', 'note', 'preference', 'runbook',
]);
const queues = new Map<string, Promise<void>>();

type JsonRecord = Record<string, unknown>;
type StatInfo = Awaited<ReturnType<typeof lstat>>;
type FileEntry = { absolutePath: string; relativePath: string; bytes: number; kind: 'file' | 'symlink' | 'other' };

export type RecordCategory = 'session' | 'structure' | 'decision' | 'other';
export interface SessionSource {
  sessionId: string;
  worktreeRoot: string;
  head: string | null;
}
export interface RecordMeta {
  category: RecordCategory;
  pinned: boolean;
  expiresAt: string | null;
  provenance: SessionSource[];
  sourceRefs: string[];
  consolidatedFrom: string[];
}
export interface StoreMetadata {
  version: 1;
  identityKey: string;
  records: Record<string, RecordMeta>;
}
export interface SnapshotView {
  revision: string;
  baseDir: string;
  metadata: StoreMetadata;
}
export interface SnapshotMutation<T> {
  writes: Array<{ relativePath: string; content: string }>;
  deletes: string[];
  metadata: StoreMetadata;
  value: T;
}
export interface CommitResult<T> {
  revision: string;
  value: T;
  maintenance: 'clean' | 'pending';
}
export interface StoreStatus {
  revision: string | null;
  persistentBytes: number;
  temporaryBytes: number;
  limitBytes: number;
  overLimit: boolean;
  needsRecovery: boolean;
}
export interface MutationEstimate {
  persistentBytes: number;
  projectedBytes: number;
  additionalTemporaryBytes: number;
}
export interface MemoryStore {
  readonly project: ProjectIdentity;
  readonly policy: ProjectPolicy;
  inspect(signal?: AbortSignal): Promise<StoreStatus>;
  withSnapshot<T>(read: (snapshot: SnapshotView | null) => T, signal?: AbortSignal): Promise<T>;
  estimate<T>(expectedRevision: string | null, mutation: SnapshotMutation<T>, signal?: AbortSignal): Promise<MutationEstimate>;
  commit<T>(expectedRevision: string | null, mutation: SnapshotMutation<T>, signal?: AbortSignal): Promise<CommitResult<T>>;
}
export type StorePhase = 'staged' | 'before_publish' | 'published' | 'before_gc';
export interface StoreOptions {
  onPhase?: (phase: StorePhase) => void;
}

interface Pointer {
  version: 1;
  revision: string;
}
interface Transaction {
  version: 1;
  oldRevision: string | null;
  newRevision: string;
}
interface OperationState {
  readonly startedAt: number;
  readonly signal?: AbortSignal;
  compromised: boolean;
  published: boolean;
  releaseFailed: boolean;
}
interface RootState {
  exists: boolean;
  directory: string;
  canonicalKey: string;
}
interface ValidatedMutation<T> {
  mutation: SnapshotMutation<T>;
  writes: Map<string, Buffer>;
  deletes: Set<string>;
  metadataText: string;
  metadata: StoreMetadata;
}

function fail(code: string, message: string, details?: Record<string, unknown>): ContextError {
  return new ContextError(code, message, details);
}
function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unknownKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw fail('STORE_INVALID', `${label} contains an unknown field.`, { field: key });
  }
}
function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
function assertUuid(value: unknown, label: string): asserts value is string {
  if (!isUuid(value)) throw fail('STORE_INVALID', `${label} must be a UUID.`, { field: label });
}
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function validateId(value: unknown, label: string): string {
  try {
    return ecc.validateMemoryId(value);
  } catch {
    throw fail('STORE_INVALID', `${label} is not a valid record ID.`, { field: label });
  }
}
function validateMetadata(value: unknown, identityKey: string): StoreMetadata {
  if (!isObject(value)) throw fail('STORE_INVALID', 'Metadata must be an object.');
  unknownKeys(value, ['version', 'identityKey', 'records'], 'Metadata');
  if (value.version !== 1) throw fail('STORE_INVALID', 'Metadata version is not supported.');
  if (value.identityKey !== identityKey) throw fail('STORE_INVALID', 'Metadata project identity does not match.');
  if (!isObject(value.records)) throw fail('STORE_INVALID', 'Metadata records must be an object.');
  const records: Record<string, RecordMeta> = {};
  for (const [rawId, rawMeta] of Object.entries(value.records)) {
    const id = validateId(rawId, 'metadata record key');
    if (id !== rawId) throw fail('STORE_INVALID', 'Metadata record key is invalid.');
    if (!isObject(rawMeta)) throw fail('STORE_INVALID', 'Record metadata must be an object.', { id });
    unknownKeys(rawMeta, ['category', 'pinned', 'expiresAt', 'provenance', 'sourceRefs', 'consolidatedFrom'], 'Record metadata');
    const categories = new Set(['session', 'structure', 'decision', 'other']);
    if (!categories.has(String(rawMeta.category))) throw fail('STORE_INVALID', 'Record category is invalid.', { id });
    if (typeof rawMeta.pinned !== 'boolean') throw fail('STORE_INVALID', 'Record pinned value must be boolean.', { id });
    if (rawMeta.expiresAt !== null && !canonicalTimestamp(rawMeta.expiresAt)) {
      throw fail('STORE_INVALID', 'Record expiry must be a canonical timestamp or null.', { id });
    }
    if (!Array.isArray(rawMeta.provenance)) throw fail('STORE_INVALID', 'Record provenance must be an array.', { id });
    const provenance: SessionSource[] = rawMeta.provenance.map((source: unknown) => {
      if (!isObject(source)) throw fail('STORE_INVALID', 'Session provenance must be an object.', { id });
      unknownKeys(source, ['sessionId', 'worktreeRoot', 'head'], 'Session provenance');
      if (typeof source.sessionId !== 'string' || source.sessionId.length === 0 ||
          typeof source.worktreeRoot !== 'string' || source.worktreeRoot.length === 0 ||
          (source.head !== null && typeof source.head !== 'string')) {
        throw fail('STORE_INVALID', 'Session provenance fields are invalid.', { id });
      }
      return { sessionId: source.sessionId, worktreeRoot: source.worktreeRoot, head: source.head };
    });
    const refs = (name: 'sourceRefs' | 'consolidatedFrom'): string[] => {
      const raw = rawMeta[name];
      if (!Array.isArray(raw)) throw fail('STORE_INVALID', `Record ${name} must be an array.`, { id });
      const values = raw.map((entry: unknown) => {
        if (name === 'sourceRefs') {
          if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 2_048 ||
              ecc.hasUnsafeControlCharacters(entry)) {
            throw fail('STORE_INVALID', 'Record source references must be safe non-empty strings of at most 2,048 characters.', { id });
          }
          return entry;
        }
        return validateId(entry, `record ${name}`);
      });
      if (new Set(values).size !== values.length) {
        throw fail('STORE_INVALID', `Record ${name} cannot contain duplicate values.`, { id });
      }
      return values;
    };
    records[id] = {
      category: rawMeta.category as RecordCategory,
      pinned: rawMeta.pinned,
      expiresAt: rawMeta.expiresAt as string | null,
      provenance,
      sourceRefs: refs('sourceRefs'),
      consolidatedFrom: refs('consolidatedFrom'),
    };
  }
  return { version: 1, identityKey, records };
}
function encodeMetadata(metadata: StoreMetadata, identityKey: string): { metadata: StoreMetadata; text: string; bytes: Buffer } {
  const validated = validateMetadata(metadata, identityKey);
  let text: string;
  try {
    text = `${JSON.stringify(validated)}\n`;
  } catch {
    throw fail('STORE_INVALID', 'Metadata cannot be serialized.');
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > METADATA_LIMIT) {
    throw fail('STORE_INVALID', 'Serialized metadata exceeds the 16 MiB limit.', { metadataBytes: bytes.length });
  }
  return { metadata: validated, text, bytes };
}
function rejectDuplicateJsonKeys(text: string, label: string): void {
  const skipSpace = (index: number): number => {
    while (/\s/u.test(text[index] ?? '')) index += 1;
    return index;
  };
  const stringEnd = (start: number): number => {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index] === '"') return index + 1;
      else index += 1;
    }
    return index;
  };
  const scan = (start: number): number => {
    let index = skipSpace(start);
    if (text[index] === '{') {
      index = skipSpace(index + 1);
      const keys = new Set<string>();
      if (text[index] === '}') return index + 1;
      while (index < text.length) {
        const end = stringEnd(index);
        const key = JSON.parse(text.slice(index, end)) as string;
        if (keys.has(key)) throw fail('STORE_INVALID', `${label} contains duplicate object fields.`, { field: key });
        keys.add(key);
        index = skipSpace(end);
        index = skipSpace(index + 1);
        index = scan(index);
        index = skipSpace(index);
        if (text[index] === ',') index = skipSpace(index + 1);
        else return index + 1;
      }
    }
    if (text[index] === '[') {
      index = skipSpace(index + 1);
      if (text[index] === ']') return index + 1;
      while (index < text.length) {
        index = scan(index);
        index = skipSpace(index);
        if (text[index] === ',') index = skipSpace(index + 1);
        else return index + 1;
      }
    }
    if (text[index] === '"') return stringEnd(index);
    while (index < text.length && !/[\s,\]}]/u.test(text[index] ?? '')) index += 1;
    return index;
  };
  scan(0);
}
function parseJson(text: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw fail('STORE_INVALID', `${label} contains invalid JSON.`);
  }
  rejectDuplicateJsonKeys(text, label);
  return parsed;
}
function parsePointer(text: string): Pointer {
  const raw = parseJson(text, 'Current pointer');
  if (!isObject(raw)) throw fail('STORE_INVALID', 'Current pointer must be an object.');
  unknownKeys(raw, ['version', 'revision'], 'Current pointer');
  if (raw.version !== 1) throw fail('STORE_INVALID', 'Current pointer version is not supported.');
  assertUuid(raw.revision, 'Current pointer revision');
  return { version: 1, revision: raw.revision };
}
function parseTransaction(text: string): Transaction {
  const raw = parseJson(text, 'Transaction record');
  if (!isObject(raw)) throw fail('STORE_INVALID', 'Transaction record must be an object.');
  unknownKeys(raw, ['version', 'oldRevision', 'newRevision'], 'Transaction record');
  if (raw.version !== 1) throw fail('STORE_INVALID', 'Transaction version is not supported.');
  if (raw.oldRevision !== null) assertUuid(raw.oldRevision, 'Transaction old revision');
  assertUuid(raw.newRevision, 'Transaction new revision');
  if (raw.oldRevision === raw.newRevision) throw fail('STORE_INVALID', 'Transaction revisions must be different.');
  return { version: 1, oldRevision: raw.oldRevision as string | null, newRevision: raw.newRevision };
}
function pointerText(revision: string): string {
  return `${JSON.stringify({ version: 1, revision })}\n`;
}
function transactionText(oldRevision: string | null, newRevision: string): string {
  return `${JSON.stringify({ version: 1, oldRevision, newRevision })}\n`;
}
function metadataTextFromDisk(text: string, identityKey: string): StoreMetadata {
  return validateMetadata(parseJson(text, 'Metadata'), identityKey);
}
async function pathInfo(filePath: string): Promise<StatInfo | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
async function assertDirectory(filePath: string, label: string): Promise<boolean> {
  const info = await pathInfo(filePath);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw fail('STORE_UNSAFE', `${label} must be a non-symlink directory.`, { path: filePath });
  }
  return true;
}
async function validateRoot(project: ProjectIdentity, create: boolean): Promise<RootState> {
  if (!path.isAbsolute(project.memoryDir) || path.resolve(project.memoryDir) !== project.memoryDir) {
    throw fail('STORE_UNSAFE', 'Project memory directory must be an absolute normalized path.');
  }
  const directory = project.memoryDir;
  const rootPart = path.parse(directory).root;
  const remaining = directory.slice(rootPart.length).split(path.sep).filter(Boolean);
  let cursor = rootPart;
  let exists = true;
  for (const part of remaining) {
    cursor = path.join(cursor, part);
    let info = await pathInfo(cursor);
    if (!info) {
      exists = false;
      if (!create) break;
      let created = false;
      try {
        await mkdir(cursor, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (created) await syncDirectory(path.dirname(cursor));
      info = await pathInfo(cursor);
    }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw fail('STORE_UNSAFE', 'Project memory path components must be non-symlink directories.', { path: cursor });
    }
  }
  if (create) exists = true;
  let canonicalKey = directory;
  if (exists) {
    try {
      canonicalKey = await realpath(directory);
    } catch {
      throw fail('STORE_UNSAFE', 'Project memory root cannot be resolved safely.');
    }
    if (canonicalKey !== directory) throw fail('STORE_UNSAFE', 'Project memory root resolves through a symlink.');
  }
  return { exists, directory, canonicalKey };
}
function operation(signal?: AbortSignal): OperationState {
  return { startedAt: Date.now(), signal, compromised: false, published: false, releaseFailed: false };
}
function checkOperation(state: OperationState): void {
  if (state.signal?.aborted) throw fail('STORE_ABORTED', 'The store operation was aborted.');
  if (state.compromised) throw fail('STORE_LOCK_COMPROMISED', 'The project lock was compromised.');
  if (Date.now() - state.startedAt >= OPERATION_TIMEOUT_MS) {
    throw fail('STORE_DEADLINE', 'The store operation exceeded its 30-second deadline.');
  }
}
async function inQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let finish!: () => void;
  const current = new Promise<void>(resolve => { finish = resolve; });
  queues.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    finish();
    if (queues.get(key) === current) queues.delete(key);
  }
}
function lockRetries(): { retries: { retries: number; minTimeout: number; maxTimeout: number; factor: number; randomize: boolean } } {
  return { retries: { retries: 4, minTimeout: 250, maxTimeout: 250, factor: 1, randomize: false } };
}
async function acquireLock(directory: string, state: OperationState): Promise<() => Promise<void>> {
  checkOperation(state);
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const lockPromise = acquireFileLock(directory, {
    ...lockRetries(),
    lockfilePath: path.join(directory, '.lock'),
    stale: 120_000,
    update: 10_000,
    onCompromised: () => { state.compromised = true; },
  }).then(async release => {
    if (timedOut || state.signal?.aborted || Date.now() - state.startedAt >= OPERATION_TIMEOUT_MS) {
      await release().catch(() => undefined);
      throw fail(state.signal?.aborted ? 'STORE_ABORTED' : 'STORE_BUSY', 'Project lock acquisition ended too late.');
    }
    return release;
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(fail('STORE_BUSY', 'Could not acquire the project lock within 5 seconds.'));
    }, Math.min(LOCK_TIMEOUT_MS, Math.max(1, OPERATION_TIMEOUT_MS - (Date.now() - state.startedAt))));
    if (state.signal) {
      abortListener = () => {
        timedOut = true;
        reject(fail('STORE_ABORTED', 'The store operation was aborted while waiting for the lock.'));
      };
      state.signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  try {
    return await Promise.race([lockPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) void lockPromise.then(release => release().catch(() => undefined), () => undefined);
    if (error instanceof ContextError) throw error;
    if (errorCode(error) === 'ELOCKED') throw fail('STORE_BUSY', 'Another process holds the project lock.');
    throw fail('STORE_BUSY', 'Could not acquire the project lock.', { cause: errorCode(error) ?? 'unknown' });
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener && state.signal) state.signal.removeEventListener('abort', abortListener);
  }
}
async function checkHeldLock(directory: string, state: OperationState): Promise<void> {
  try {
    if (!(await assertDirectory(path.join(directory, '.lock'), 'Project lock path'))) state.compromised = true;
  } catch {
    state.compromised = true;
  }
  checkOperation(state);
}
async function withLock<T>(root: RootState, state: OperationState, run: () => Promise<T>): Promise<T> {
  if (!root.exists) return run();
  await assertDirectory(path.join(root.directory, '.lock'), 'Project lock path');
  const release = await acquireLock(root.directory, state);
  let operationFailed = false;
  let operationError: unknown;
  try {
    const result = await run();
    if (state.published) {
      if (state.compromised || state.signal?.aborted) state.releaseFailed = true;
      try {
        await checkHeldLock(root.directory, state);
      } catch {
        state.releaseFailed = true;
      }
    } else {
      await checkHeldLock(root.directory, state);
    }
    return result;
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch {
      if (state.published) state.releaseFailed = true;
      else if (!state.compromised && operationFailed && operationError instanceof ContextError) {
        Object.defineProperty(operationError, 'details', {
          configurable: true,
          value: { ...(operationError.details ?? {}), recoveryRequired: true },
        });
      } else if (!state.compromised && operationFailed && operationError instanceof Error) {
        Object.defineProperty(operationError, 'recoveryRequired', { configurable: true, value: true });
      } else if (!state.compromised && !operationFailed) {
        throw fail('STORE_BUSY', 'The project lock could not be released safely.');
      }
    }
  }
}
async function readSafe(filePath: string, trustedRoot: string, maxBytes: number, label: string): Promise<string | undefined> {
  const info = await pathInfo(filePath);
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw fail('STORE_UNSAFE', `${label} must be a regular, non-symlink file.`, { path: filePath });
  }
  try {
    return ecc.readRegularTextFile(filePath, { trustedRoot, maxBytes, label });
  } catch (error) {
    if (error instanceof ContextError) throw error;
    throw fail('STORE_INVALID', `${label} cannot be read safely.`, { cause: errorCode(error) ?? 'invalid-file' });
  }
}
async function readPointer(root: string): Promise<Pointer | null> {
  const text = await readSafe(path.join(root, 'current.json'), root, CONTROL_LIMIT, 'current pointer');
  return text === undefined ? null : parsePointer(text);
}
async function readTransaction(root: string): Promise<Transaction | null> {
  const text = await readSafe(path.join(root, 'transaction.json'), root, CONTROL_LIMIT, 'transaction record');
  return text === undefined ? null : parseTransaction(text);
}
function generationPath(root: string, revision: string): string {
  assertUuid(revision, 'Generation revision');
  return path.join(root, 'generations', revision);
}
async function generationExists(root: string, revision: string): Promise<boolean> {
  const directory = path.join(root, 'generations');
  if (!(await assertDirectory(directory, 'Generation root'))) return false;
  return assertDirectory(generationPath(root, revision), 'Generation');
}
async function readGenerationMetadata(project: ProjectIdentity, revision: string): Promise<StoreMetadata> {
  const root = project.memoryDir;
  const generations = path.join(root, 'generations');
  if (!(await assertDirectory(generations, 'Generation root'))) {
    throw fail('STORE_RECOVERY_REQUIRED', 'The generation root is missing.', { revision });
  }
  const generation = generationPath(root, revision);
  if (!(await assertDirectory(generation, 'Generation'))) {
    throw fail('STORE_RECOVERY_REQUIRED', 'The current snapshot generation is missing.', { revision });
  }
  const metadataPath = path.join(generation, 'metadata.json');
  const text = await readSafe(metadataPath, generation, METADATA_LIMIT, 'metadata file');
  if (text === undefined) throw fail('STORE_RECOVERY_REQUIRED', 'The snapshot metadata file is missing.', { revision });
  if (!(await assertDirectory(path.join(generation, 'project'), 'Snapshot project root'))) {
    throw fail('STORE_RECOVERY_REQUIRED', 'The snapshot project directory is missing.', { revision });
  }
  return metadataTextFromDisk(text, project.identityKey);
}
async function generationFiles(generation: string): Promise<FileEntry[]> {
  const projectRoot = path.join(generation, 'project');
  if (!(await assertDirectory(projectRoot, 'Snapshot project root'))) {
    throw fail('STORE_RECOVERY_REQUIRED', 'The current snapshot project directory is missing.');
  }
  const files: FileEntry[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const info = await lstat(absolutePath);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await visit(absolutePath, relativePath);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        files.push({ absolutePath, relativePath, bytes: info.size, kind: 'file' });
      } else {
        files.push({ absolutePath, relativePath, bytes: info.isSymbolicLink() ? info.size : 0, kind: info.isSymbolicLink() ? 'symlink' : 'other' });
      }
    }
  }
  await visit(projectRoot, '');
  return files;
}
async function generationExtraFiles(generation: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(absolutePath: string, relativePath: string): Promise<void> {
    const info = await lstat(absolutePath);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const child of await readdir(absolutePath)) {
        await visit(path.join(absolutePath, child), relativePath ? `${relativePath}/${child}` : child);
      }
      return;
    }
    const kind = info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : 'other';
    files.push({ absolutePath, relativePath, bytes: kind === 'other' ? 0 : info.size, kind });
  }
  for (const name of await readdir(generation)) {
    if (name === 'metadata.json' || name === 'project') continue;
    await visit(path.join(generation, name), name);
  }
  return files;
}
async function walkBytes(target: string): Promise<{ bytes: number; entries: FileEntry[] }> {
  const info = await pathInfo(target);
  if (!info) return { bytes: 0, entries: [] };
  const entries: FileEntry[] = [];
  let bytes = 0;
  async function visit(absolutePath: string, relativePath: string): Promise<void> {
    const current = await lstat(absolutePath);
    if (current.isDirectory() && !current.isSymbolicLink()) {
      const children = await readdir(absolutePath);
      for (const child of children) {
        await visit(path.join(absolutePath, child), relativePath ? `${relativePath}/${child}` : child);
      }
      return;
    }
    const kind = current.isSymbolicLink() ? 'symlink' : current.isFile() ? 'file' : 'other';
    const fileBytes = kind === 'other' ? 0 : current.size;
    bytes += fileBytes;
    entries.push({ absolutePath, relativePath, bytes: fileBytes, kind });
  }
  await visit(target, '');
  return { bytes, entries };
}
async function persistentBytes(root: string): Promise<number> {
  const info = await pathInfo(root);
  if (!info) return 0;
  if (info.isSymbolicLink() || !info.isDirectory()) throw fail('STORE_UNSAFE', 'Project memory root is not a safe directory.');
  let total = 0;
  for (const name of await readdir(root)) {
    if (name === '.staging') continue;
    total += (await walkBytes(path.join(root, name))).bytes;
  }
  return total;
}
async function temporaryBytes(root: string): Promise<number> {
  return (await walkBytes(path.join(root, '.staging'))).bytes;
}
async function generationNames(root: string): Promise<string[]> {
  const directory = path.join(root, 'generations');
  if (!(await assertDirectory(directory, 'Generation root'))) return [];
  return readdir(directory);
}
async function stagingNames(root: string): Promise<string[]> {
  const directory = path.join(root, '.staging');
  if (!(await assertDirectory(directory, 'Staging root'))) return [];
  return readdir(directory);
}
async function removeRecognizedStage(root: string, revision: string): Promise<void> {
  assertUuid(revision, 'Staging revision');
  const stagingRoot = path.join(root, '.staging');
  if (await assertDirectory(stagingRoot, 'Staging root')) {
    await rm(path.join(stagingRoot, revision), { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
    await rm(path.join(stagingRoot, `${revision}.current`), { force: true });
  }
}
async function removeGeneration(root: string, revision: string): Promise<void> {
  assertUuid(revision, 'Generation revision');
  const generations = path.join(root, 'generations');
  if (!(await assertDirectory(generations, 'Generation root'))) return;
  const generation = generationPath(root, revision);
  if (!(await assertDirectory(generation, 'Generation'))) return;
  await rm(generation, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
}
async function recover(project: ProjectIdentity): Promise<{ pointer: Pointer | null; metadata: StoreMetadata | null }> {
  const root = project.memoryDir;
  const pointer = await readPointer(root);
  const transaction = await readTransaction(root);
  if (!transaction) {
    if ((await stagingNames(root)).length > 0) {
      throw fail('STORE_RECOVERY_REQUIRED', 'Unrecognized staging data needs recovery.');
    }
    if (!pointer) {
      if ((await generationNames(root)).length > 0) {
        throw fail('STORE_RECOVERY_REQUIRED', 'A missing current pointer has generation data.');
      }
      return { pointer: null, metadata: null };
    }
    const metadata = await readGenerationMetadata(project, pointer.revision);
    return { pointer, metadata };
  }

  const newRevision = transaction.newRevision;
  const oldRevision = transaction.oldRevision;
  const stageEntries = await stagingNames(root);
  if (stageEntries.some(name => name !== newRevision && name !== `${newRevision}.current`)) {
    throw fail('STORE_RECOVERY_REQUIRED', 'Unknown staging data is present.');
  }
  const newExists = await generationExists(root, newRevision);
  if (pointer?.revision === newRevision) {
    if (!newExists) throw fail('STORE_RECOVERY_REQUIRED', 'The published snapshot generation is missing.', { revision: newRevision });
    await readGenerationMetadata(project, newRevision);
    await removeRecognizedStage(root, newRevision);
    if (oldRevision && oldRevision !== newRevision) await removeGeneration(root, oldRevision);
    await syncDirectoryIfPresent(path.join(root, 'generations'), 'Generation root');
    await syncDirectoryIfPresent(path.join(root, '.staging'), 'Staging root');
    await unlink(path.join(root, 'transaction.json'));
    await syncDirectory(root);
    return { pointer, metadata: await readGenerationMetadata(project, newRevision) };
  }
  const unpublished = (oldRevision === null && pointer === null) || pointer?.revision === oldRevision;
  if (!unpublished) throw fail('STORE_RECOVERY_REQUIRED', 'Current pointer and transaction record disagree.');
  if (oldRevision !== null && !(await generationExists(root, oldRevision))) {
    throw fail('STORE_RECOVERY_REQUIRED', 'The previous snapshot generation is missing.', { revision: oldRevision });
  }
  const otherGenerations = (await generationNames(root)).filter(name => name !== newRevision);
  if (oldRevision === null && otherGenerations.length > 0) {
    throw fail('STORE_RECOVERY_REQUIRED', 'Unrecognized generation data exists without a current pointer.');
  }
  await removeRecognizedStage(root, newRevision);
  if (newExists) await removeGeneration(root, newRevision);
  await syncDirectoryIfPresent(path.join(root, 'generations'), 'Generation root');
  await syncDirectoryIfPresent(path.join(root, '.staging'), 'Staging root');
  await unlink(path.join(root, 'transaction.json'));
  await syncDirectory(root);
  return {
    pointer,
    metadata: pointer && oldRevision ? await readGenerationMetadata(project, oldRevision) : null,
  };
}
function emptyMetadata(identityKey: string): StoreMetadata {
  return { version: 1, identityKey, records: {} };
}
function mutationPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\\') || raw.startsWith('/') || raw.includes('\u0000')) {
    throw fail('STORE_INVALID', 'Mutation paths must be relative project record paths.');
  }
  const parts = raw.split('/');
  if (parts.length !== 3 || parts[0] !== 'project' || !RECORD_DIRECTORIES.has(parts[1] ?? '') ||
      parts.some(part => part === '' || part === '.' || part === '..')) {
    throw fail('STORE_INVALID', 'Mutation paths must target one project record directory.', { path: raw });
  }
  const name = parts[2] ?? '';
  if (!name.endsWith('.md') || name.length <= 3) throw fail('STORE_INVALID', 'Mutation paths must name .md records.', { path: raw });
  const id = validateId(name.slice(0, -3), 'mutation filename');
  if (`${id}.md` !== name) throw fail('STORE_INVALID', 'Mutation filenames must use a record ID.', { path: raw });
  return raw;
}
function directoryKind(relativePath: string): MemoryRecord['kind'] {
  const directory = relativePath.split('/')[1];
  const kind = directory?.slice(0, -1) as MemoryRecord['kind'] | undefined;
  if (!kind || !MEMORY_KINDS.has(kind)) throw fail('STORE_INVALID', 'Mutation path has an unsupported ECC kind directory.', { path: relativePath });
  return kind;
}
function validateMutation<T>(project: ProjectIdentity, input: SnapshotMutation<T>): ValidatedMutation<T> {
  if (!isObject(input) || !Array.isArray(input.writes) || !Array.isArray(input.deletes)) {
    throw fail('STORE_INVALID', 'Snapshot mutation must contain writes and deletes arrays.');
  }
  const encoded = encodeMetadata(input.metadata, project.identityKey);
  const writes = new Map<string, Buffer>();
  const deletes = new Set<string>();
  for (const rawWrite of input.writes) {
    if (!isObject(rawWrite) || typeof rawWrite.relativePath !== 'string' || typeof rawWrite.content !== 'string') {
      throw fail('STORE_INVALID', 'Each mutation write needs a path and text content.');
    }
    const relativePath = mutationPath(rawWrite.relativePath);
    if (writes.has(relativePath)) throw fail('STORE_INVALID', 'Mutation paths cannot be duplicated.', { path: relativePath });
    const content = Buffer.from(rawWrite.content, 'utf8');
    if (content.toString('utf8') !== rawWrite.content) {
      throw fail('STORE_INVALID', 'Replacement content must be valid UTF-8 text.', { path: relativePath });
    }
    let memory: MemoryRecord;
    try {
      memory = ecc.parseMemoryDocument(rawWrite.content, relativePath);
    } catch {
      throw fail('STORE_INVALID', 'Replacement content must be a valid ECC record.', { path: relativePath });
    }
    if (memory.scope !== 'project' || memory.kind !== directoryKind(relativePath) ||
        `${memory.id}.md` !== relativePath.split('/').at(-1)) {
      throw fail('STORE_INVALID', 'Replacement ECC record does not match its path.', { path: relativePath });
    }
    writes.set(relativePath, content);
  }
  for (const rawDelete of input.deletes) {
    const relativePath = mutationPath(rawDelete);
    if (deletes.has(relativePath)) throw fail('STORE_INVALID', 'Mutation paths cannot be duplicated.', { path: relativePath });
    if (writes.has(relativePath)) throw fail('STORE_INVALID', 'A mutation path cannot be both written and deleted.', { path: relativePath });
    deletes.add(relativePath);
  }
  return { mutation: input, writes, deletes, metadataText: encoded.text, metadata: encoded.metadata };
}
async function validateCurrentProject(generation: string): Promise<FileEntry[]> {
  const files = await generationFiles(generation);
  for (const file of files) {
    if (file.kind !== 'file') {
      throw fail('STORE_UNSAFE', 'Snapshot mutations cannot copy symlinks or non-regular entries.', { path: file.relativePath });
    }
  }
  return files;
}
interface Preflight<T> {
  estimate: MutationEstimate;
  validated: ValidatedMutation<T>;
  current: Pointer | null;
  metadata: StoreMetadata;
  sourceFiles: FileEntry[];
  keepFiles: FileEntry[];
  projectBytes: number;
  unchangedBytes: number;
  extraFiles: FileEntry[];
  extraBytes: number;
}
async function preflight<T>(
  project: ProjectIdentity,
  policy: ProjectPolicy,
  expectedRevision: string | null,
  input: SnapshotMutation<T>,
  recovered: { pointer: Pointer | null; metadata: StoreMetadata | null },
): Promise<Preflight<T>> {
  if (expectedRevision !== null) assertUuid(expectedRevision, 'Expected revision');
  const current = recovered.pointer;
  if ((current?.revision ?? null) !== expectedRevision) {
    throw fail('STALE_SNAPSHOT', 'The snapshot revision changed before this mutation.', {
      expectedRevision,
      actualRevision: current?.revision ?? null,
    });
  }
  const validated = validateMutation(project, input);
  const root = project.memoryDir;
  const currentGeneration = current ? generationPath(root, current.revision) : undefined;
  const sourceFiles = currentGeneration ? await validateCurrentProject(currentGeneration) : [];
  const extraFiles = currentGeneration ? await generationExtraFiles(currentGeneration) : [];
  if (extraFiles.some(file => file.kind !== 'file')) {
    throw fail('STORE_UNSAFE', 'Snapshot mutations cannot copy non-regular generation entries.');
  }
  const extraBytes = extraFiles.reduce((total, file) => total + file.bytes, 0);
  const byPath = new Map(sourceFiles.map(file => [`project/${file.relativePath}`, file]));
  for (const relativePath of validated.deletes) {
    const existing = byPath.get(relativePath);
    if (!existing) throw fail('STORE_INVALID', 'A deletion must name an existing record file.', { path: relativePath });
  }
  for (const relativePath of validated.writes.keys()) {
    const existing = byPath.get(relativePath);
    if (existing && existing.kind !== 'file') throw fail('STORE_UNSAFE', 'A replacement path is not a regular file.', { path: relativePath });
  }
  const keepFiles = sourceFiles.filter(file => file.relativePath !== '.gitignore' &&
    !validated.deletes.has(`project/${file.relativePath}`) && !validated.writes.has(`project/${file.relativePath}`));
  let projectBytes = Buffer.byteLength(GITIGNORE, 'utf8');
  for (const file of keepFiles) projectBytes += file.bytes;
  for (const content of validated.writes.values()) projectBytes += content.length;
  const metadataBytes = Buffer.byteLength(validated.metadataText, 'utf8');
  const newPointerBytes = Buffer.byteLength(pointerText(randomUUID()), 'utf8');
  const transactionBytes = Buffer.byteLength(transactionText(current?.revision ?? null, randomUUID()), 'utf8');
  const additionalTemporaryBytes = projectBytes + metadataBytes + extraBytes + newPointerBytes + transactionBytes;

  const total = await persistentBytes(root);
  const oldGenerationBytes = current ? (await walkBytes(generationPath(root, current.revision))).bytes : 0;
  const pointerInfo = await pathInfo(path.join(root, 'current.json'));
  const oldPointerBytes = pointerInfo?.isFile() ? Number(pointerInfo.size) : 0;
  const unchangedBytes = total - oldGenerationBytes - oldPointerBytes;
  const projectedBytes = unchangedBytes + projectBytes + metadataBytes + extraBytes + newPointerBytes;
  return {
    estimate: { persistentBytes: total, projectedBytes, additionalTemporaryBytes },
    validated,
    current,
    metadata: recovered.metadata ?? emptyMetadata(project.identityKey),
    sourceFiles,
    keepFiles,
    projectBytes,
    unchangedBytes,
    extraFiles,
    extraBytes,
  };
}
async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  await assertDirectory(directory, 'Managed directory');
}
async function writeExclusive(filePath: string, content: Buffer | string): Promise<void> {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code && ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'].includes(code)) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
async function syncDirectoryIfPresent(directory: string, label: string): Promise<void> {
  if (await assertDirectory(directory, label)) await syncDirectory(directory);
}
async function copyRegular(source: string, target: string, expectedBytes: number, state: OperationState): Promise<void> {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    targetHandle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile() || sourceInfo.size !== expectedBytes) {
      throw fail('STORE_UNSAFE', 'A snapshot file changed while it was copied.', { path: source });
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expectedBytes) {
      checkOperation(state);
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, expectedBytes - position), position);
      if (bytesRead <= 0) throw fail('STORE_UNSAFE', 'A snapshot file changed while it was copied.', { path: source });
      let written = 0;
      while (written < bytesRead) {
        checkOperation(state);
        const result = await targetHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten <= 0) {
          throw fail('STORE_WRITE_FAILED', 'A snapshot copy write made no progress.', { path: target });
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const sourceAfter = await sourceHandle.stat();
    if (sourceAfter.size !== sourceInfo.size || sourceAfter.mtimeMs !== sourceInfo.mtimeMs || sourceAfter.ctimeMs !== sourceInfo.ctimeMs) {
      throw fail('STORE_UNSAFE', 'A snapshot file changed while it was copied.', { path: source });
    }
    const targetInfo = await targetHandle.stat();
    if (!targetInfo.isFile() || Number(targetInfo.size) !== expectedBytes) {
      throw fail('STORE_WRITE_FAILED', 'The copied file length does not match its source.', {
        path: target,
        expectedBytes,
        actualBytes: Number(targetInfo.size),
      });
    }
    await targetHandle.sync();
  } finally {
    await Promise.all([sourceHandle.close(), targetHandle?.close() ?? Promise.resolve()]);
  }
}
async function flushTreeDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const info = await lstat(child);
    if (info.isDirectory() && !info.isSymbolicLink()) await flushTreeDirectories(child);
  }
  await syncDirectory(directory);
}
async function writeSnapshot(
  project: ProjectIdentity,
  revision: string,
  metadata: string,
  sourceFiles: FileEntry[],
  keepFiles: FileEntry[],
  extraFiles: FileEntry[],
  writes: Map<string, Buffer>,
  state: OperationState,
): Promise<string> {
  const root = project.memoryDir;
  const stagingRoot = path.join(root, '.staging');
  await ensureDirectory(stagingRoot);
  await syncDirectory(root);
  const stage = path.join(stagingRoot, revision);
  await ensureDirectory(stage);
  const projectRoot = path.join(stage, 'project');
  await ensureDirectory(projectRoot);
  await writeExclusive(path.join(stage, 'metadata.json'), metadata);
  await writeExclusive(path.join(projectRoot, '.gitignore'), GITIGNORE);

  const neededDirectories = new Set<string>();
  for (const file of keepFiles) {
    const parent = path.posix.dirname(file.relativePath);
    if (parent !== '.') {
      const parts = parent.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        neededDirectories.add(current);
      }
    }
  }
  for (const relativePath of writes.keys()) {
    const parts = relativePath.slice('project/'.length).split('/');
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current = current ? `${current}/${part}` : part;
      neededDirectories.add(current);
    }
  }
  for (const kind of RECORD_DIRECTORIES) neededDirectories.add(kind);
  for (const directory of [...neededDirectories].sort((a, b) => a.split('/').length - b.split('/').length)) {
    await ensureDirectory(path.join(projectRoot, ...directory.split('/')));
  }

  const keepByPath = new Map(keepFiles.map(file => [file.relativePath, file]));
  for (const file of sourceFiles) {
    checkOperation(state);
    if (file.relativePath === '.gitignore' || !keepByPath.has(file.relativePath)) continue;
    const target = path.join(projectRoot, ...file.relativePath.split('/'));
    await copyRegular(file.absolutePath, target, file.bytes, state);
  }
  for (const file of extraFiles) {
    checkOperation(state);
    const parts = file.relativePath.split('/');
    const parentParts = parts.slice(0, -1);
    let parent = stage;
    for (const part of parentParts) {
      parent = path.join(parent, part);
      await ensureDirectory(parent);
    }
    await copyRegular(file.absolutePath, path.join(stage, ...parts), file.bytes, state);
  }
  for (const [relativePath, content] of writes) {
    checkOperation(state);
    const target = path.join(projectRoot, ...relativePath.slice('project/'.length).split('/'));
    await writeExclusive(target, content);
  }
  await flushTreeDirectories(projectRoot);
  await syncDirectory(stage);
  await syncDirectory(stagingRoot);
  const destination = generationPath(root, revision);
  await ensureDirectory(path.dirname(destination));
  await syncDirectory(root);
  await rename(stage, destination);
  await Promise.all([
    syncDirectory(path.dirname(destination)),
    syncDirectory(stagingRoot),
  ]);
  return destination;
}
async function cleanPrePublication(
  root: string,
  revision: string,
  transactionWritten: boolean,
  original: unknown,
): Promise<never> {
  let recoveryRequired = false;
  try {
    await removeRecognizedStage(root, revision);
    const generation = generationPath(root, revision);
    if (await pathInfo(generation)) await removeGeneration(root, revision);
    await syncDirectoryIfPresent(path.join(root, '.staging'), 'Staging root');
    await syncDirectoryIfPresent(path.join(root, 'generations'), 'Generation root');
    if (transactionWritten) {
      await rm(path.join(root, 'transaction.json'), { force: true });
      await syncDirectory(root);
    }
  } catch {
    recoveryRequired = true;
  }
  if (original instanceof ContextError) {
    Object.defineProperty(original, 'details', {
      configurable: true,
      value: { ...(original.details ?? {}), recoveryRequired },
    });
    throw original;
  }
  if (original instanceof Error) {
    Object.defineProperty(original, 'recoveryRequired', { configurable: true, value: recoveryRequired });
    throw original;
  }
  throw original;
}
async function invokePhase(options: StoreOptions, phase: StorePhase): Promise<void> {
  options.onPhase?.(phase);
}
function enforceLimits<T>(prepared: Preflight<T>, policy: ProjectPolicy): void {
  if (prepared.estimate.projectedBytes > policy.maxBytes) {
    throw fail('QUOTA_EXCEEDED', 'The committed snapshot would exceed the project quota.', {
      projectedBytes: prepared.estimate.projectedBytes,
      limitBytes: policy.maxBytes,
    });
  }
  if (prepared.estimate.additionalTemporaryBytes > policy.maxBytes) {
    throw fail('STAGING_LIMIT', 'The snapshot needs more than one quota of temporary space.', {
      additionalTemporaryBytes: prepared.estimate.additionalTemporaryBytes,
      limitBytes: policy.maxBytes,
    });
  }
}

export function openMemoryStore(
  project: ProjectIdentity,
  policy: ProjectPolicy,
  options: StoreOptions = {},
): MemoryStore {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0 ||
      (policy.cleanupMode !== 'auto' && policy.cleanupMode !== 'ask')) {
    throw fail('STORE_INVALID', 'Project policy is invalid.');
  }
  return {
    project,
    policy,
    async inspect(signal?: AbortSignal): Promise<StoreStatus> {
      const state = operation(signal);
      const root = await validateRoot(project, false);
      return inQueue(root.canonicalKey, async () => {
        checkOperation(state);
        if (!root.exists) {
          return { revision: null, persistentBytes: 0, temporaryBytes: 0, limitBytes: policy.maxBytes, overLimit: false, needsRecovery: false };
        }
        return withLock(root, state, async () => {
          checkOperation(state);
          const recovered = await recover(project);
          const persistent = await persistentBytes(root.directory);
          const temporary = await temporaryBytes(root.directory);
          return {
            revision: recovered.pointer?.revision ?? null,
            persistentBytes: persistent,
            temporaryBytes: temporary,
            limitBytes: policy.maxBytes,
            overLimit: persistent > policy.maxBytes,
            needsRecovery: false,
          };
        });
      });
    },
    async withSnapshot<T>(read: (snapshot: SnapshotView | null) => T, signal?: AbortSignal): Promise<T> {
      const state = operation(signal);
      const root = await validateRoot(project, false);
      return inQueue(root.canonicalKey, async () => {
        checkOperation(state);
        if (!root.exists) return read(null);
        return withLock(root, state, async () => {
          checkOperation(state);
          const recovered = await recover(project);
          if (!recovered.pointer || !recovered.metadata) return read(null);
          const baseDir = generationPath(root.directory, recovered.pointer.revision);
          return read({ revision: recovered.pointer.revision, baseDir, metadata: recovered.metadata });
        });
      });
    },
    async estimate<T>(expectedRevision: string | null, mutation: SnapshotMutation<T>, signal?: AbortSignal): Promise<MutationEstimate> {
      const state = operation(signal);
      const root = await validateRoot(project, false);
      return inQueue(root.canonicalKey, async () => {
        checkOperation(state);
        return withLock(root, state, async () => {
          checkOperation(state);
          const recovered = root.exists ? await recover(project) : { pointer: null, metadata: null };
          const result = await preflight(project, policy, expectedRevision, mutation, recovered);
          return result.estimate;
        });
      });
    },
    async commit<T>(expectedRevision: string | null, mutation: SnapshotMutation<T>, signal?: AbortSignal): Promise<CommitResult<T>> {
      const state = operation(signal);
      let root = await validateRoot(project, false);
      return inQueue(root.canonicalKey, async () => {
        checkOperation(state);
        if (!root.exists) {
          const initial = await preflight(project, policy, expectedRevision, mutation, { pointer: null, metadata: null });
          enforceLimits(initial, policy);
          checkOperation(state);
          root = await validateRoot(project, true);
        }
        let committed: CommitResult<T> | undefined;
        return withLock(root, state, async () => {
          checkOperation(state);
          const recovered = await recover(project);
          const prepared = await preflight(project, policy, expectedRevision, mutation, recovered);
          enforceLimits(prepared, policy);
          const revision = randomUUID();
          const nextTransaction = transactionText(prepared.current?.revision ?? null, revision);
          let transactionWritten = false;
          try {
            checkOperation(state);
            transactionWritten = true;
            await writeExclusive(path.join(root.directory, 'transaction.json'), nextTransaction);
            await syncDirectory(root.directory);
            await writeSnapshot(
              project,
              revision,
              prepared.validated.metadataText,
              prepared.sourceFiles,
              prepared.keepFiles,
              prepared.extraFiles,
              prepared.validated.writes,
              state,
            );
            await invokePhase(options, 'staged');
            checkOperation(state);
            await invokePhase(options, 'before_publish');
            checkOperation(state);

            const currentAgain = await readPointer(root.directory);
            if ((currentAgain?.revision ?? null) !== (prepared.current?.revision ?? null)) {
              throw fail('STALE_SNAPSHOT', 'The current snapshot changed before publication.', {
                expectedRevision: prepared.current?.revision ?? null,
                actualRevision: currentAgain?.revision ?? null,
              });
            }
            if (state.compromised) throw fail('STORE_LOCK_COMPROMISED', 'The project lock was compromised.');
            checkOperation(state);
            const pointerTmp = path.join(root.directory, '.staging', `${revision}.current`);
            await writeExclusive(pointerTmp, pointerText(revision));
            await syncDirectory(path.join(root.directory, '.staging'));
            checkOperation(state);
            await checkHeldLock(root.directory, state);
            const pointerBeforePublish = await readPointer(root.directory);
            if ((pointerBeforePublish?.revision ?? null) !== (prepared.current?.revision ?? null)) {
              throw fail('STALE_SNAPSHOT', 'The current snapshot changed before publication.', {
                expectedRevision: prepared.current?.revision ?? null,
                actualRevision: pointerBeforePublish?.revision ?? null,
              });
            }
            checkOperation(state);
            await rename(pointerTmp, path.join(root.directory, 'current.json'));
            state.published = true;
            committed = { revision, value: prepared.validated.mutation.value, maintenance: 'clean' };
            await syncDirectory(root.directory);
            await invokePhase(options, 'published');
            await invokePhase(options, 'before_gc');
            checkOperation(state);
            if (prepared.current) await removeGeneration(root.directory, prepared.current.revision);
            await removeRecognizedStage(root.directory, revision);
            await syncDirectoryIfPresent(path.join(root.directory, 'generations'), 'Generation root');
            await syncDirectoryIfPresent(path.join(root.directory, '.staging'), 'Staging root');
            await unlink(path.join(root.directory, 'transaction.json'));
            await syncDirectory(root.directory);
            return committed;
          } catch (error) {
            if (state.published && committed) {
              committed.maintenance = 'pending';
              return committed;
            }
            if (transactionWritten) {
              return cleanPrePublication(root.directory, revision, transactionWritten, error);
            }
            throw error;
          }
        }).then(result => {
          if (state.published && (state.releaseFailed || state.compromised)) result.maintenance = 'pending';
          return result;
        });
      });
    },
  };
}
