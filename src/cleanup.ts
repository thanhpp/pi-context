import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextError } from './errors.ts';
import { createEccOptions, ecc } from './ecc.ts';
import type { MemoryRecord } from './ecc.ts';
import { prepareRecord } from './memory.ts';
import type { RecordDraft } from './memory.ts';
import type {
  CommitResult,
  MemoryStore,
  RecordMeta,
  SessionSource,
  SnapshotMutation,
  SnapshotView,
  StoreMetadata,
} from './store.ts';

const MAX_OBSOLETE_IDS = 100;
const MAX_CONSOLIDATIONS = 8;
const MAX_CONSOLIDATION_SOURCES = 20;
const MAX_REDIRECTED_RECORDS = 100;
const MAX_SOURCE_REFS = 64;
const MAX_SOURCE_REF_CHARS = 2_048;
const MAX_PROVENANCE = 256;
const MAX_CONSOLIDATED_FROM = 1_024;
const APPROVAL_TIMEOUT_MS = 30_000;
const EXCERPT_CHARS = 240;
const ECC_LINK_LIMIT = 64;

export interface ConsolidationDraft {
  sourceIds: string[];
  summary: Pick<RecordDraft, 'title' | 'body' | 'kind' | 'category' | 'tags' | 'links'>;
}

export interface CleanupProposal {
  revision: string;
  obsoleteIds: string[];
  consolidations: ConsolidationDraft[];
}

export interface CleanupCandidate {
  id: string;
  title: string;
  bytes: number;
  expiresAt: string | null;
  reason: 'expired' | 'superseded' | 'consolidate';
}

export interface CleanupPlan {
  revision: string | null;
  persistentBytes: number;
  limitBytes: number;
  requestedFreeBytes: number;
  obsolete: CleanupCandidate[];
  candidates: CleanupCandidate[];
  protectedCount: number;
  moreCandidates: boolean;
}

export interface CleanupPreview {
  digest: string;
  revision: string;
  removedIds: string[];
  created: Array<{ id: string; title: string; excerpt: string }>;
  redirectedIds: string[];
  projectedFreedBytes: number;
}

export interface CleanupResult {
  removedIds: string[];
  createdIds: string[];
  redirectedIds: string[];
  freedBytes: number;
}

interface ScannedRecord {
  memory: MemoryRecord;
  relativePath: string;
  bytes: number;
  meta: RecordMeta | undefined;
}

interface CleanupScan {
  snapshot: SnapshotView;
  metadata: StoreMetadata;
  records: Map<string, ScannedRecord>;
  incoming: Map<string, Set<string>>;
  protectedIds: Set<string>;
  obsoleteIds: string[];
  consolidationIds: string[];
}

interface PreparedCleanup {
  revision: string;
  mutation: SnapshotMutation<CleanupResult>;
  preview: CleanupPreview;
}

function fail(code: string, message: string, details?: Record<string, unknown>): ContextError {
  return new ContextError(code, message, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function clockTime(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    throw fail('CLEANUP_INVALID_CLOCK', 'The cleanup clock failed.');
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw fail('CLEANUP_INVALID_CLOCK', 'The cleanup clock returned an invalid date.');
  }
  return value.toISOString();
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw fail('STORE_ABORTED', 'The cleanup operation was aborted.');
}

function assertScanComplete(scan: ReturnType<typeof ecc.readMemoryFiles>): void {
  if (scan.invalidFileCount > 0 || scan.truncated || scan.diagnosticsTruncated ||
      scan.skippedSymlinkCount > 0) {
    throw fail('CLEANUP_UNSAFE', 'The ECC memory scan is incomplete or contains unsafe files.');
  }
}

function sortByDateThenId(left: ScannedRecord, right: ScannedRecord): number {
  return left.memory.updatedAt.localeCompare(right.memory.updatedAt) || left.memory.id.localeCompare(right.memory.id);
}

function isExpired(record: ScannedRecord, nowMs: number): boolean {
  return record.meta?.expiresAt !== null && record.meta?.expiresAt !== undefined &&
    Date.parse(record.meta.expiresAt) <= nowMs;
}

function obsoleteReason(record: ScannedRecord, nowMs: number): 'expired' | 'superseded' | null {
  if (isExpired(record, nowMs)) return 'expired';
  if (record.memory.status === 'superseded') return 'superseded';
  return null;
}

function validRelativePath(scannedPath: string): string {
  if (!scannedPath.startsWith('project:')) {
    throw fail('CLEANUP_UNSAFE', 'The ECC scan returned a path outside the project memory root.');
  }
  const suffix = scannedPath.slice('project:'.length);
  const parts = suffix.split('/');
  if (parts.length !== 2 || parts.some(part => part.length === 0 || part === '.' || part === '..') ||
      !suffix.endsWith('.md')) {
    throw fail('CLEANUP_UNSAFE', 'The ECC scan returned an invalid record path.');
  }
  return `project/${suffix}`;
}

async function readCleanupScan(snapshot: SnapshotView, nowMs: number): Promise<CleanupScan> {
  let scan: ReturnType<typeof ecc.readMemoryFiles>;
  try {
    scan = ecc.readMemoryFiles(createEccOptions(snapshot.baseDir));
  } catch {
    throw fail('CLEANUP_UNSAFE', 'The ECC memory scan failed.');
  }
  assertScanComplete(scan);

  const records = new Map<string, ScannedRecord>();
  for (const entry of scan.entries) {
    const id = entry.memory.id;
    if (records.has(id)) throw fail('CLEANUP_UNSAFE', 'The ECC memory scan contains duplicate record IDs.', { id });
    const relativePath = validRelativePath(entry.path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(join(snapshot.baseDir, relativePath));
    } catch {
      throw fail('CLEANUP_UNSAFE', 'A scanned ECC record cannot be read safely.', { id });
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw fail('CLEANUP_UNSAFE', 'A scanned ECC record is not a regular file.', { id });
    }
    records.set(id, {
      memory: entry.memory,
      relativePath,
      bytes: Number(info.size),
      meta: snapshot.metadata.records[id],
    });
  }

  const incoming = new Map<string, Set<string>>();
  for (const id of records.keys()) incoming.set(id, new Set());
  for (const record of records.values()) {
    for (const target of record.memory.links) {
      const inbound = incoming.get(target);
      if (!inbound) throw fail('CLEANUP_UNSAFE', 'An existing ECC link points to a missing record.', {
        sourceId: record.memory.id,
        targetId: target,
      });
      inbound.add(record.memory.id);
    }
  }

  const protectedIds = new Set<string>();
  for (const record of records.values()) {
    if (record.meta === undefined) protectedIds.add(record.memory.id);
    if (record.meta?.pinned) {
      protectedIds.add(record.memory.id);
      for (const target of record.memory.links) protectedIds.add(target);
    }
  }

  const obsoletePool = new Set<string>();
  for (const record of records.values()) {
    if (!protectedIds.has(record.memory.id) && record.meta && obsoleteReason(record, nowMs)) {
      obsoletePool.add(record.memory.id);
    }
  }
  // Remove any record that has a surviving inbound link. Repeat to resolve obsolete cycles as one batch.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...obsoletePool]) {
      const sources = incoming.get(id) ?? new Set<string>();
      if ([...sources].some(sourceId => !obsoletePool.has(sourceId))) {
        obsoletePool.delete(id);
        changed = true;
      }
    }
  }

  const obsoleteRecords = [...obsoletePool].map(id => records.get(id) as ScannedRecord);
  obsoleteRecords.sort((left, right) => {
    const leftDate = left.meta?.expiresAt ?? left.memory.updatedAt;
    const rightDate = right.meta?.expiresAt ?? right.memory.updatedAt;
    return leftDate.localeCompare(rightDate) || left.memory.id.localeCompare(right.memory.id);
  });

  const consolidationRecords = [...records.values()].filter(record => (
    !protectedIds.has(record.memory.id) && record.meta !== undefined && !obsoletePool.has(record.memory.id)
  ));
  consolidationRecords.sort(sortByDateThenId);

  return {
    snapshot,
    metadata: snapshot.metadata,
    records,
    incoming,
    protectedIds,
    obsoleteIds: obsoleteRecords.map(record => record.memory.id),
    consolidationIds: consolidationRecords.map(record => record.memory.id),
  };
}

function candidate(record: ScannedRecord, reason: CleanupCandidate['reason']): CleanupCandidate {
  return {
    id: record.memory.id,
    title: record.memory.title,
    bytes: record.bytes,
    expiresAt: record.meta?.expiresAt ?? null,
    reason,
  };
}

function validateRequestedFreeBytes(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw fail('CLEANUP_INVALID_REQUEST', 'requestedFreeBytes must be a non-negative safe integer.');
  }
  return value;
}

export async function planCleanup(
  store: MemoryStore,
  requestedFreeBytes = 0,
  now: () => Date = () => new Date(),
  signal?: AbortSignal,
): Promise<CleanupPlan> {
  const requested = validateRequestedFreeBytes(requestedFreeBytes);
  assertNotAborted(signal);
  const nowMs = Date.parse(clockTime(now));
  const scanState = await store.withSnapshot(async snapshot => {
    if (!snapshot) return null;
    return readCleanupScan(snapshot, nowMs);
  }, signal);
  const status = await store.inspect(signal);
  const revision = scanState?.snapshot.revision ?? null;
  if (status.revision !== revision) {
    throw fail('STALE_SNAPSHOT', 'The snapshot changed while cleanup candidates were planned.', {
      expectedRevision: revision,
      actualRevision: status.revision,
    });
  }
  const scanned = scanState;
  const obsoleteAll = scanned?.obsoleteIds.map(id => {
    const record = scanned.records.get(id) as ScannedRecord;
    const reason = obsoleteReason(record, nowMs) as 'expired' | 'superseded';
    return candidate(record, reason);
  }) ?? [];
  const obsolete = obsoleteAll.slice(0, MAX_OBSOLETE_IDS);
  const consolidationAll = scanned?.consolidationIds.map(id => (
    candidate(scanned.records.get(id) as ScannedRecord, 'consolidate')
  )) ?? [];
  const candidates = consolidationAll.slice(0, 20);
  return {
    revision,
    persistentBytes: status.persistentBytes,
    limitBytes: store.policy.maxBytes,
    requestedFreeBytes: requested,
    obsolete,
    candidates,
    protectedCount: scanned?.protectedIds.size ?? 0,
    moreCandidates: obsoleteAll.length > obsolete.length || consolidationAll.length > candidates.length,
  };
}

function invalidProposal(message: string, details?: Record<string, unknown>): ContextError {
  return fail('CLEANUP_INVALID_PROPOSAL', message, details);
}

function validateProposalShape(value: unknown): asserts value is CleanupProposal {
  if (!isPlainObject(value) || Object.keys(value).some(key => !['revision', 'obsoleteIds', 'consolidations'].includes(key)) ||
      typeof value.revision !== 'string' || !Array.isArray(value.obsoleteIds) || !Array.isArray(value.consolidations)) {
    throw invalidProposal('The cleanup proposal has an invalid shape.');
  }
  if (value.obsoleteIds.length > MAX_OBSOLETE_IDS || value.consolidations.length > MAX_CONSOLIDATIONS) {
    throw invalidProposal('The cleanup proposal exceeds an operation limit.');
  }
}

function validateId(value: unknown, label: string): string {
  try {
    return ecc.validateMemoryId(value);
  } catch {
    throw invalidProposal(`${label} contains an invalid record ID.`);
  }
}

function validateSummary(value: unknown): ConsolidationDraft['summary'] {
  if (!isPlainObject(value) || Object.keys(value).some(key => !['title', 'body', 'kind', 'category', 'tags', 'links'].includes(key)) ||
      typeof value.title !== 'string' || typeof value.body !== 'string' ||
      typeof value.kind !== 'string' || typeof value.category !== 'string' ||
      (value.tags !== undefined && !Array.isArray(value.tags)) ||
      (value.links !== undefined && !Array.isArray(value.links))) {
    throw invalidProposal('A consolidation summary has an invalid shape.');
  }
  return value as ConsolidationDraft['summary'];
}

function uniqueUnion<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const marker = key(value);
    if (!seen.has(marker)) {
      seen.add(marker);
      result.push(value);
    }
  }
  return result;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortObject(value[key]);
  return sorted;
}

function mutationDigest(mutation: SnapshotMutation<CleanupResult>): string {
  const normalized = {
    writes: [...mutation.writes].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    deletes: [...mutation.deletes].sort(),
    metadata: sortObject(mutation.metadata),
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

function excerpt(body: string): string {
  if (body.length <= EXCERPT_CHARS) return body;
  return `${body.slice(0, EXCERPT_CHARS)}…`;
}

function expectedExpiry(sources: ScannedRecord[]): string | null {
  const expiries = sources.map(source => source.meta?.expiresAt ?? null);
  if (expiries.some(expiry => expiry === null)) return null;
  return (expiries as string[]).sort((left, right) => left.localeCompare(right))[0] as string;
}

function checkMetadataLimits(meta: RecordMeta): void {
  if (meta.sourceRefs.length > MAX_SOURCE_REFS || meta.sourceRefs.some(ref => ref.length > MAX_SOURCE_REF_CHARS) ||
      meta.provenance.length > MAX_PROVENANCE || meta.consolidatedFrom.length > MAX_CONSOLIDATED_FROM) {
    throw fail('PROVENANCE_LIMIT', 'Consolidation exceeds a metadata history limit.');
  }
}

function redirectLinks(
  links: string[],
  sourceToReplacement: Map<string, string>,
  removedIds: Set<string>,
  recordId: string,
  existingIds: Set<string>,
): string[] {
  const redirected: string[] = [];
  for (const link of links) {
    const replacement = sourceToReplacement.get(link);
    if (replacement) {
      redirected.push(replacement);
    } else if (removedIds.has(link)) {
      throw fail('REPLACEMENT_REQUIRED', 'A removed record has a link but no replacement summary.', {
        sourceId: recordId,
        targetId: link,
      });
    } else if (!existingIds.has(link)) {
      throw fail('CLEANUP_UNKNOWN_LINK', 'A summary link does not name an existing record.', {
        sourceId: recordId,
        targetId: link,
      });
    } else {
      redirected.push(link);
    }
  }
  return [...new Set(redirected)].filter(link => link !== recordId);
}

async function prepareCleanup(
  store: MemoryStore,
  proposal: CleanupProposal,
  source: SessionSource,
  time: string,
  signal?: AbortSignal,
): Promise<PreparedCleanup> {
  validateProposalShape(proposal);
  assertNotAborted(signal);
  return store.withSnapshot(async snapshot => {
    if (!snapshot) {
      throw fail('STALE_SNAPSHOT', 'The cleanup proposal does not match an existing snapshot.', {
        expectedRevision: proposal.revision,
        actualRevision: null,
      });
    }
    if (proposal.revision !== snapshot.revision) {
      throw fail('STALE_SNAPSHOT', 'The cleanup proposal uses an old snapshot revision.', {
        expectedRevision: proposal.revision,
        actualRevision: snapshot.revision,
      });
    }
    const nowMs = Date.parse(time);
    const scanned = await readCleanupScan(snapshot, nowMs);
    const obsoleteIds: string[] = [];
    const obsoleteSet = new Set<string>();
    for (const rawId of proposal.obsoleteIds) {
      const id = validateId(rawId, 'obsoleteIds');
      if (obsoleteSet.has(id)) throw invalidProposal('The obsolete ID list contains duplicates.', { id });
      obsoleteSet.add(id);
      obsoleteIds.push(id);
    }

    const consolidationDrafts: Array<{ sourceIds: string[]; summary: ConsolidationDraft['summary'] }> = [];
    const sourceOwner = new Map<string, number>();
    let sourceCount = 0;
    for (let index = 0; index < proposal.consolidations.length; index += 1) {
      const raw = proposal.consolidations[index] as unknown;
      if (!isPlainObject(raw) || Object.keys(raw).some(key => !['sourceIds', 'summary'].includes(key)) ||
          !Array.isArray(raw.sourceIds)) {
        throw invalidProposal('A consolidation draft has an invalid shape.');
      }
      if (raw.sourceIds.length === 0) throw invalidProposal('Each consolidation needs at least one source record.');
      const sourceIds: string[] = [];
      for (const rawId of raw.sourceIds) {
        const id = validateId(rawId, 'sourceIds');
        if (sourceOwner.has(id)) throw invalidProposal('Consolidation source IDs cannot repeat or overlap.', { id });
        sourceOwner.set(id, index);
        sourceIds.push(id);
      }
      sourceCount += sourceIds.length;
      if (sourceCount > MAX_CONSOLIDATION_SOURCES) {
        throw invalidProposal('The cleanup proposal exceeds the consolidation source limit.');
      }
      consolidationDrafts.push({ sourceIds, summary: validateSummary(raw.summary) });
    }
    if (sourceCount > MAX_CONSOLIDATION_SOURCES) {
      throw invalidProposal('The cleanup proposal exceeds the consolidation source limit.');
    }
    for (const id of obsoleteSet) {
      if (sourceOwner.has(id)) throw invalidProposal('An ID cannot be both obsolete and a consolidation source.', { id });
    }

    const allRequestedIds = new Set([...obsoleteSet, ...sourceOwner.keys()]);
    for (const id of allRequestedIds) {
      const record = scanned.records.get(id);
      if (!record) throw fail('CLEANUP_UNKNOWN_ID', 'The cleanup proposal names an unknown record.', { id });
      if (scanned.protectedIds.has(id)) throw fail('CLEANUP_PROTECTED', 'The cleanup proposal names a protected record.', { id });
    }

    const nowMsCheck = Date.parse(time);
    for (const id of obsoleteSet) {
      const record = scanned.records.get(id) as ScannedRecord;
      if (!obsoleteReason(record, nowMsCheck)) {
        throw fail('CLEANUP_NOT_OBSOLETE', 'An active, non-expired record cannot be removed without a replacement.', { id });
      }
      if (!scanned.obsoleteIds.includes(id)) {
        throw fail('REPLACEMENT_REQUIRED', 'An obsolete record has a surviving inbound link and needs a replacement summary.', { id });
      }
    }

    if (consolidationDrafts.length > 0) {
      const remainingEligible = scanned.obsoleteIds.filter(id => !obsoleteSet.has(id));
      if (remainingEligible.length > 0) {
        throw fail('CLEANUP_OBSOLETE_REQUIRED', 'Remove eligible obsolete records before unrelated consolidation.', {
          remainingCount: remainingEligible.length,
        });
      }
    }

    const sourceToReplacement = new Map<string, string>();
    const removedIds = new Set<string>(obsoleteSet);
    const createdRecords: Array<{ memory: MemoryRecord; metadata: RecordMeta; sources: ScannedRecord[] }> = [];
    const existingIds = new Set(scanned.records.keys());
    for (const draft of consolidationDrafts) {
      const sources = draft.sourceIds.map(id => scanned.records.get(id) as ScannedRecord);
      if (sources.some(record => record.meta === undefined)) {
        const record = sources.find(item => item.meta === undefined) as ScannedRecord;
        throw fail('CLEANUP_PROTECTED', 'A record without retention metadata cannot be consolidated.', { id: record.memory.id });
      }
      const expiry = expectedExpiry(sources);
      const summaryLinks = [...new Set(draft.summary.links ?? [])];
      if (summaryLinks.length > ECC_LINK_LIMIT) {
        throw fail('CLEANUP_LINK_LIMIT', 'A replacement summary exceeds the ECC link limit.');
      }
      const prepared = prepareRecord({
        ...draft.summary,
        links: summaryLinks,
        pinned: false,
        expiresAt: expiry,
      }, source, time);
      if (existingIds.has(prepared.memory.id) || createdRecords.some(item => item.memory.id === prepared.memory.id)) {
        throw fail('CLEANUP_ID_COLLISION', 'A replacement record ID already exists.', { id: prepared.memory.id });
      }
      const provenance = uniqueUnion(
        [...sources.flatMap(record => record.meta?.provenance ?? []), ...prepared.metadata.provenance],
        item => JSON.stringify(item),
      );
      const sourceRefs = uniqueUnion(sources.flatMap(record => record.meta?.sourceRefs ?? []), item => item);
      const consolidatedFrom = uniqueUnion([
        ...draft.sourceIds,
        ...sources.flatMap(record => record.meta?.consolidatedFrom ?? []),
      ], item => item);
      const metadata: RecordMeta = {
        ...prepared.metadata,
        pinned: false,
        expiresAt: expiry,
        provenance,
        sourceRefs,
        consolidatedFrom,
      };
      checkMetadataLimits(metadata);
      const recordIds = new Set(draft.sourceIds);
      createdRecords.push({ memory: prepared.memory, metadata, sources });
      for (const id of recordIds) sourceToReplacement.set(id, prepared.memory.id);
      for (const id of recordIds) removedIds.add(id);
    }

    // Rebuild replacement links after every source mapping is known, including links between batches.
    for (let index = 0; index < consolidationDrafts.length; index += 1) {
      const draft = consolidationDrafts[index] as { sourceIds: string[]; summary: ConsolidationDraft['summary'] };
      const created = createdRecords[index] as { memory: MemoryRecord; metadata: RecordMeta; sources: ScannedRecord[] };
      const rawOutgoingLinks = [
        ...created.sources.flatMap(record => record.memory.links),
        ...(draft.summary.links ?? []),
      ];
      const links = redirectLinks(rawOutgoingLinks, sourceToReplacement, removedIds, created.memory.id, existingIds);
      if (links.length > ECC_LINK_LIMIT) throw fail('CLEANUP_LINK_LIMIT', 'A replacement summary exceeds the ECC link limit.');
      created.memory = ecc.normalizeMemory({ ...created.memory, links });
    }

    const finalIds = new Set(existingIds);
    for (const id of removedIds) finalIds.delete(id);
    for (const created of createdRecords) {
      if (finalIds.has(created.memory.id)) throw fail('CLEANUP_ID_COLLISION', 'A replacement record ID already exists.');
      finalIds.add(created.memory.id);
    }

    const writes: SnapshotMutation<CleanupResult>['writes'] = createdRecords.map(created => ({
      relativePath: `project/${created.memory.kind}s/${created.memory.id}.md`,
      content: ecc.serializeMemoryDocument(created.memory),
    }));
    const redirectedIds: string[] = [];
    for (const record of scanned.records.values()) {
      if (removedIds.has(record.memory.id)) continue;
      let changed = false;
      const links: string[] = [];
      for (const target of record.memory.links) {
        const replacement = sourceToReplacement.get(target);
        if (replacement) {
          links.push(replacement);
          changed = true;
        } else if (removedIds.has(target)) {
          throw fail('REPLACEMENT_REQUIRED', 'A removed record has a surviving inbound link but no replacement summary.', {
            sourceId: record.memory.id,
            targetId: target,
          });
        } else {
          links.push(target);
        }
      }
      const uniqueLinks = [...new Set(links)];
      if (!changed) continue;
      if (record.meta?.pinned) {
        throw fail('CLEANUP_PROTECTED', 'Cleanup cannot redirect a link in a pinned record.', { id: record.memory.id });
      }
      if (uniqueLinks.length > ECC_LINK_LIMIT) throw fail('CLEANUP_LINK_LIMIT', 'A redirected record exceeds the ECC link limit.', { id: record.memory.id });
      const redirectedMemory = ecc.normalizeMemory({
        ...record.memory,
        links: uniqueLinks,
        updatedAt: time,
      });
      writes.push({ relativePath: record.relativePath, content: ecc.serializeMemoryDocument(redirectedMemory) });
      redirectedIds.push(record.memory.id);
    }
    if (redirectedIds.length > MAX_REDIRECTED_RECORDS) {
      throw invalidProposal('The cleanup proposal needs too many incoming-link redirects.', {
        redirectedCount: redirectedIds.length,
      });
    }

    // Every link in the published snapshot must name a surviving record or a replacement.
    const replacementIds = new Set(createdRecords.map(created => created.memory.id));
    for (const record of scanned.records.values()) {
      if (removedIds.has(record.memory.id)) continue;
      const links = redirectedIds.includes(record.memory.id)
        ? writes.find(write => write.relativePath === record.relativePath)?.content
        : undefined;
      const memory = links ? ecc.parseMemoryDocument(links, record.relativePath) : record.memory;
      for (const target of memory.links) {
        if (!finalIds.has(target) && !replacementIds.has(target)) {
          if (removedIds.has(target)) {
            throw fail('REPLACEMENT_REQUIRED', 'A removed linked record has no replacement summary.', { targetId: target });
          }
          throw fail('CLEANUP_UNKNOWN_LINK', 'A published ECC link would name an unknown record.', {
            sourceId: memory.id,
            targetId: target,
          });
        }
      }
    }
    for (const created of createdRecords) {
      for (const target of created.memory.links) {
        if (!finalIds.has(target)) {
          if (removedIds.has(target)) throw fail('REPLACEMENT_REQUIRED', 'A removed linked record has no replacement summary.', { targetId: target });
          throw fail('CLEANUP_UNKNOWN_LINK', 'A replacement summary links to an unknown record.', {
            sourceId: created.memory.id,
            targetId: target,
          });
        }
      }
    }

    const metadata: StoreMetadata = {
      version: snapshot.metadata.version,
      identityKey: snapshot.metadata.identityKey,
      records: { ...snapshot.metadata.records },
    };
    for (const id of removedIds) delete metadata.records[id];
    for (const created of createdRecords) metadata.records[created.memory.id] = created.metadata;

    const deletes = [...removedIds].map(id => (scanned.records.get(id) as ScannedRecord).relativePath);
    const created = createdRecords.map(item => ({
      id: item.memory.id,
      title: item.memory.title,
      excerpt: excerpt(item.memory.body),
    }));
    const mutation: SnapshotMutation<CleanupResult> = {
      writes,
      deletes,
      metadata,
      value: {
        removedIds: [...removedIds].sort(),
        createdIds: createdRecords.map(item => item.memory.id).sort(),
        redirectedIds: redirectedIds.sort(),
        freedBytes: 0,
      },
    };
    const preview: CleanupPreview = {
      digest: mutationDigest(mutation),
      revision: snapshot.revision,
      removedIds: [...removedIds].sort(),
      created,
      redirectedIds: [...redirectedIds].sort(),
      projectedFreedBytes: 0,
    };
    return { revision: snapshot.revision, mutation, preview };
  }, signal);
}

function freezePreview(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezePreview(child);
  Object.freeze(value);
}

async function authorizeCleanup(
  authorize: (preview: CleanupPreview) => Promise<boolean>,
  preview: CleanupPreview,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof authorize !== 'function') {
    throw fail('APPROVAL_REQUIRED', 'Ask-first cleanup requires approval for this exact proposal.');
  }
  assertNotAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const timed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(fail('APPROVAL_REQUIRED', 'Cleanup approval timed out.')), APPROVAL_TIMEOUT_MS);
    if (signal) {
      abortListener = () => reject(fail('STORE_ABORTED', 'Cleanup approval was aborted.'));
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  try {
    const approved = await Promise.race([
      Promise.resolve().then(() => authorize(preview)),
      timed,
    ]);
    assertNotAborted(signal);
    if (approved !== true) throw fail('APPROVAL_REQUIRED', 'Cleanup approval was declined.');
  } catch (error) {
    if (error instanceof ContextError) throw error;
    if (signal?.aborted) throw fail('STORE_ABORTED', 'Cleanup approval was aborted.');
    throw fail('APPROVAL_REQUIRED', 'Cleanup approval failed.');
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener && signal) signal.removeEventListener('abort', abortListener);
  }
}

export async function applyCleanup(
  store: MemoryStore,
  proposal: CleanupProposal,
  source: SessionSource,
  authorize: (preview: CleanupPreview) => Promise<boolean>,
  now: () => Date = () => new Date(),
  signal?: AbortSignal,
): Promise<CommitResult<CleanupResult>> {
  assertNotAborted(signal);
  const time = clockTime(now);
  const prepared = await prepareCleanup(store, proposal, source, time, signal);
  const estimate = await store.estimate(prepared.revision, prepared.mutation, signal);
  const projectedFreedBytes = estimate.persistentBytes - estimate.projectedBytes;
  if (projectedFreedBytes <= 0) {
    throw fail('NO_CLEANUP_PROGRESS', 'The cleanup mutation does not reduce persistent storage.');
  }
  if (estimate.projectedBytes > store.policy.maxBytes) {
    throw fail('QUOTA_EXCEEDED', 'Cleanup cannot bring persistent storage within the project quota.', {
      projectedBytes: estimate.projectedBytes,
      limitBytes: store.policy.maxBytes,
    });
  }
  if (estimate.additionalTemporaryBytes > store.policy.maxBytes) {
    throw fail('STAGING_LIMIT', 'Cleanup needs more temporary space than the configured quota.', {
      additionalTemporaryBytes: estimate.additionalTemporaryBytes,
      limitBytes: store.policy.maxBytes,
    });
  }
  prepared.preview.projectedFreedBytes = projectedFreedBytes;
  prepared.mutation.value.freedBytes = projectedFreedBytes;

  if (store.policy.cleanupMode === 'ask') {
    freezePreview(prepared.preview);
    await authorizeCleanup(authorize, prepared.preview, signal);
  }
  assertNotAborted(signal);
  return store.commit(prepared.revision, prepared.mutation, signal);
}
