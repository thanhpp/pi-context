import { isAbsolute, normalize } from 'node:path';
import { ContextError } from './errors.ts';
import {
  createEccOptions,
  ecc,
} from './ecc.ts';
import type {
  EccReadResult,
  EccSearchResult,
  MemoryKind,
  MemoryRecord,
} from './ecc.ts';
import type {
  CommitResult,
  MemoryStore,
  RecordCategory,
  RecordMeta,
  SessionSource,
  SnapshotMutation,
  SnapshotView,
  StoreMetadata,
  StoreStatus,
} from './store.ts';

const MEMORY_KINDS = new Set<MemoryKind>([
  'context', 'decision', 'fact', 'handoff', 'lesson', 'note', 'preference', 'runbook',
]);
const RECORD_CATEGORIES = new Set<RecordCategory>(['session', 'structure', 'decision', 'other']);
const SOURCE_REF_LIMIT = 64;
const SOURCE_REF_CHARS = 2_048;
const PROVENANCE_LIMIT = 256;
const CONSOLIDATED_FROM_LIMIT = 1_024;
const SESSION_EXPIRY_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_SEARCH_QUERY_CHARS = 500;
const DRAFT_FIELDS = new Set([
  'title', 'body', 'kind', 'category', 'tags', 'links', 'pinned', 'expiresAt', 'sourceRefs',
]);
const SOURCE_FIELDS = new Set(['sessionId', 'worktreeRoot', 'head']);

export interface RecordDraft {
  title: string;
  body: string;
  kind: MemoryKind;
  category: RecordCategory;
  tags?: string[];
  links?: string[];
  pinned?: boolean;
  expiresAt?: string | null;
  sourceRefs?: string[];
}

export interface RetentionPatch {
  pinned?: boolean;
  expiresAt?: string | null;
}

export interface MemoryStatus extends StoreStatus {
  projectId: string;
  cleanupMode: 'auto' | 'ask';
  expiredUnpinnedCount: number;
}

export interface MemorySearchResult extends EccSearchResult {
  retention: Record<string, RecordMeta | null>;
}

export interface MemoryReadResult {
  record: EccReadResult;
  retention: RecordMeta | null;
}

export interface MemoryService {
  status(signal?: AbortSignal): Promise<MemoryStatus>;
  search(
    query: string,
    options?: { kinds?: MemoryKind[]; limit?: number },
    signal?: AbortSignal,
  ): Promise<MemorySearchResult>;
  read(id: string, signal?: AbortSignal): Promise<MemoryReadResult>;
  record(input: RecordDraft, signal?: AbortSignal): Promise<CommitResult<MemoryRecord>>;
  setRetention(
    id: string,
    patch: RetentionPatch,
    authorizeUnpin: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<CommitResult<RecordMeta>>;
}

interface PlainObject {
  [key: string]: unknown;
}

function fail(code: string, message: string, details?: Record<string, unknown>): ContextError {
  return new ContextError(code, message, details);
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeDetails(error: ContextError, code: string): Record<string, unknown> | undefined {
  const source = error.details;
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  if (code === 'QUOTA_EXCEEDED' || code === 'STAGING_LIMIT') {
    const projectedBytes = code === 'STAGING_LIMIT' ? source.additionalTemporaryBytes : source.projectedBytes;
    if (Number.isSafeInteger(projectedBytes)) result.projectedBytes = projectedBytes;
    if (Number.isSafeInteger(source.additionalTemporaryBytes)) result.additionalTemporaryBytes = source.additionalTemporaryBytes;
    if (Number.isSafeInteger(source.limitBytes)) result.limitBytes = source.limitBytes;
    result.cleanupRequired = true;
  } else if (code === 'STALE_SNAPSHOT') {
    if (source.expectedRevision === null || typeof source.expectedRevision === 'string') {
      result.expectedRevision = source.expectedRevision;
    }
    if (source.actualRevision === null || typeof source.actualRevision === 'string') {
      result.actualRevision = source.actualRevision;
    }
  } else if (code === 'MEMORY_INVALID_INPUT' && source.field === 'tags') {
    result.field = 'tags';
  } else if (typeof source.recoveryRequired === 'boolean') {
    result.recoveryRequired = source.recoveryRequired;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeContextError(error: unknown): ContextError {
  const code = errorCode(error);
  if (code === 'ECC_MEMORY_INCOMPLETE') {
    return fail('ECC_MEMORY_INCOMPLETE', 'The ECC memory scan is incomplete.');
  }
  if (code === 'QUOTA_EXCEEDED' || code === 'STAGING_LIMIT') {
    const details = error instanceof ContextError ? safeDetails(error, code) : { cleanupRequired: true };
    return fail('QUOTA_EXCEEDED', 'The memory quota does not allow this write.', {
      ...(details ?? {}), cleanupRequired: true,
    });
  }
  if (code === 'STALE_SNAPSHOT') {
    return fail('STALE_SNAPSHOT', 'The memory snapshot changed before publication.',
      error instanceof ContextError ? safeDetails(error, code) : undefined);
  }
  if (code?.startsWith('STORE_')) {
    return fail(code, code === 'STORE_RECOVERY_REQUIRED'
      ? 'The memory store needs recovery.'
      : 'The memory store operation failed.',
    error instanceof ContextError ? safeDetails(error, code) : undefined);
  }
  if (error instanceof ContextError && code?.startsWith('MEMORY_')) {
    return fail(code, error.message, safeDetails(error, code));
  }
  return fail('MEMORY_OPERATION_FAILED', 'The memory operation failed safely.');
}

function requireSafeText(value: unknown, label: string, maxChars?: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
      (maxChars !== undefined && value.length > maxChars) ||
      ecc.hasUnsafeControlCharacters(value)) {
    throw fail('MEMORY_INVALID_INPUT', `${label} is invalid.`);
  }
  if (ecc.findPotentialSecrets(value).length > 0) {
    throw fail('MEMORY_SUSPECTED_SECRET', 'Memory input contains a suspected secret.');
  }
  return value;
}

function validateSource(source: unknown): SessionSource {
  if (!isPlainObject(source) || Object.keys(source).some(key => !SOURCE_FIELDS.has(key)) ||
      Object.keys(source).length !== SOURCE_FIELDS.size) {
    throw fail('MEMORY_INVALID_PROVENANCE', 'Session provenance is invalid.');
  }
  const sessionId = requireSafeText(source.sessionId, 'Session ID');
  const worktreeRoot = requireSafeText(source.worktreeRoot, 'Worktree root');
  if (!isAbsolute(worktreeRoot) || normalize(worktreeRoot) !== worktreeRoot) {
    throw fail('MEMORY_INVALID_PROVENANCE', 'Session provenance is invalid.');
  }
  const head = source.head;
  if (head !== null) requireSafeText(head, 'Git HEAD');
  return { sessionId, worktreeRoot, head: head as string | null };
}

function validateSourceRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SOURCE_REF_LIMIT) {
    throw fail('MEMORY_INVALID_INPUT', 'Source references are invalid.');
  }
  const refs = value.map(reference => requireSafeText(reference, 'Source reference', SOURCE_REF_CHARS));
  if (new Set(refs).size !== refs.length) {
    throw fail('MEMORY_INVALID_INPUT', 'Source references cannot contain duplicates.');
  }
  return refs;
}

function validateRecordMeta(value: unknown): RecordMeta {
  if (!isPlainObject(value) || !RECORD_CATEGORIES.has(value.category as RecordCategory) ||
      typeof value.pinned !== 'boolean' ||
      (value.expiresAt !== null && !isCanonicalTimestamp(value.expiresAt)) ||
      !Array.isArray(value.provenance) || value.provenance.length > PROVENANCE_LIMIT ||
      !Array.isArray(value.sourceRefs) || value.sourceRefs.length > SOURCE_REF_LIMIT ||
      !Array.isArray(value.consolidatedFrom) || value.consolidatedFrom.length > CONSOLIDATED_FROM_LIMIT) {
    throw fail('MEMORY_INVALID_METADATA', 'Memory retention metadata is invalid.');
  }
  const provenance = value.provenance.map(validateSource);
  const provenanceKeys = provenance.map(source => JSON.stringify(source));
  if (new Set(provenanceKeys).size !== provenanceKeys.length) {
    throw fail('MEMORY_INVALID_METADATA', 'Memory provenance cannot contain duplicates.');
  }
  const sourceRefs = validateSourceRefs(value.sourceRefs);
  const consolidatedFrom = value.consolidatedFrom.map(reference => {
    try {
      return ecc.validateMemoryId(reference);
    } catch {
      throw fail('MEMORY_INVALID_METADATA', 'Consolidated record references are invalid.');
    }
  });
  if (new Set(consolidatedFrom).size !== consolidatedFrom.length) {
    throw fail('MEMORY_INVALID_METADATA', 'Consolidated record references cannot contain duplicates.');
  }
  return {
    category: value.category as RecordCategory,
    pinned: value.pinned,
    expiresAt: value.expiresAt as string | null,
    provenance,
    sourceRefs,
    consolidatedFrom,
  };
}

function validateAllMetadata(metadata: StoreMetadata): StoreMetadata {
  if (!isPlainObject(metadata.records)) {
    throw fail('MEMORY_INVALID_METADATA', 'Memory retention metadata is invalid.');
  }
  const records: Record<string, RecordMeta> = {};
  for (const [id, value] of Object.entries(metadata.records)) {
    try {
      ecc.validateMemoryId(id);
    } catch {
      throw fail('MEMORY_INVALID_METADATA', 'Memory retention metadata is invalid.');
    }
    records[id] = validateRecordMeta(value);
  }
  return { version: 1, identityKey: metadata.identityKey, records };
}

function validateDraftShape(input: unknown): asserts input is RecordDraft {
  if (!isPlainObject(input) || Object.keys(input).some(key => !DRAFT_FIELDS.has(key))) {
    throw fail('MEMORY_INVALID_INPUT', 'The memory draft contains unsupported fields.');
  }
}

function normalizeRecordTags(value: unknown): string[] {
  if (value === undefined) return [];
  const invalidTags = () => fail('MEMORY_INVALID_INPUT', 'Record tags are invalid.', { field: 'tags' });
  if (!Array.isArray(value) || value.length > 32) throw invalidTags();
  const tags = value.map(tag => {
    if (typeof tag !== 'string' || tag.length > 64 || ecc.hasUnsafeControlCharacters(tag)) throw invalidTags();
    if (ecc.findPotentialSecrets(tag).length > 0) {
      throw fail('MEMORY_SUSPECTED_SECRET', 'Memory input contains a suspected secret.');
    }
    try {
      return ecc.validateSlug(tag.trim().toLowerCase().replace(/ +/gu, '-'), 'tag');
    } catch {
      throw invalidTags();
    }
  });
  return [...new Set(tags)];
}

export function prepareRecord(
  input: RecordDraft,
  source: SessionSource,
  now: string,
  id?: string,
): { memory: MemoryRecord; metadata: RecordMeta } {
  try {
    validateDraftShape(input);
    const safeSource = validateSource(source);
    if (!isCanonicalTimestamp(now)) {
      throw fail('MEMORY_INVALID_INPUT', 'The record timestamp must be UTC ISO 8601 with milliseconds.');
    }
    const category = input.category;
    if (typeof category !== 'string' || !RECORD_CATEGORIES.has(category as RecordCategory)) {
      throw fail('MEMORY_INVALID_INPUT', 'The record category is invalid.');
    }
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean') {
      throw fail('MEMORY_INVALID_INPUT', 'The pinned value must be boolean.');
    }
    const expiresAt = input.expiresAt === undefined
      ? (category === 'session' ? new Date(Date.parse(now) + SESSION_EXPIRY_MS).toISOString() : null)
      : input.expiresAt;
    if (expiresAt !== null && !isCanonicalTimestamp(expiresAt)) {
      throw fail('MEMORY_INVALID_INPUT', 'The record expiry must be UTC ISO 8601 with milliseconds or null.');
    }
    const sourceRefs = validateSourceRefs(input.sourceRefs);
    const recordInput = {
      schema: 'ecc.memory.v1',
      id: id === undefined ? ecc.defaultMemoryId(new Date(now)) : ecc.validateMemoryId(id),
      title: input.title,
      kind: input.kind,
      scope: 'project',
      trust: 'unreviewed',
      status: 'active',
      sourceHarness: 'pi',
      targetHarnesses: ['pi'],
      tags: normalizeRecordTags(input.tags),
      links: input.links === undefined ? [] : input.links,
      createdAt: now,
      updatedAt: now,
      body: input.body,
    };
    const memory = ecc.normalizeMemory(recordInput);
    const document = ecc.serializeMemoryDocument(memory);
    const secretScan = `${document}\n${JSON.stringify({ sourceRefs, provenance: [safeSource] })}`;
    if (ecc.findPotentialSecrets(secretScan).length > 0) {
      throw fail('MEMORY_SUSPECTED_SECRET', 'Memory input contains a suspected secret.');
    }
    const metadata: RecordMeta = {
      category: category as RecordCategory,
      pinned: input.pinned ?? false,
      expiresAt,
      provenance: [safeSource],
      sourceRefs,
      consolidatedFrom: [],
    };
    return { memory, metadata: validateRecordMeta(metadata) };
  } catch (error) {
    if (error instanceof ContextError) throw error;
    throw fail('MEMORY_INVALID_INPUT', 'The memory draft is invalid.');
  }
}

function emptySearchResult(): EccSearchResult {
  return {
    results: [],
    diagnostics: {
      invalidFiles: [],
      invalidFileCount: 0,
      skippedSymlinks: [],
      skippedSymlinkCount: 0,
      scannedBytes: 0,
      truncated: false,
      diagnosticsTruncated: false,
    },
  };
}

function validateSearchOptions(options: unknown): { kinds?: MemoryKind[]; limit?: number } {
  if (options === undefined) return {};
  if (!isPlainObject(options) || Object.keys(options).some(key => key !== 'kinds' && key !== 'limit')) {
    throw fail('MEMORY_INVALID_SEARCH_OPTIONS', 'Memory search options are invalid.');
  }
  const result: { kinds?: MemoryKind[]; limit?: number } = {};
  if (options.kinds !== undefined) {
    if (!Array.isArray(options.kinds) || options.kinds.some(kind => typeof kind !== 'string' || !MEMORY_KINDS.has(kind as MemoryKind)) ||
        new Set(options.kinds).size !== options.kinds.length) {
      throw fail('MEMORY_INVALID_SEARCH_OPTIONS', 'Memory search kinds are invalid.');
    }
    result.kinds = options.kinds as MemoryKind[];
  }
  if (options.limit !== undefined) {
    if (typeof options.limit !== 'number' || !Number.isFinite(options.limit)) {
      throw fail('MEMORY_INVALID_SEARCH_OPTIONS', 'Memory search limit is invalid.');
    }
    result.limit = options.limit;
  }
  return result;
}

function validateQuery(query: unknown): asserts query is string {
  if (typeof query !== 'string' || query.trim().length > MAX_SEARCH_QUERY_CHARS ||
      ecc.hasUnsafeControlCharacters(query.trim())) {
    throw fail('MEMORY_INVALID_QUERY', 'The memory search query is invalid.');
  }
}

function assertCompleteUniqueScan(snapshot: SnapshotView): ReturnType<typeof ecc.readMemoryFiles> {
  let scan: ReturnType<typeof ecc.readMemoryFiles>;
  try {
    scan = ecc.readMemoryFiles(createEccOptions(snapshot.baseDir));
  } catch (error) {
    throw safeContextError(error);
  }
  if (scan.truncated || scan.invalidFileCount > 0) {
    throw fail('ECC_MEMORY_INCOMPLETE', 'The ECC memory scan is incomplete.');
  }
  const ids = new Set<string>();
  for (const entry of scan.entries) {
    if (ids.has(entry.memory.id)) {
      throw fail('ECC_MEMORY_INCOMPLETE', 'The ECC memory scan contains duplicate record IDs.');
    }
    ids.add(entry.memory.id);
  }
  return scan;
}

function memoryRelativePath(memory: MemoryRecord): string {
  return `project/${memory.kind}s/${memory.id}.md`;
}

function scanContainsPath(scan: ReturnType<typeof ecc.readMemoryFiles>, path: string): boolean {
  return scan.entries.some(entry => entry.path === path.replace(/^project\//u, 'project:'));
}

function notFound(id: string): ContextError {
  return fail('MEMORY_NOT_FOUND', 'The requested memory record was not found.', { id });
}

function readError(id: string, error: unknown): ContextError {
  if (errorCode(error) === 'ECC_MEMORY_INCOMPLETE') {
    return fail('ECC_MEMORY_INCOMPLETE', 'The ECC memory scan is incomplete.');
  }
  if (error instanceof Error) {
    const duplicate = /is duplicated in (\d+) files\.$/u.exec(error.message);
    if (duplicate) {
      return fail('MEMORY_DUPLICATE_ID', 'The memory ID exists in more than one ECC record.', {
        id,
        count: Number(duplicate[1]),
      });
    }
    if (error.message.endsWith('was not found.')) return notFound(id);
  }
  return safeContextError(error);
}

function requireValidId(id: unknown): string {
  try {
    return ecc.validateMemoryId(id);
  } catch {
    throw fail('MEMORY_INVALID_ID', 'The memory ID is invalid.');
  }
}

function copyMetadata(metadata: StoreMetadata): StoreMetadata {
  return validateAllMetadata(metadata);
}

function validateRetentionPatch(patch: unknown): RetentionPatch {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0 ||
      Object.keys(patch).some(key => key !== 'pinned' && key !== 'expiresAt')) {
    throw fail('MEMORY_INVALID_RETENTION_PATCH', 'A non-empty retention patch is required.');
  }
  if (Object.hasOwn(patch, 'pinned') && typeof patch.pinned !== 'boolean') {
    throw fail('MEMORY_INVALID_RETENTION_PATCH', 'The retention pin value must be boolean.');
  }
  if (Object.hasOwn(patch, 'expiresAt') && patch.expiresAt !== null && !isCanonicalTimestamp(patch.expiresAt)) {
    throw fail('MEMORY_INVALID_RETENTION_PATCH', 'The retention expiry must be UTC ISO 8601 with milliseconds or null.');
  }
  return {
    ...(Object.hasOwn(patch, 'pinned') ? { pinned: patch.pinned as boolean } : {}),
    ...(Object.hasOwn(patch, 'expiresAt') ? { expiresAt: patch.expiresAt as string | null } : {}),
  };
}

export function createMemoryService(
  store: MemoryStore,
  source: SessionSource,
  now: () => Date = () => new Date(),
): MemoryService {
  const sessionSource = validateSource(source);
  if (sessionSource.worktreeRoot !== store.project.worktreeRoot) {
    throw fail('MEMORY_INVALID_PROVENANCE', 'Session provenance does not match the active project.');
  }

  const nowIso = (): string => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw fail('MEMORY_INVALID_CLOCK', 'The memory clock returned an invalid date.');
    }
    return value.toISOString();
  };

  const commitMutation = async <T>(
    revision: string | null,
    mutation: SnapshotMutation<T>,
    signal?: AbortSignal,
  ): Promise<CommitResult<T>> => {
    try {
      return await store.commit(revision, mutation, signal);
    } catch (error) {
      throw safeContextError(error);
    }
  };

  return {
    async status(signal?: AbortSignal): Promise<MemoryStatus> {
      try {
        const status = await store.inspect(signal);
        const expiredUnpinnedCount = await store.withSnapshot(snapshot => {
          if (!snapshot) return 0;
          const metadata = validateAllMetadata(snapshot.metadata);
          const time = Date.parse(nowIso());
          return Object.values(metadata.records).filter(meta => (
            !meta.pinned && meta.expiresAt !== null && Date.parse(meta.expiresAt) <= time
          )).length;
        }, signal);
        return {
          ...status,
          projectId: store.project.id,
          cleanupMode: store.policy.cleanupMode,
          expiredUnpinnedCount,
        };
      } catch (error) {
        throw safeContextError(error);
      }
    },

    async search(query, options, signal): Promise<MemorySearchResult> {
      validateQuery(query);
      const searchOptions = validateSearchOptions(options);
      try {
        return await store.withSnapshot(snapshot => {
          if (!snapshot) return { ...emptySearchResult(), retention: {} };
          const upstream = ecc.searchMemories(query, {
            ...createEccOptions(snapshot.baseDir),
            ...searchOptions,
          });
          const retention: Record<string, RecordMeta | null> = {};
          for (const result of upstream.results) {
            const meta = snapshot.metadata.records[result.memory.id];
            retention[result.memory.id] = meta === undefined ? null : validateRecordMeta(meta);
          }
          return { ...upstream, retention };
        }, signal);
      } catch (error) {
        throw safeContextError(error);
      }
    },

    async read(id, signal): Promise<MemoryReadResult> {
      const memoryId = requireValidId(id);
      try {
        return await store.withSnapshot(snapshot => {
          if (!snapshot) throw notFound(memoryId);
          let record: EccReadResult;
          try {
            record = ecc.readMemoryById(memoryId, createEccOptions(snapshot.baseDir));
          } catch (error) {
            throw readError(memoryId, error);
          }
          return {
            record,
            retention: snapshot.metadata.records[memoryId]
              ? validateRecordMeta(snapshot.metadata.records[memoryId])
              : null,
          };
        }, signal);
      } catch (error) {
        throw safeContextError(error);
      }
    },

    async record(input, signal): Promise<CommitResult<MemoryRecord>> {
      let prepared: { revision: string | null; mutation: SnapshotMutation<MemoryRecord> };
      try {
        prepared = await store.withSnapshot(snapshot => {
          const metadata: StoreMetadata = snapshot ? copyMetadata(snapshot.metadata) : {
            version: 1,
            identityKey: store.project.identityKey,
            records: {},
          };
          let scan: ReturnType<typeof ecc.readMemoryFiles> | undefined;
          if (snapshot) scan = assertCompleteUniqueScan(snapshot);
          const item = prepareRecord(input, sessionSource, nowIso());
          if (scan) {
            const targetPath = memoryRelativePath(item.memory);
            if (scan.entries.some(entry => entry.memory.id === item.memory.id) ||
                Object.hasOwn(metadata.records, item.memory.id) ||
                scanContainsPath(scan, targetPath)) {
              throw fail('MEMORY_ID_COLLISION', 'The generated memory ID already exists.');
            }
            const existingIds = new Set(scan.entries.map(entry => entry.memory.id));
            for (const link of item.memory.links) {
              if (!existingIds.has(link)) {
                throw fail('MEMORY_UNKNOWN_LINK', 'A memory link does not name an existing project record.');
              }
            }
          } else if (item.memory.links.length > 0) {
            throw fail('MEMORY_UNKNOWN_LINK', 'A memory link does not name an existing project record.');
          }
          metadata.records[item.memory.id] = validateRecordMeta(item.metadata);
          const mutation: SnapshotMutation<MemoryRecord> = {
            writes: [{ relativePath: memoryRelativePath(item.memory), content: ecc.serializeMemoryDocument(item.memory) }],
            deletes: [],
            metadata,
            value: item.memory,
          };
          return { revision: snapshot?.revision ?? null, mutation };
        }, signal);
      } catch (error) {
        throw safeContextError(error);
      }
      return commitMutation(prepared.revision, prepared.mutation, signal);
    },

    async setRetention(id, patch, authorizeUnpin, signal): Promise<CommitResult<RecordMeta>> {
      const memoryId = requireValidId(id);
      const retentionPatch = validateRetentionPatch(patch);
      if (typeof authorizeUnpin !== 'function') {
        throw fail('MEMORY_INVALID_RETENTION_PATCH', 'An unpin authorization callback is required.');
      }
      let prepared: {
        revision: string;
        mutation: SnapshotMutation<RecordMeta>;
        requiresApproval: boolean;
      };
      try {
        prepared = await store.withSnapshot(snapshot => {
          if (!snapshot) throw notFound(memoryId);
          const metadata = copyMetadata(snapshot.metadata);
          const current = metadata.records[memoryId];
          if (!current) throw fail('MEMORY_NOT_MANAGED', 'The record has no managed retention metadata.');
          try {
            ecc.readMemoryById(memoryId, createEccOptions(snapshot.baseDir));
          } catch (error) {
            throw readError(memoryId, error);
          }
          const next: RecordMeta = {
            ...current,
            ...(retentionPatch.pinned === undefined ? {} : { pinned: retentionPatch.pinned }),
            ...(retentionPatch.expiresAt === undefined ? {} : { expiresAt: retentionPatch.expiresAt }),
          };
          const validated = validateRecordMeta(next);
          metadata.records[memoryId] = validated;
          return {
            revision: snapshot.revision,
            mutation: { writes: [], deletes: [], metadata, value: validated },
            requiresApproval: current.pinned && retentionPatch.pinned === false,
          };
        }, signal);
      } catch (error) {
        throw safeContextError(error);
      }
      if (prepared.requiresApproval) {
        let approved = false;
        try {
          approved = await authorizeUnpin();
        } catch {
          throw fail('APPROVAL_REQUIRED', 'Approval is required before unpinning this memory record.');
        }
        if (!approved) {
          throw fail('APPROVAL_REQUIRED', 'Approval is required before unpinning this memory record.');
        }
      }
      return commitMutation(prepared.revision, prepared.mutation, signal);
    },
  };
}
