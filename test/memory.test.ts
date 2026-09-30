import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createEccOptions, ecc } from '../src/ecc.ts';
import type { MemoryRecord } from '../src/ecc.ts';
import { createMemoryService, prepareRecord } from '../src/memory.ts';
import type { RecordDraft } from '../src/memory.ts';
import type { ProjectIdentity } from '../src/project.ts';
import { openMemoryStore } from '../src/store.ts';
import type {
  MemoryStore,
  RecordMeta,
  SnapshotMutation,
  StoreMetadata,
} from '../src/store.ts';

const FIXED_NOW = '2025-02-03T04:05:06.000Z';
const SOURCE_HEAD = '1234567890abcdef1234567890abcdef12345678';
const KINDS: MemoryRecord['kind'][] = [
  'context', 'decision', 'fact', 'handoff', 'lesson', 'note', 'preference', 'runbook',
];

async function withTemp(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-context-memory-'));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function projectAt(directory: string): ProjectIdentity {
  const root = join(directory, 'repo');
  mkdirSync(root, { recursive: true });
  const memoryDir = join(directory, 'agent', 'memory', 'project-id');
  mkdirSync(dirname(memoryDir), { recursive: true });
  return {
    id: 'project-id',
    identityKey: `configured\0${root}`,
    kind: 'configured',
    root,
    worktreeRoot: root,
    memoryDir,
  };
}

function sourceAt(project: ProjectIdentity) {
  return {
    sessionId: 'session-current-001',
    worktreeRoot: project.worktreeRoot,
    head: SOURCE_HEAD,
  };
}

function memoryStore(project: ProjectIdentity, maxBytes = 10_485_760, cleanupMode: 'auto' | 'ask' = 'auto') {
  return openMemoryStore(project, { maxBytes, cleanupMode });
}

function serviceAt(
  project: ProjectIdentity,
  store = memoryStore(project),
  clock: () => Date = () => new Date(FIXED_NOW),
) {
  return createMemoryService(store, sourceAt(project), clock);
}

function draft(overrides: Partial<RecordDraft> = {}): RecordDraft {
  return {
    title: 'Project layout',
    body: 'The service keeps project records in the transactional snapshot.',
    kind: 'context',
    category: 'structure',
    ...overrides,
  };
}

function metadataEntry(overrides: Partial<RecordMeta> = {}): RecordMeta {
  return {
    category: 'other',
    pinned: false,
    expiresAt: null,
    provenance: [sourceAt({ worktreeRoot: '/tmp/project' } as ProjectIdentity)],
    sourceRefs: [],
    consolidatedFrom: [],
    ...overrides,
  };
}

function newMemory(
  id: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return ecc.normalizeMemory({
    schema: 'ecc.memory.v1',
    id,
    title: 'Existing project record',
    kind: 'note',
    scope: 'project',
    trust: 'unreviewed',
    status: 'active',
    sourceHarness: 'pi',
    targetHarnesses: ['pi'],
    tags: [],
    links: [],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    body: 'Existing readable project context.',
    ...overrides,
  });
}

function mutationFor<T>(
  project: ProjectIdentity,
  memories: MemoryRecord[],
  metadataRecords: Record<string, RecordMeta>,
  value: T,
): SnapshotMutation<T> {
  const metadata: StoreMetadata = {
    version: 1,
    identityKey: project.identityKey,
    records: metadataRecords,
  };
  return {
    writes: memories.map(memory => ({
      relativePath: `project/${memory.kind}s/${memory.id}.md`,
      content: ecc.serializeMemoryDocument(memory),
    })),
    deletes: [],
    metadata,
    value,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code)
    : undefined;
}

function isCode(code: string): (error: unknown) => boolean {
  return error => errorCode(error) === code;
}

test('prepareRecord fixes ECC identity and serializes only the 13 ECC frontmatter fields', () => {
  const prepared = prepareRecord(draft({ tags: ['architecture'] }), sourceAt({ worktreeRoot: '/tmp/project' } as ProjectIdentity), FIXED_NOW, 'mem_fixture_exact01');
  assert.deepEqual(prepared.memory, {
    schema: 'ecc.memory.v1',
    id: 'mem_fixture_exact01',
    title: 'Project layout',
    kind: 'context',
    scope: 'project',
    trust: 'unreviewed',
    status: 'active',
    sourceHarness: 'pi',
    targetHarnesses: ['pi'],
    tags: ['architecture'],
    links: [],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    body: 'The service keeps project records in the transactional snapshot.',
  });
  const document = ecc.serializeMemoryDocument(prepared.memory);
  assert.equal(document, `---
schema: "ecc.memory.v1"
id: "mem_fixture_exact01"
title: "Project layout"
kind: "context"
scope: "project"
trust: "unreviewed"
status: "active"
source_harness: "pi"
target_harnesses: ["pi"]
tags: ["architecture"]
links: []
created_at: "${FIXED_NOW}"
updated_at: "${FIXED_NOW}"
---\n\nThe service keeps project records in the transactional snapshot.\n`);
  assert.equal(document.split('\n').slice(1, 14).length, 13);
});

test('prepareRecord normalizes every tag set rejected in the paid benchmark', () => {
  const source = { sessionId: 'session-1', worktreeRoot: '/tmp/project', head: null };
  const rejectedTagSets = [
    ['Halyard', 'storage', 'deployment'],
    ['Halyard', 'email', 'Postmark'],
    ['Halyard', 'email', 'Postmark'],
    ['Halyard', 'logging'],
    ['Halyard', 'mobile', 'Realm'],
    ['Halyard', 'planning', 'schedule'],
    ['Halyard', 'support', 'response time'],
    ['brand', 'Halyard', 'color'],
    ['Halyard', 'background-jobs', 'NATS JetStream'],
    ['Halyard', 'planning', 'schedule'],
  ];
  for (const tags of rejectedTagSets) {
    const prepared = prepareRecord(draft({ tags }), source, FIXED_NOW, 'mem_fixture_tags001');
    assert.deepEqual(prepared.memory.tags, tags.map(tag => tag.toLowerCase().replaceAll(' ', '-')));
    assert.deepEqual(ecc.parseMemoryDocument(ecc.serializeMemoryDocument(prepared.memory)), prepared.memory);
  }
  const prepared = prepareRecord(draft({ tags: [' Halyard ', 'halyard', 'NATS  JetStream', 'eu.central-1'] }), source, FIXED_NOW);
  assert.deepEqual(prepared.memory.tags, ['halyard', 'nats-jetstream', 'eu.central-1']);
});

test('tag normalization rejects unsafe input and checks secrets before changing case', () => {
  const source = { sessionId: 'session-1', worktreeRoot: '/tmp/project', head: null };
  for (const tags of [[''], ['x'.repeat(65)], ['bad/tag'], ['tag\tname'], ['tag\nname'], ['tag\u202ename'], Array(33).fill('tag'), [12], null]) {
    assert.throws(() => prepareRecord(draft({ tags: tags as string[] }), source, FIXED_NOW), error => {
      assert.equal(errorCode(error), 'MEMORY_INVALID_INPUT');
      assert.deepEqual((error as { details: unknown }).details, { field: 'tags' });
      return true;
    });
  }
  const rawAwsKey = `AKIA${'A'.repeat(16)}`;
  assert.throws(() => prepareRecord(draft({ tags: [rawAwsKey] }), source, FIXED_NOW), isCode('MEMORY_SUSPECTED_SECRET'));
});

test('prepareRecord accepts every ECC memory kind', () => {
  const source = { sessionId: 'session-1', worktreeRoot: '/tmp/project', head: null };
  for (const [index, kind] of KINDS.entries()) {
    const prepared = prepareRecord(draft({ kind }), source, FIXED_NOW, `mem_fixture_kind_${String(index).padStart(2, '0')}`);
    assert.equal(prepared.memory.kind, kind);
  }
});

test('all retention categories use the 90-day session expiry rule', () => {
  const source = { sessionId: 'session-1', worktreeRoot: '/tmp/project', head: null };
  const session = prepareRecord(draft({ category: 'session', kind: 'handoff' }), source, FIXED_NOW, 'mem_fixture_session01');
  const structure = prepareRecord(draft({ category: 'structure' }), source, FIXED_NOW, 'mem_fixture_structure01');
  const decision = prepareRecord(draft({ category: 'decision', kind: 'decision' }), source, FIXED_NOW, 'mem_fixture_decision01');
  const other = prepareRecord(draft({ category: 'other', kind: 'fact' }), source, FIXED_NOW, 'mem_fixture_other0001');

  assert.equal(session.metadata.expiresAt, '2025-05-04T04:05:06.000Z');
  assert.equal(structure.metadata.expiresAt, null);
  assert.equal(decision.metadata.expiresAt, null);
  assert.equal(other.metadata.expiresAt, null);
  assert.deepEqual([...new Set([session, structure, decision, other].map(item => item.metadata.category))], [
    'session', 'structure', 'decision', 'other',
  ]);
  assert.equal(session.memory.status, 'active');
  assert.equal(decision.memory.status, 'active');
});

test('explicit expiry, null expiry, pinning, and supplied provenance stay in sidecar metadata', () => {
  const source = { sessionId: 'actual-session', worktreeRoot: '/tmp/project', head: SOURCE_HEAD };
  const explicit = prepareRecord(draft({
    category: 'session',
    expiresAt: '2025-03-01T00:00:00.000Z',
    pinned: true,
    sourceRefs: ['https://example.test/decision'],
  }), source, FIXED_NOW, 'mem_fixture_explicit01');
  const neverExpire = prepareRecord(draft({ category: 'session', expiresAt: null }), source, FIXED_NOW, 'mem_fixture_null_expiry01');
  assert.equal(explicit.metadata.expiresAt, '2025-03-01T00:00:00.000Z');
  assert.equal(explicit.metadata.pinned, true);
  assert.deepEqual(explicit.metadata.provenance, [source]);
  assert.deepEqual(explicit.metadata.sourceRefs, ['https://example.test/decision']);
  assert.equal(explicit.metadata.consolidatedFrom.length, 0);
  assert.equal(neverExpire.metadata.expiresAt, null);
  assert.equal(Object.hasOwn(explicit.memory, 'pinned'), false);
  assert.equal(Object.hasOwn(explicit.memory, 'expiresAt'), false);
  assert.equal(Object.hasOwn(explicit.memory, 'provenance'), false);
});

test('prepareRecord rejects model-controlled identity, timestamps, paths, and provenance', () => {
  const source = { sessionId: 'session-1', worktreeRoot: '/tmp/project', head: null };
  const base = draft();
  for (const field of ['id', 'scope', 'trust', 'status', 'sourceHarness', 'targetHarnesses', 'createdAt', 'updatedAt', 'destinationPath', 'path', 'provenance']) {
    assert.throws(
      () => prepareRecord({ ...base, [field]: field === 'provenance' ? [source] : '/tmp/outside.md' } as RecordDraft, source, FIXED_NOW),
      isCode('MEMORY_INVALID_INPUT'),
      field,
    );
  }
  const supplied = prepareRecord(base, { ...source, sessionId: 'extension-session' }, FIXED_NOW);
  assert.equal(supplied.metadata.provenance[0]?.sessionId, 'extension-session');
  assert.throws(
    () => prepareRecord(base, { ...source, replacement: 'attacker-session' } as typeof source, FIXED_NOW),
    isCode('MEMORY_INVALID_PROVENANCE'),
  );
});

test('source references enforce uniqueness, character, count, control, and secret bounds', () => {
  const source = { sessionId: 'session-1', worktreeRoot: '/tmp/project', head: null };
  const maxRef = `x${'y'.repeat(2_047)}`;
  const valid = prepareRecord(draft({ sourceRefs: [maxRef, 'https://example.test/ref'] }), source, FIXED_NOW, 'mem_fixture_refs_valid01');
  assert.equal(valid.metadata.sourceRefs[0], maxRef);
  assert.throws(() => prepareRecord(draft({ sourceRefs: [maxRef + 'y'] }), source, FIXED_NOW), isCode('MEMORY_INVALID_INPUT'));
  assert.throws(() => prepareRecord(draft({ sourceRefs: ['same', 'same'] }), source, FIXED_NOW), isCode('MEMORY_INVALID_INPUT'));
  assert.throws(() => prepareRecord(draft({ sourceRefs: Array.from({ length: 65 }, (_, i) => `ref-${i}`) }), source, FIXED_NOW), isCode('MEMORY_INVALID_INPUT'));
  assert.throws(() => prepareRecord(draft({ sourceRefs: ['\u0001'] }), source, FIXED_NOW), isCode('MEMORY_INVALID_INPUT'));
  assert.throws(() => prepareRecord(draft({ sourceRefs: [`sk-${'A'.repeat(24)}`] }), source, FIXED_NOW), isCode('MEMORY_SUSPECTED_SECRET'));
  assert.throws(() => prepareRecord(draft({ body: `secret sk-${'A'.repeat(24)}` }), source, FIXED_NOW), isCode('MEMORY_SUSPECTED_SECRET'));
});

test('metadata count limits reject existing references instead of truncating them', async () => {
  await withTemp(async directory => {
    for (const mode of ['provenance', 'consolidatedFrom'] as const) {
      const caseDir = join(directory, mode);
      mkdirSync(caseDir);
      const project = projectAt(caseDir);
      const store = memoryStore(project);
      const saved = newMemory(`mem_limit_${mode.toLowerCase()}_001`);
      const metadata = metadataEntry(mode === 'provenance'
        ? { provenance: Array.from({ length: 257 }, (_, index) => ({
          sessionId: `session-${index}`,
          worktreeRoot: `/tmp/project/${index}`,
          head: null,
        })) }
        : { consolidatedFrom: Array.from({ length: 1_025 }, (_, index) => `mem_source_${String(index).padStart(4, '0')}`) });
      await store.commit(null, mutationFor(project, [saved], { [saved.id]: metadata }, 'saved'));
      const service = serviceAt(project, store);
      await assert.rejects(service.record(draft()), isCode('MEMORY_INVALID_METADATA'));
      const snapshot = await store.withSnapshot(value => value);
      const retained = snapshot?.metadata.records[saved.id];
      assert.equal(retained?.[mode].length, mode === 'provenance' ? 257 : 1_025);
    }
  });
});

test('missing stores return complete empty search results and do not create storage', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const service = serviceAt(project);
    assert.deepEqual(await service.search(''), {
      results: [],
      diagnostics: {
        invalidFiles: [], invalidFileCount: 0, skippedSymlinks: [], skippedSymlinkCount: 0,
        scannedBytes: 0, truncated: false, diagnosticsTruncated: false,
      },
      retention: {},
    });
    assert.equal((await service.status()).projectId, project.id);
    await assert.rejects(service.read('mem_missing_record01'), isCode('MEMORY_NOT_FOUND'));
    assert.equal(existsSync(project.memoryDir), false);
  });
});

test('service records links only to existing project records and preserves ECC search parity', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const store = memoryStore(project);
    const service = serviceAt(project, store);
    const first = await service.record(draft({ title: 'Needle project layout', body: 'Needle is in the project structure.' }));
    const linked = await service.record(draft({
      title: 'Needle decision',
      kind: 'decision',
      category: 'decision',
      links: [first.value.id],
    }));
    assert.deepEqual(linked.value.links, [first.value.id]);
    await assert.rejects(service.record(draft({ links: ['mem_unknown_project01'] })), isCode('MEMORY_UNKNOWN_LINK'));

    const snapshot = await store.withSnapshot(value => value);
    assert.ok(snapshot);
    const upstream = ecc.searchMemories('needle', createEccOptions(snapshot.baseDir));
    const serviceResult = await service.search('needle');
    assert.deepEqual({ results: serviceResult.results, diagnostics: serviceResult.diagnostics }, upstream);
    assert.deepEqual(Object.keys(serviceResult.retention).sort(), serviceResult.results.map(result => result.memory.id).sort());
    assert.ok(serviceResult.retention[first.value.id]);
    const directRead = await service.read(first.value.id);
    assert.equal(directRead.record.memory.id, first.value.id);
    assert.deepEqual(directRead.record.backlinks.map(memory => memory.id), [linked.value.id]);
  });
});

test('service metadata records source identity and status exposes no record content', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    assert.throws(() => createMemoryService(memoryStore(project), {
      ...sourceAt(project),
      worktreeRoot: join(directory, 'other-repo'),
    }), isCode('MEMORY_INVALID_PROVENANCE'));
    const service = serviceAt(project);
    const saved = await service.record(draft({
      category: 'session',
      pinned: true,
      sourceRefs: ['https://example.test/session-result'],
    }));
    const read = await service.read(saved.value.id);
    assert.deepEqual(read.retention?.provenance, [sourceAt(project)]);
    assert.deepEqual(read.retention?.sourceRefs, ['https://example.test/session-result']);
    assert.equal(read.retention?.pinned, true);
    const status = await service.status();
    assert.equal(status.expiredUnpinnedCount, 0);
    assert.equal(status.cleanupMode, 'auto');
    assert.equal(status.projectId, project.id);
    assert.equal(JSON.stringify(status).includes(saved.value.title), false);
    assert.equal(JSON.stringify(status).includes('session-current-001'), false);
  });
});

test('status counts only expired unpinned metadata records', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    let current = new Date(FIXED_NOW);
    const service = serviceAt(project, memoryStore(project), () => current);
    const expired = await service.record(draft({ category: 'session' }));
    await service.record(draft({ category: 'session', pinned: true }));
    await service.record(draft({ category: 'structure' }));
    current = new Date('2025-05-05T04:05:06.000Z');
    assert.equal((await service.status()).expiredUnpinnedCount, 1);
    assert.equal((await service.read(expired.value.id)).retention?.expiresAt, '2025-05-04T04:05:06.000Z');
  });
});

test('direct reads preserve inactive records and missing sidecars return null', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const store = memoryStore(project);
    const inactive = newMemory('mem_inactive_read001', { status: 'superseded' });
    await store.commit(null, mutationFor(project, [inactive], {}, 'saved'));
    const service = serviceAt(project, store);
    const read = await service.read(inactive.id);
    assert.equal(read.record.memory.status, 'superseded');
    assert.equal(read.retention, null);
    await assert.rejects(service.setRetention(inactive.id, { pinned: true }, async () => true), isCode('MEMORY_NOT_MANAGED'));
  });
});

test('invalid scans block writes and reads without changing the previous snapshot', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const store = memoryStore(project);
    const service = serviceAt(project, store);
    const saved = await service.record(draft());
    const snapshot = await store.withSnapshot(value => value);
    assert.ok(snapshot);
    const invalidPath = join(snapshot.baseDir, 'project', 'notes', 'mem_invalid_memory01.md');
    writeFileSync(invalidPath, 'not an ECC document');
    const search = await service.search('project');
    assert.equal(search.diagnostics.invalidFileCount, 1);
    await assert.rejects(service.read(saved.value.id), isCode('ECC_MEMORY_INCOMPLETE'));
    await assert.rejects(service.record(draft({ title: 'Must not publish' })), isCode('ECC_MEMORY_INCOMPLETE'));
    assert.equal(readFileSync(join(snapshot.baseDir, 'project', `${saved.value.kind}s`, `${saved.value.id}.md`), 'utf8'), ecc.serializeMemoryDocument(saved.value));
    rmSync(invalidPath);
    assert.equal((await service.read(saved.value.id)).record.memory.id, saved.value.id);
  });
});

test('duplicate ECC IDs block reads and new records', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const store = memoryStore(project);
    const first = newMemory('mem_duplicate_service01');
    const second = newMemory(first.id, { kind: 'fact', title: 'Duplicate' });
    await store.commit(null, mutationFor(project, [first, second], { [first.id]: metadataEntry() }, 'saved'));
    const service = serviceAt(project, store);
    await assert.rejects(service.read(first.id), isCode('MEMORY_DUPLICATE_ID'));
    await assert.rejects(service.record(draft()), isCode('ECC_MEMORY_INCOMPLETE'));
    assert.equal((await store.withSnapshot(snapshot => snapshot))?.metadata.records[first.id]?.category, 'other');
  });
});

test('quota refusal reports projected bytes and cleanup need while preserving readable memory', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const seedService = serviceAt(project, memoryStore(project));
    const saved = await seedService.record(draft({ title: 'Existing readable record' }));
    const service = serviceAt(project, memoryStore(project, 1));
    await assert.rejects(service.record(draft()), error => {
      assert.equal(errorCode(error), 'QUOTA_EXCEEDED');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.cleanupRequired, true);
      assert.equal(typeof details?.projectedBytes, 'number');
      assert.equal(details?.limitBytes, 1);
      return true;
    });
    assert.deepEqual((await service.search('Existing readable')).results.map(result => result.memory.id), [saved.value.id]);
    assert.equal((await service.read(saved.value.id)).record.memory.body, saved.value.body);
    const status = await service.status();
    assert.ok(status.persistentBytes > 0);
    assert.equal(status.overLimit, true);
    assert.equal(existsSync(project.memoryDir), true);
  });
});

test('stale record commits fail without overwriting the intervening snapshot', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const baseStore = memoryStore(project);
    let firstCommit = true;
    const wrappedStore: MemoryStore = {
      ...baseStore,
      async commit<T>(revision: string | null, mutation: SnapshotMutation<T>, signal?: AbortSignal) {
        if (firstCommit) {
          firstCommit = false;
          const other = newMemory('mem_stale_intervening01');
          await baseStore.commit(revision, mutationFor(project, [other], { [other.id]: metadataEntry() }, 'intervening'), signal);
        }
        return baseStore.commit(revision, mutation, signal);
      },
    };
    const service = serviceAt(project, wrappedStore);
    await assert.rejects(service.record(draft()), isCode('STALE_SNAPSHOT'));
    const snapshot = await baseStore.withSnapshot(value => value);
    assert.ok(snapshot);
    assert.equal(ecc.parseMemoryDocument(readFileSync(join(snapshot.baseDir, 'project', 'notes', 'mem_stale_intervening01.md'), 'utf8')).id, 'mem_stale_intervening01');
    assert.deepEqual((await service.search('')).results.map(result => result.memory.id), ['mem_stale_intervening01']);
  });
});

test('declined unpinning leaves retention unchanged and approved changes commit metadata only', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const service = serviceAt(project);
    const saved = await service.record(draft({ pinned: true }));
    await assert.rejects(service.setRetention(saved.value.id, { pinned: false }, async () => false), isCode('APPROVAL_REQUIRED'));
    assert.equal((await service.read(saved.value.id)).retention?.pinned, true);
    const nextExpiry = '2025-04-01T00:00:00.000Z';
    const changed = await service.setRetention(saved.value.id, { pinned: true, expiresAt: nextExpiry }, async () => true);
    assert.equal(changed.value.expiresAt, nextExpiry);
    assert.equal(changed.value.pinned, true);
    assert.equal((await service.read(saved.value.id)).record.memory.body, saved.value.body);
  });
});

test('unpin approval runs outside the snapshot lock and stale approval cannot publish', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const store = memoryStore(project);
    const service = serviceAt(project, store);
    const helper = serviceAt(project, store);
    const saved = await service.record(draft({ pinned: true }));
    await assert.rejects(service.setRetention(saved.value.id, { pinned: false }, async () => {
      await helper.record(draft({ title: 'Concurrent update', category: 'session' }));
      return true;
    }), isCode('STALE_SNAPSHOT'));
    assert.equal((await service.read(saved.value.id)).retention?.pinned, true);
    assert.equal((await service.search('Concurrent update')).results.length, 1);
  });
});

