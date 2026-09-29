import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createEccOptions, ecc } from '../src/ecc.ts';
import type { MemoryRecord } from '../src/ecc.ts';
import { applyCleanup, planCleanup } from '../src/cleanup.ts';
import type { CleanupProposal, ConsolidationDraft } from '../src/cleanup.ts';
import type { RecordDraft } from '../src/memory.ts';
import type { ProjectIdentity } from '../src/project.ts';
import { openMemoryStore } from '../src/store.ts';
import type { MemoryStore, RecordMeta, SnapshotMutation, StoreMetadata } from '../src/store.ts';

const NOW = '2025-02-03T04:05:06.000Z';
const LATER = '2025-04-03T04:05:06.000Z';

async function withTemp(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-context-cleanup-'));
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

function sourceAt(project: ProjectIdentity, sessionId = 'cleanup-session-current') {
  return { sessionId, worktreeRoot: project.worktreeRoot, head: '1234567890abcdef1234567890abcdef12345678' };
}

function storeAt(project: ProjectIdentity, cleanupMode: 'auto' | 'ask' = 'auto', maxBytes = 10_485_760, onPhase?: (phase: string) => void): MemoryStore {
  return openMemoryStore(project, { cleanupMode, maxBytes }, { onPhase: onPhase as never });
}

function makeMemory(
  id: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return ecc.normalizeMemory({
    schema: 'ecc.memory.v1',
    id,
    title: `Record ${id}`,
    kind: 'note',
    scope: 'project',
    trust: 'unreviewed',
    status: 'active',
    sourceHarness: 'pi',
    targetHarnesses: ['pi'],
    tags: [],
    links: [],
    createdAt: NOW,
    updatedAt: NOW,
    body: `Body for ${id}.`,
    ...overrides,
  });
}

function meta(overrides: Partial<RecordMeta> = {}): RecordMeta {
  return {
    category: 'other',
    pinned: false,
    expiresAt: null,
    provenance: [],
    sourceRefs: [],
    consolidatedFrom: [],
    ...overrides,
  };
}

function mutationFor<T>(
  project: ProjectIdentity,
  records: MemoryRecord[],
  recordsMetadata: Record<string, RecordMeta>,
  value: T,
): SnapshotMutation<T> {
  const metadata: StoreMetadata = { version: 1, identityKey: project.identityKey, records: recordsMetadata };
  return {
    writes: records.map(record => ({
      relativePath: `project/${record.kind}s/${record.id}.md`,
      content: ecc.serializeMemoryDocument(record),
    })),
    deletes: [],
    metadata,
    value,
  };
}

async function seed(
  project: ProjectIdentity,
  records: MemoryRecord[],
  recordsMetadata: Record<string, RecordMeta> = Object.fromEntries(records.map(record => [record.id, meta()])),
  store = storeAt(project),
): Promise<{ store: MemoryStore; revision: string }> {
  const committed = await store.commit(null, mutationFor(project, records, recordsMetadata, 'seeded'));
  return { store, revision: committed.revision };
}

function draft(overrides: Partial<RecordDraft> = {}): RecordDraft {
  return {
    title: 'Consolidated context',
    body: 'The model supplied this replacement summary.',
    kind: 'note',
    category: 'other',
    ...overrides,
  };
}

function proposal(revision: string, obsoleteIds: string[] = [], consolidations: ConsolidationDraft[] = []): CleanupProposal {
  return { revision, obsoleteIds, consolidations };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code)
    : undefined;
}

function isCode(code: string): (error: unknown) => boolean {
  return error => errorCode(error) === code;
}

const fixedClock = () => new Date(NOW);

// Cleanup only accepts a complete, unique, link-safe scan.
test('plan uses the exact expiry boundary and reports superseded records without record bodies', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const atBoundary = makeMemory('mem_clean_boundary01');
    const superseded = makeMemory('mem_clean_superseded1', { status: 'superseded' });
    const future = makeMemory('mem_clean_future0001');
    const { store } = await seed(project, [atBoundary, superseded, future], {
      [atBoundary.id]: meta({ expiresAt: NOW }),
      [superseded.id]: meta(),
      [future.id]: meta({ expiresAt: LATER }),
    });
    const plan = await planCleanup(store, 123, fixedClock);
    assert.deepEqual(plan.obsolete.map(item => item.id), [atBoundary.id, superseded.id]);
    assert.deepEqual(plan.obsolete.map(item => item.reason), ['expired', 'superseded']);
    assert.equal(plan.requestedFreeBytes, 123);
    assert.equal(JSON.stringify(plan).includes(atBoundary.body), false);
    assert.equal(plan.candidates.some(item => item.id === future.id), true);
  });
});

test('plan rejects invalid requests, broken links, duplicate IDs, invalid files, and truncated scans', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const source = makeMemory('mem_clean_broken001', { links: ['mem_clean_absent001'] });
    const { store } = await seed(project, [source]);
    await assert.rejects(planCleanup(store, -1, fixedClock), isCode('CLEANUP_INVALID_REQUEST'));
    await assert.rejects(planCleanup(store, 1.5, fixedClock), isCode('CLEANUP_INVALID_REQUEST'));
    await assert.rejects(planCleanup(store, Number.MAX_SAFE_INTEGER + 1, fixedClock), isCode('CLEANUP_INVALID_REQUEST'));
    await assert.rejects(planCleanup(store, 0, fixedClock), isCode('CLEANUP_UNSAFE'));
  });
});

test('pinned records and their direct link targets remain protected', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const target = makeMemory('mem_clean_pinnedtarget1');
    const pinned = makeMemory('mem_clean_pinnedsource1', { links: [target.id] });
    const { store } = await seed(project, [target, pinned], {
      [target.id]: meta({ expiresAt: NOW }),
      [pinned.id]: meta({ pinned: true, expiresAt: NOW }),
    });
    const plan = await planCleanup(store, 0, fixedClock);
    assert.equal(plan.protectedCount, 2);
    assert.deepEqual(plan.obsolete, []);
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [target.id]), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_PROTECTED'));
    const snapshot = await store.withSnapshot(value => value);
    assert.ok(snapshot);
    assert.equal(readFileSync(join(snapshot.baseDir, 'project', 'notes', `${pinned.id}.md`), 'utf8'), ecc.serializeMemoryDocument(pinned));
    assert.equal(ecc.readMemoryFiles(createEccOptions(snapshot.baseDir)).entries.some(entry => entry.memory.id === target.id), true);
  });
});

test('records without sidecar metadata stay protected and count toward protection', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const record = makeMemory('mem_clean_nosidecar01');
    const { store } = await seed(project, [record], {});
    const plan = await planCleanup(store, 0, fixedClock);
    assert.equal(plan.protectedCount, 1);
    assert.deepEqual(plan.obsolete, []);
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [record.id]), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_PROTECTED'));
  });
});

test('obsolete cycles can be removed as one batch but not as a dangling partial batch', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const left = makeMemory('mem_clean_cycleleft01', { links: ['mem_clean_cycleright1'] });
    const right = makeMemory('mem_clean_cycleright1', { links: [left.id] });
    const { store } = await seed(project, [left, right], {
      [left.id]: meta({ expiresAt: NOW }),
      [right.id]: meta({ expiresAt: NOW }),
    });
    const plan = await planCleanup(store, 0, fixedClock);
    assert.deepEqual(plan.obsolete.map(item => item.id).sort(), [left.id, right.id].sort());
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [left.id]), sourceAt(project), async () => true, fixedClock), isCode('REPLACEMENT_REQUIRED'));
    const result = await applyCleanup(store, proposal(plan.revision as string, [left.id, right.id]), sourceAt(project), async () => { throw new Error('auto mode called approval'); }, fixedClock);
    assert.deepEqual(result.value.removedIds.sort(), [left.id, right.id].sort());
    assert.ok(result.value.freedBytes > 0);
  });
});

test('a referenced obsolete record needs a replacement before deletion', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const obsolete = makeMemory('mem_clean_refexpired01');
    const live = makeMemory('mem_clean_refsource01', { links: [obsolete.id] });
    const { store } = await seed(project, [obsolete, live], {
      [obsolete.id]: meta({ expiresAt: NOW }),
      [live.id]: meta(),
    });
    const plan = await planCleanup(store, 0, fixedClock);
    assert.equal(plan.obsolete.some(item => item.id === obsolete.id), false);
    assert.equal(plan.candidates.some(item => item.id === obsolete.id), true);
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [obsolete.id]), sourceAt(project), async () => true, fixedClock), isCode('REPLACEMENT_REQUIRED'));
  });
});

test('consolidation keeps provenance, source references, consolidated IDs, and retention history', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const first = makeMemory('mem_clean_unionfirst01', { links: ['mem_clean_unionsecond1'] });
    const second = makeMemory('mem_clean_unionsecond1');
    const firstSource = { ...sourceAt(project, 'source-one'), head: null };
    const secondSource = { ...sourceAt(project, 'source-two'), head: null };
    const { store } = await seed(project, [first, second], {
      [first.id]: meta({
        category: 'session', expiresAt: '2025-03-01T00:00:00.000Z',
        provenance: [firstSource], sourceRefs: ['ref-one', 'shared-ref'], consolidatedFrom: ['mem_clean_history001'],
      }),
      [second.id]: meta({
        expiresAt: '2025-03-02T00:00:00.000Z',
        provenance: [secondSource], sourceRefs: ['shared-ref', 'ref-two'], consolidatedFrom: ['mem_clean_history002'],
      }),
    });
    const plan = await planCleanup(store, 0, fixedClock);
    const result = await applyCleanup(store, proposal(plan.revision as string, [], [{ sourceIds: [first.id, second.id], summary: draft() }]), sourceAt(project), async () => false, fixedClock);
    const snapshot = await store.withSnapshot(value => value);
    assert.ok(snapshot);
    const created = result.value.createdIds[0] as string;
    const memory = ecc.readMemoryFiles(createEccOptions(snapshot.baseDir)).entries.find(entry => entry.memory.id === created)?.memory;
    assert.ok(memory);
    assert.deepEqual(memory.links, []);
    const metadata = snapshot.metadata.records[created];
    assert.ok(metadata);
    assert.deepEqual(metadata.sourceRefs, ['ref-one', 'shared-ref', 'ref-two']);
    assert.deepEqual(metadata.provenance, [firstSource, secondSource, sourceAt(project)]);
    assert.deepEqual(metadata.consolidatedFrom, [first.id, second.id, 'mem_clean_history001', 'mem_clean_history002']);
    assert.equal(metadata.expiresAt, '2025-03-01T00:00:00.000Z');
    assert.equal(metadata.pinned, false);
    assert.ok(result.value.freedBytes > 0);
  });
});

test('consolidation rejects metadata overflow instead of dropping history', async () => {
  await withTemp(async directory => {
    for (const kind of ['sourceRefs', 'provenance', 'consolidatedFrom'] as const) {
      const caseDirectory = join(directory, kind);
      mkdirSync(caseDirectory);
      const project = projectAt(caseDirectory);
      const safeKind = kind.toLowerCase();
      const first = makeMemory(`mem_clean_limit_${safeKind}01`);
      const second = makeMemory(`mem_clean_limit_${safeKind}02`);
      const firstMeta = kind === 'sourceRefs'
        ? meta({ sourceRefs: Array.from({ length: 33 }, (_, index) => `a-${index}`) })
        : kind === 'provenance'
          ? meta({ provenance: Array.from({ length: 256 }, (_, index) => ({ sessionId: `prior-${index}`, worktreeRoot: `/tmp/prior/${index}`, head: null })) })
          : meta({ consolidatedFrom: Array.from({ length: 512 }, (_, index) => `mem_prior_first_${String(index).padStart(4, '0')}`) });
      const secondMeta = kind === 'sourceRefs'
        ? meta({ sourceRefs: Array.from({ length: 33 }, (_, index) => `b-${index}`) })
        : kind === 'provenance'
          ? meta()
          : meta({ consolidatedFrom: Array.from({ length: 512 }, (_, index) => `mem_prior_second_${String(index).padStart(4, '0')}`) });
      const { store } = await seed(project, [first, second], { [first.id]: firstMeta, [second.id]: secondMeta });
      const plan = await planCleanup(store, 0, fixedClock);
      await assert.rejects(
        applyCleanup(store, proposal(plan.revision as string, [], [{ sourceIds: [first.id, second.id], summary: draft() }]), sourceAt(project), async () => true, fixedClock),
        isCode('PROVENANCE_LIMIT'),
        kind,
      );
      const snapshot = await store.withSnapshot(value => value);
      assert.ok(snapshot);
      assert.ok(snapshot.metadata.records[first.id]);
      assert.ok(snapshot.metadata.records[second.id]);
    }
  });
});

test('summary expansion that does not recover bytes fails without changing the snapshot', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const old = makeMemory('mem_clean_noprogress01', { body: 'Short.' });
    const { store, revision } = await seed(project, [old]);
    const plan = await planCleanup(store, 0, fixedClock);
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [], [{
      sourceIds: [old.id], summary: draft({ body: 'x'.repeat(2_000) }),
    }]), sourceAt(project), async () => true, fixedClock), isCode('NO_CLEANUP_PROGRESS'));
    assert.equal((await store.withSnapshot(value => value))?.revision, revision);
  });
});

test('cleanup rejects over-limit redirect sets before publication', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const source = makeMemory('mem_clean_redirectsource1');
    const survivors = Array.from({ length: 101 }, (_, index) => makeMemory(`mem_clean_redirect_${String(index).padStart(3, '0')}`, {
      links: [source.id],
    }));
    const records = [source, ...survivors];
    const { store, revision } = await seed(project, records);
    const plan = await planCleanup(store, 0, fixedClock);
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [], [{ sourceIds: [source.id], summary: draft() }]), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_INVALID_PROPOSAL'));
    assert.equal((await store.withSnapshot(value => value))?.revision, revision);
  });
});

test('automatic cleanup never calls approval and ask-first approval sees the exact preview outside the lock', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const expired = makeMemory('mem_clean_autoexpired1');
    const { store } = await seed(project, [expired], { [expired.id]: meta({ expiresAt: NOW }) });
    const plan = await planCleanup(store, 0, fixedClock);
    let calls = 0;
    await applyCleanup(store, proposal(plan.revision as string, [expired.id]), sourceAt(project), async () => {
      calls += 1;
      throw new Error('automatic cleanup must not ask');
    }, fixedClock);
    assert.equal(calls, 0);

    const askStore = storeAt(project, 'ask');
    const next = makeMemory('mem_clean_askexpired01', { title: 'Ask-first record' });
    const current = await askStore.withSnapshot(snapshot => snapshot);
    assert.ok(current);
    await askStore.commit(current.revision, mutationFor(project, [next], {
      ...current.metadata.records,
      [next.id]: meta({ expiresAt: NOW }),
    }, 'added'));
    const askPlan = await planCleanup(askStore, 0, fixedClock);
    let checkedOutsideLock = false;
    const askResult = await applyCleanup(askStore, proposal(askPlan.revision as string, [next.id]), sourceAt(project), async preview => {
      assert.equal(preview.revision, askPlan.revision);
      assert.ok(preview.digest.length === 64);
      assert.equal(preview.removedIds.includes(next.id), true);
      checkedOutsideLock = await askStore.withSnapshot(snapshot => snapshot?.revision === preview.revision);
      return true;
    }, fixedClock);
    assert.equal(checkedOutsideLock, true);
    assert.deepEqual(askResult.value.removedIds, [next.id]);
  });
});

test('ask-first refusal leaves record bytes and metadata unchanged', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const expired = makeMemory('mem_clean_declined001');
    const { store, revision } = await seed(project, [expired], { [expired.id]: meta({ expiresAt: NOW }) }, storeAt(project, 'ask'));
    const before = await store.withSnapshot(snapshot => ({
      revision: snapshot?.revision,
      document: snapshot ? readFileSync(join(snapshot.baseDir, 'project', 'notes', `${expired.id}.md`), 'utf8') : '',
      metadata: snapshot?.metadata,
    }));
    const plan = await planCleanup(store, 0, fixedClock);
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [expired.id]), sourceAt(project), async () => false, fixedClock), isCode('APPROVAL_REQUIRED'));
    const after = await store.withSnapshot(snapshot => ({
      revision: snapshot?.revision,
      document: snapshot ? readFileSync(join(snapshot.baseDir, 'project', 'notes', `${expired.id}.md`), 'utf8') : '',
      metadata: snapshot?.metadata,
    }));
    assert.equal(after.revision, revision);
    assert.deepEqual(after, before);
  });
});

test('stale approval cannot publish the approved cleanup proposal', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const expired = makeMemory('mem_clean_staleexpired1');
    const { store } = await seed(project, [expired], { [expired.id]: meta({ expiresAt: NOW }) }, storeAt(project, 'ask'));
    const plan = await planCleanup(store, 0, fixedClock);
    let interveningId = '';
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [expired.id]), sourceAt(project), async () => {
      const snapshot = await store.withSnapshot(value => value);
      assert.ok(snapshot);
      const other = makeMemory('mem_clean_staleinterven1');
      interveningId = other.id;
      await store.commit(snapshot.revision, mutationFor(project, [other], {
        ...snapshot.metadata.records,
        [other.id]: meta(),
      }, 'intervening'));
      return true;
    }, fixedClock), isCode('STALE_SNAPSHOT'));
    const current = await store.withSnapshot(snapshot => snapshot);
    assert.ok(current);
    assert.ok(ecc.readMemoryFiles(createEccOptions(current.baseDir)).entries.some(entry => entry.memory.id === expired.id));
    assert.ok(ecc.readMemoryFiles(createEccOptions(current.baseDir)).entries.some(entry => entry.memory.id === interveningId));
  });
});

test('cleanup redirects surviving links atomically and preserves every other field', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const old = makeMemory('mem_clean_redirectold01', { body: 'Large obsolete context.'.repeat(40), tags: ['old'] });
    const survivor = makeMemory('mem_clean_redirectlive1', { links: [old.id], tags: ['keep'], title: 'Keep this title' });
    const { store } = await seed(project, [old, survivor]);
    const plan = await planCleanup(store, 0, fixedClock);
    const result = await applyCleanup(store, proposal(plan.revision as string, [], [{
      sourceIds: [old.id], summary: draft({ body: 'Short replacement context.' }),
    }]), sourceAt(project), async () => false, fixedClock);
    const snapshot = await store.withSnapshot(value => value);
    assert.ok(snapshot);
    assert.deepEqual(result.value.redirectedIds, [survivor.id]);
    const replacementId = result.value.createdIds[0] as string;
    const entries = ecc.readMemoryFiles(createEccOptions(snapshot.baseDir)).entries;
    const redirected = entries.find(entry => entry.memory.id === survivor.id)?.memory;
    assert.ok(redirected);
    assert.deepEqual(redirected.links, [replacementId]);
    assert.equal(redirected.updatedAt, NOW);
    assert.equal(redirected.title, survivor.title);
    assert.deepEqual(redirected.tags, survivor.tags);
    assert.equal(redirected.body, survivor.body);
    assert.equal(existsSync(join(snapshot.baseDir, 'project', 'notes', `${old.id}.md`)), false);
    assert.equal(snapshot.metadata.records[survivor.id]?.pinned, false);
    assert.equal(snapshot.metadata.records[replacementId]?.consolidatedFrom.includes(old.id), true);
  });
});

test('cleanup deletes using the actual scanned relative path, not the record ID filename', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const record = makeMemory('mem_clean_actualid001');
    const { store } = await seed(project, [record], { [record.id]: meta({ expiresAt: NOW }) });
    const snapshot = await store.withSnapshot(value => value);
    assert.ok(snapshot);
    const oldPath = join(snapshot.baseDir, 'project', 'notes', `${record.id}.md`);
    const changedPath = join(snapshot.baseDir, 'project', 'notes', 'mem_clean_filename001.md');
    renameSync(oldPath, changedPath);
    const plan = await planCleanup(store, 0, fixedClock);
    await applyCleanup(store, proposal(plan.revision as string, [record.id]), sourceAt(project), async () => false, fixedClock);
    const current = await store.withSnapshot(value => value);
    assert.ok(current);
    assert.equal(existsSync(join(current.baseDir, 'project', 'notes', 'mem_clean_filename001.md')), false);
  });
});

test('proposal validation rejects duplicate, overlapping, unknown, active, and stale IDs', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const expired = makeMemory('mem_clean_validateold01');
    const active = makeMemory('mem_clean_validateactive1');
    const { store } = await seed(project, [expired, active], {
      [expired.id]: meta({ expiresAt: NOW }), [active.id]: meta(),
    });
    const plan = await planCleanup(store, 0, fixedClock);
    const summary = [{ sourceIds: [active.id], summary: draft() }];
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [expired.id, expired.id]), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_INVALID_PROPOSAL'));
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, ['mem_clean_unknown001']), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_UNKNOWN_ID'));
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [active.id]), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_NOT_OBSOLETE'));
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [], summary), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_OBSOLETE_REQUIRED'));
    await assert.rejects(applyCleanup(store, proposal(plan.revision as string, [expired.id], [{ sourceIds: [expired.id], summary: draft() }]), sourceAt(project), async () => true, fixedClock), isCode('CLEANUP_INVALID_PROPOSAL'));
    await assert.rejects(applyCleanup(store, proposal('00000000-0000-0000-0000-000000000000', [expired.id]), sourceAt(project), async () => true, fixedClock), isCode('STALE_SNAPSHOT'));
  });
});

test('invalid, duplicate, and broken scans fail without publication', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const record = makeMemory('mem_clean_invalidscan01');
    const { store, revision } = await seed(project, [record], { [record.id]: meta({ expiresAt: NOW }) });
    const snapshot = await store.withSnapshot(value => value);
    assert.ok(snapshot);
    const invalid = join(snapshot.baseDir, 'project', 'notes', 'mem_clean_invalid0001.md');
    writeFileSync(invalid, 'not an ECC document');
    await assert.rejects(planCleanup(store, 0, fixedClock), isCode('CLEANUP_UNSAFE'));
    rmSync(invalid);
    const duplicate = makeMemory(record.id, { kind: 'fact' });
    writeFileSync(join(snapshot.baseDir, 'project', 'facts', `${duplicate.id}.md`), ecc.serializeMemoryDocument(duplicate));
    await assert.rejects(planCleanup(store, 0, fixedClock), isCode('CLEANUP_UNSAFE'));
    rmSync(join(snapshot.baseDir, 'project', 'facts', `${duplicate.id}.md`));
    const broken = makeMemory('mem_clean_brokenlink01', { links: ['mem_clean_missing001'] });
    writeFileSync(join(snapshot.baseDir, 'project', 'notes', `${broken.id}.md`), ecc.serializeMemoryDocument(broken));
    await assert.rejects(planCleanup(store, 0, fixedClock), isCode('CLEANUP_UNSAFE'));
    assert.equal((await store.withSnapshot(value => value))?.revision, revision);
  });
});

test('pre-publication failure keeps the old snapshot; post-publication failure returns pending maintenance', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const old = makeMemory('mem_clean_failureold01', { body: 'x'.repeat(2_000) });
    const { store } = await seed(project, [old]);
    const firstPlan = await planCleanup(store, 0, fixedClock);
    const preFailure = new Error('before publish');
    const beforePublishStore = storeAt(project, 'auto', 10_485_760, phase => {
      if (phase === 'before_publish') throw preFailure;
    });
    await assert.rejects(applyCleanup(beforePublishStore, proposal(firstPlan.revision as string, [], [{ sourceIds: [old.id], summary: draft() }]), sourceAt(project), async () => false, fixedClock), error => error === preFailure);
    const afterFailure = await store.withSnapshot(value => value);
    assert.ok(afterFailure);
    assert.ok(ecc.readMemoryFiles(createEccOptions(afterFailure.baseDir)).entries.some(entry => entry.memory.id === old.id));

    const nextPlan = await planCleanup(store, 0, fixedClock);
    const afterPublishStore = storeAt(project, 'auto', 10_485_760, phase => {
      if (phase === 'before_gc') throw new Error('after publish');
    });
    const published = await applyCleanup(afterPublishStore, proposal(nextPlan.revision as string, [], [{ sourceIds: [old.id], summary: draft() }]), sourceAt(project), async () => false, fixedClock);
    assert.equal(published.maintenance, 'pending');
    const current = await store.withSnapshot(value => value);
    assert.ok(current);
    assert.equal(ecc.readMemoryFiles(createEccOptions(current.baseDir)).entries.some(entry => entry.memory.id === old.id), false);
  });
});
