import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ContextError, ecc } from '../src/ecc.ts';
import type { MemoryRecord } from '../src/ecc.ts';
import type { ProjectIdentity } from '../src/project.ts';
import { openMemoryStore } from '../src/store.ts';
import type { RecordMeta, SnapshotMutation, StoreMetadata, StorePhase } from '../src/store.ts';

const FIXED_NOW = '2025-02-03T04:05:06.000Z';
const DEFAULT_LIMIT = 10_485_760;
const PROCESS_FIXTURE = new URL('./fixtures/store-process.ts', import.meta.url).pathname;

function withTemp(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-context-store-'));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
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
function record(id: string, body = 'Store fixture body.', kind: MemoryRecord['kind'] = 'note'): MemoryRecord {
  return ecc.normalizeMemory({
    schema: 'ecc.memory.v1',
    id,
    title: 'Store fixture',
    kind,
    scope: 'project',
    trust: 'unreviewed',
    status: 'active',
    sourceHarness: 'pi',
    targetHarnesses: ['pi'],
    tags: [],
    links: [],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    body,
  });
}
function recordMeta(overrides: Partial<RecordMeta> = {}): RecordMeta {
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
function metadata(project: ProjectIdentity, records: string[] = []): StoreMetadata {
  return {
    version: 1,
    identityKey: project.identityKey,
    records: Object.fromEntries(records.map(id => [id, recordMeta()])),
  };
}
function mutation<T = string>(
  project: ProjectIdentity,
  records: MemoryRecord[],
  value: T = 'committed' as T,
  overrides: Partial<SnapshotMutation<T>> = {},
): SnapshotMutation<T> {
  return {
    writes: records.map(memory => ({
      relativePath: `project/${memory.kind}s/${memory.id}.md`,
      content: ecc.serializeMemoryDocument(memory),
    })),
    deletes: [],
    metadata: metadata(project, records.map(memory => memory.id)),
    value,
    ...overrides,
  };
}
function store(project: ProjectIdentity, maxBytes = DEFAULT_LIMIT, onPhase?: (phase: StorePhase) => void) {
  return openMemoryStore(project, { maxBytes, cleanupMode: 'auto' }, { onPhase });
}
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code)
    : undefined;
}
function isCode(code: string): (error: unknown) => boolean {
  return error => errorCode(error) === code;
}
function sumFileLengths(target: string): number {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    return readdirSync(target).reduce((total, name) => total + sumFileLengths(join(target, name)), 0);
  }
  return info.isFile() || info.isSymbolicLink() ? Number(info.size) : 0;
}

test('missing stores stay read-only and estimate uses UTF-8 byte lengths', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const memoryStore = store(project);
    assert.deepEqual(await memoryStore.inspect(), {
      revision: null,
      persistentBytes: 0,
      temporaryBytes: 0,
      limitBytes: DEFAULT_LIMIT,
      overLimit: false,
      needsRecovery: false,
    });
    assert.equal(await memoryStore.withSnapshot(snapshot => snapshot), null);
    const ascii = record('mem_store_ascii0001', 'abcde');
    const unicode = record('mem_store_ascii0001', 'ééééé');
    const asciiEstimate = await memoryStore.estimate(null, mutation(project, [ascii]));
    const unicodeEstimate = await memoryStore.estimate(null, mutation(project, [unicode]));
    assert.equal(unicodeEstimate.projectedBytes - asciiEstimate.projectedBytes, 5);
    assert.equal(unicodeEstimate.additionalTemporaryBytes - asciiEstimate.additionalTemporaryBytes, 5);
    assert.equal(lstatSync(project.memoryDir, { throwIfNoEntry: false }), undefined);
  });
});

test('first commit publishes a complete snapshot with private modes and exact protective ignore content', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const memoryStore = store(project);
    const saved = record('mem_store_first0001');
    const result = await memoryStore.commit(null, mutation(project, [saved], 'result'));
    assert.equal(result.value, 'result');
    assert.equal(result.maintenance, 'clean');
    const snapshot = await memoryStore.withSnapshot(value => value);
    assert.ok(snapshot);
    assert.equal(snapshot.revision, result.revision);
    assert.deepEqual(snapshot.metadata, metadata(project, [saved.id]));
    assert.equal(readFileSync(join(snapshot.baseDir, 'project', '.gitignore'), 'utf8'), '*\n!.gitignore\n');
    assert.equal(ecc.parseMemoryDocument(readFileSync(join(snapshot.baseDir, 'project', 'notes', `${saved.id}.md`), 'utf8')).id, saved.id);
    assert.equal(statSync(join(project.memoryDir, 'current.json')).mode & 0o777, 0o600);
    assert.equal(statSync(snapshot.baseDir).mode & 0o777, 0o700);
    assert.equal((await memoryStore.inspect()).revision, result.revision);
  });
});

test('pre-publication failures keep the old pointer readable and clean recognized staging', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const first = record('mem_store_old000001', 'old readable body');
    const initial = await store(project).commit(null, mutation(project, [first]));
    const pointerPath = join(project.memoryDir, 'current.json');
    const oldPointer = readFileSync(pointerPath, 'utf8');
    const injected = new ContextError('INJECTED_FAILURE', 'injected before publication');
    const failing = store(project, DEFAULT_LIMIT, phase => {
      if (phase === 'before_publish') throw injected;
    });
    const replacement = record('mem_store_new000001', 'new body');
    await assert.rejects(failing.commit(initial.revision, mutation(project, [replacement])), error => {
      assert.equal(error, injected);
      assert.equal(errorCode(error), 'INJECTED_FAILURE');
      assert.equal((error as { details?: { recoveryRequired?: boolean } }).details?.recoveryRequired, false);
      return true;
    });
    assert.equal(readFileSync(pointerPath, 'utf8'), oldPointer);
    const snapshot = await store(project).withSnapshot(value => value);
    assert.equal(snapshot?.revision, initial.revision);
    assert.equal(ecc.parseMemoryDocument(readFileSync(join(snapshot!.baseDir, 'project', 'notes', `${first.id}.md`), 'utf8')).body, 'old readable body');
    assert.equal((await store(project).inspect()).temporaryBytes, 0);
  });
});

test('published state is returned as pending after failed garbage collection and recovery blocks later writes', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const initialRecord = record('mem_store_gc_old0001');
    const initial = await store(project).commit(null, mutation(project, [initialRecord]));
    const nextRecord = record('mem_store_gc_new0001');
    const failing = store(project, DEFAULT_LIMIT, phase => {
      if (phase === 'before_gc') throw new Error('injected garbage removal failure');
    });
    const published = await failing.commit(initial.revision, mutation(project, [nextRecord]));
    assert.equal(published.maintenance, 'pending');
    assert.equal((await store(project).withSnapshot(value => value))?.revision, published.revision);
    const recoveredStatus = await store(project).inspect();
    assert.equal(recoveredStatus.revision, published.revision);
    assert.equal(recoveredStatus.needsRecovery, false);
    const following = record('mem_store_gc_next0001');
    const result = await store(project).commit(published.revision, mutation(project, [following]));
    assert.equal(result.maintenance, 'clean');
  });
});

test('concurrent store objects reject a stale writer instead of replacing the newer revision', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const left = store(project);
    const right = store(project);
    const proposals = await Promise.allSettled([
      left.commit(null, mutation(project, [record('mem_store_race_left01')], 'left')),
      right.commit(null, mutation(project, [record('mem_store_race_right1')], 'right')),
    ]);
    assert.equal(proposals.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = proposals.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.equal(errorCode(rejected.reason), 'STALE_SNAPSHOT');
  });
});

test('an active snapshot read holds the project lock against a separate writer process', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const initial = await store(project).commit(null, mutation(project, [record('mem_store_read_lock01')]));
    const snapshot = await store(project).withSnapshot(value => {
      assert.equal(value?.revision, initial.revision);
      const child = spawnSync(process.execPath, [
        '--experimental-strip-types', PROCESS_FIXTURE, project.memoryDir, 'attempt', project.root,
      ], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'busy');
      return value;
    });
    assert.equal(snapshot?.revision, initial.revision);
    assert.equal((await store(project).inspect()).revision, initial.revision);
  });
});

test('estimate and commit enforce exact projected and staging byte boundaries', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const proposed = mutation(project, [record('mem_store_boundary01', 'é'.repeat(24))]);
    const estimate = await store(project).estimate(null, proposed);
    assert.ok(estimate.projectedBytes > 0);
    assert.ok(estimate.additionalTemporaryBytes >= estimate.projectedBytes);
    const exactPersistentLimit = store(project, estimate.projectedBytes);
    await assert.rejects(exactPersistentLimit.commit(null, proposed), isCode('STAGING_LIMIT'));
    const belowPersistentLimit = store(project, estimate.projectedBytes - 1);
    await assert.rejects(belowPersistentLimit.commit(null, proposed), isCode('QUOTA_EXCEEDED'));
    assert.equal(existsSync(project.memoryDir), false);
    let peakAdditionalBytes = 0;
    const exactStagingLimit = openMemoryStore(project, {
      maxBytes: estimate.additionalTemporaryBytes,
      cleanupMode: 'auto',
    }, {
      onPhase(phase) {
        if (phase === 'staged' || phase === 'before_publish' || phase === 'published' || phase === 'before_gc') {
          const transactionPath = join(project.memoryDir, 'transaction.json');
          const transaction = JSON.parse(readFileSync(transactionPath, 'utf8')) as { newRevision: string };
          const revision = transaction.newRevision;
          const temporaryPointer = join(project.memoryDir, '.staging', `${revision}.current`);
          const currentPath = join(project.memoryDir, 'current.json');
          let pointerBytes = sumFileLengths(temporaryPointer);
          if (pointerBytes === 0 && existsSync(currentPath)) {
            const current = JSON.parse(readFileSync(currentPath, 'utf8')) as { revision?: string };
            if (current.revision === revision) pointerBytes = sumFileLengths(currentPath);
          }
          const allocated = sumFileLengths(join(project.memoryDir, 'generations', revision)) +
            sumFileLengths(transactionPath) + pointerBytes;
          peakAdditionalBytes = Math.max(peakAdditionalBytes, allocated);
        }
      },
    });
    const result = await exactStagingLimit.commit(null, proposed);
    assert.equal(result.maintenance, 'clean');
    assert.equal(peakAdditionalBytes, estimate.additionalTemporaryBytes);
    assert.ok(peakAdditionalBytes <= estimate.additionalTemporaryBytes);
    assert.ok((await exactStagingLimit.inspect()).persistentBytes <= estimate.additionalTemporaryBytes);

    const oversized = mutation(project, [record('mem_store_oversized01', 'x'.repeat(2_000))]);
    const overhead = await store(project).estimate(result.revision, oversized);
    const tooSmallForStage = store(project, overhead.additionalTemporaryBytes - 1);
    await assert.rejects(tooSmallForStage.commit(result.revision, oversized), isCode('STAGING_LIMIT'));
  });
});

test('metadata growth is included in projected and temporary byte estimates', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const base = mutation(project, []);
    const grownMetadata = metadata(project);
    grownMetadata.records.mem_store_growth001 = recordMeta({
      sourceRefs: Array.from({ length: 100 }, (_, index) => `mem_store_source${String(index).padStart(4, '0')}`),
    });
    const grown = { ...base, metadata: grownMetadata };
    const baseEstimate = await store(project).estimate(null, base);
    const grownEstimate = await store(project).estimate(null, grown);
    const metadataGrowth = Buffer.byteLength(`${JSON.stringify(grownMetadata)}\n`) -
      Buffer.byteLength(`${JSON.stringify(base.metadata)}\n`);
    assert.equal(grownEstimate.projectedBytes - baseEstimate.projectedBytes, metadataGrowth);
    assert.ok(grownEstimate.additionalTemporaryBytes > baseEstimate.additionalTemporaryBytes);
  });
});

test('quota reduction permits a shrinking replacement that removes the large old record', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const oldRecord = record('mem_store_large_old01', 'x'.repeat(5_000));
    const initial = await store(project, 50_000).commit(null, mutation(project, [oldRecord]));
    const shrinking = mutation(project, [], 'shrank', {
      deletes: [`project/notes/${oldRecord.id}.md`],
      metadata: metadata(project),
    });
    const highLimitEstimate = await store(project, 50_000).estimate(initial.revision, shrinking);
    const reducedLimit = highLimitEstimate.additionalTemporaryBytes;
    assert.ok((await store(project, 50_000).inspect()).persistentBytes > reducedLimit);
    const result = await store(project, reducedLimit).commit(initial.revision, shrinking);
    assert.equal(result.value, 'shrank');
    assert.ok((await store(project, reducedLimit).inspect()).persistentBytes <= reducedLimit);
    const snapshot = await store(project, reducedLimit).withSnapshot(value => value);
    assert.ok(snapshot);
    assert.equal(existsSync(join(snapshot.baseDir, 'project', 'notes', `${oldRecord.id}.md`)), false);
  });
});

test('hidden files, inactive generations, and unknown project files count and survive commits', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const active = record('mem_store_unknown_old01');
    const inactiveRecord = ecc.normalizeMemory({ ...record('mem_store_inactive01'), status: 'superseded' });
    const first = await store(project).commit(null, mutation(project, [active, inactiveRecord]));
    const firstPersistentBytes = (await store(project).inspect()).persistentBytes;
    const snapshot = await store(project).withSnapshot(value => value);
    const activeUnknown = join(snapshot!.baseDir, 'project', '.private-sidecar');
    writeFileSync(activeUnknown, 'active-hidden-content');
    const activeGenerationUnknown = join(snapshot!.baseDir, 'generation-sidecar.bin');
    const activeGenerationContent = Buffer.alloc(200_000, 0x61);
    writeFileSync(activeGenerationUnknown, activeGenerationContent);
    const rootUnknown = join(project.memoryDir, '.unknown-control');
    writeFileSync(rootUnknown, 'root-hidden');
    const inactiveGeneration = join(project.memoryDir, 'generations', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    mkdirSync(inactiveGeneration, { recursive: true });
    writeFileSync(join(inactiveGeneration, 'orphan.bin'), 'inactive-generation');
    const oldStatus = await store(project).inspect();
    assert.equal(oldStatus.persistentBytes - firstPersistentBytes,
      Buffer.byteLength('active-hidden-content') + activeGenerationContent.length +
      Buffer.byteLength('root-hidden') + Buffer.byteLength('inactive-generation'));
    const next = record('mem_store_unknown_new01');
    const result = await store(project).commit(first.revision, mutation(project, [next]));
    const nextSnapshot = await store(project).withSnapshot(value => value);
    assert.equal(readFileSync(join(nextSnapshot!.baseDir, 'project', '.private-sidecar'), 'utf8'), 'active-hidden-content');
    assert.deepEqual(readFileSync(join(nextSnapshot!.baseDir, 'generation-sidecar.bin')), activeGenerationContent);
    assert.equal(ecc.parseMemoryDocument(readFileSync(join(nextSnapshot!.baseDir, 'project', 'notes', `${inactiveRecord.id}.md`), 'utf8')).status, 'superseded');
    assert.equal(readFileSync(rootUnknown, 'utf8'), 'root-hidden');
    assert.equal(readFileSync(join(inactiveGeneration, 'orphan.bin'), 'utf8'), 'inactive-generation');
    assert.equal(result.maintenance, 'clean');
  });
});

test('symlinks count without following and block snapshot mutation', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const initial = await store(project).commit(null, mutation(project, [record('mem_store_symlink001')]));
    const snapshot = await store(project).withSnapshot(value => value);
    const outside = join(directory, 'outside.md');
    writeFileSync(outside, 'z'.repeat(10_000));
    const before = await store(project).inspect();
    const linkPath = join(snapshot!.baseDir, 'project', 'notes', 'linked.md');
    symlinkSync(outside, linkPath);
    const after = await store(project).inspect();
    const persistedLinkBytes = lstatSync(linkPath).size;
    assert.equal(persistedLinkBytes, Buffer.byteLength(outside));
    assert.equal(after.persistentBytes - before.persistentBytes, persistedLinkBytes);
    assert.ok(after.persistentBytes < statSync(outside).size);
    await assert.rejects(
      store(project).commit(initial.revision, mutation(project, [record('mem_store_symlink002')])),
      isCode('STORE_UNSAFE'),
    );
  });
});

test('aborts and missing current generations fail without deleting readable data', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const saved = record('mem_store_abort_old001');
    const initial = await store(project).commit(null, mutation(project, [saved]));
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(store(project).commit(initial.revision, mutation(project, [record('mem_store_abort_new01')]), abort.signal), isCode('STORE_ABORTED'));
    const activeAbort = new AbortController();
    const abortingStore = store(project, DEFAULT_LIMIT, phase => {
      if (phase === 'before_publish') activeAbort.abort();
    });
    await assert.rejects(
      abortingStore.commit(initial.revision, mutation(project, [record('mem_store_abort_mid01')]), activeAbort.signal),
      isCode('STORE_ABORTED'),
    );
    assert.equal((await store(project).withSnapshot(snapshot => snapshot))?.revision, initial.revision);
    const generation = join(project.memoryDir, 'generations', initial.revision);
    rmSync(generation, { recursive: true, force: true });
    await assert.rejects(store(project).inspect(), isCode('STORE_RECOVERY_REQUIRED'));
  });
});

test('corrupt control files and symlink roots fail closed', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const initial = await store(project).commit(null, mutation(project, [record('mem_store_control001')]));
    writeFileSync(join(project.memoryDir, 'current.json'), '{broken');
    await assert.rejects(store(project).inspect(), isCode('STORE_INVALID'));
    rmSync(project.memoryDir, { recursive: true, force: true });
    symlinkSync(join(directory, 'elsewhere'), project.memoryDir, 'dir');
    await assert.rejects(store(project).inspect(), isCode('STORE_UNSAFE'));
    assert.ok(initial.revision);
  });
});

test('stored metadata rejects unknown fields and a mismatched project identity', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    await store(project).commit(null, mutation(project, [record('mem_store_metadata001')]));
    const snapshot = await store(project).withSnapshot(value => value);
    const metadataPath = join(snapshot!.baseDir, 'metadata.json');
    const original = readFileSync(metadataPath, 'utf8');
    const parsed = JSON.parse(original) as Record<string, unknown>;
    writeFileSync(metadataPath, JSON.stringify({ ...parsed, unknown: true }));
    await assert.rejects(store(project).inspect(), isCode('STORE_INVALID'));
    const wrongIdentity = { ...parsed, identityKey: 'configured\\0different-root' };
    writeFileSync(metadataPath, JSON.stringify(wrongIdentity));
    await assert.rejects(store(project).inspect(), isCode('STORE_INVALID'));
  });
});

test('lock compromise before publication stops the mutation and preserves the old pointer', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const initial = await store(project).commit(null, mutation(project, [record('mem_store_lock_old01')]));
    const compromised = store(project, DEFAULT_LIMIT, phase => {
      if (phase === 'staged') rmSync(join(project.memoryDir, '.lock'), { recursive: true, force: true });
    });
    await assert.rejects(
      compromised.commit(initial.revision, mutation(project, [record('mem_store_lock_new01')])),
      isCode('STORE_LOCK_COMPROMISED'),
    );
    assert.equal((await store(project).withSnapshot(snapshot => snapshot))?.revision, initial.revision);
  });
});

test('separate fixture processes recover interruptions before and after publication', async () => {
  await withTemp(async directory => {
    for (const phase of ['staged', 'published'] as const) {
      const caseDir = join(directory, phase);
      mkdirSync(caseDir);
      const project = projectAt(caseDir);
      const child = spawnSync(process.execPath, ['--experimental-strip-types', PROCESS_FIXTURE, project.memoryDir, phase, project.root], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(child.signal, 'SIGKILL', `${phase}: ${child.stderr}`);
      const status = await store(project).inspect();
      if (phase === 'staged') {
        assert.equal(status.revision, null);
        assert.equal(status.temporaryBytes, 0);
      } else {
        assert.ok(status.revision);
        const snapshot = await store(project).withSnapshot(value => value);
        assert.equal(snapshot?.revision, status.revision);
        assert.equal(ecc.parseMemoryDocument(readFileSync(join(snapshot!.baseDir, 'project', 'notes', 'mem_process_record01.md'), 'utf8')).id, 'mem_process_record01');
      }
    }
  });
});

test('metadata source references accept safe non-memory references and reject invalid values', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const saved = record('mem_store_source_ref01');
    const proposed = mutation(project, [saved]);
    proposed.metadata.records[saved.id]!.sourceRefs = [
      'https://example.test/source?id=one',
      `ref:${'x'.repeat(2_044)}`,
    ];
    const committed = await store(project).commit(null, proposed);
    const snapshot = await store(project).withSnapshot(value => value);
    assert.equal(snapshot?.revision, committed.revision);
    assert.deepEqual(snapshot?.metadata.records[saved.id]?.sourceRefs, proposed.metadata.records[saved.id]?.sourceRefs);

    const duplicate = mutation(project, [record('mem_store_source_dup01')]);
    duplicate.metadata.records.mem_store_source_dup01!.sourceRefs = ['same-ref', 'same-ref'];
    await assert.rejects(store(project).estimate(committed.revision, duplicate), isCode('STORE_INVALID'));

    const tooLong = mutation(project, [record('mem_store_source_long01')]);
    tooLong.metadata.records.mem_store_source_long01!.sourceRefs = ['x'.repeat(2_049)];
    await assert.rejects(store(project).estimate(committed.revision, tooLong), isCode('STORE_INVALID'));
  });
});

test('invalid paths, metadata fields, timestamps, kinds, and revisions are rejected before staging', async () => {
  await withTemp(async directory => {
    const project = projectAt(directory);
    const memoryStore = store(project);
    const valid = mutation(project, [record('mem_store_invalid001')]);
    await assert.rejects(memoryStore.estimate(null, {
      ...valid,
      writes: [{ ...valid.writes[0]!, relativePath: 'project/notes/../../escape.md' }],
    }), isCode('STORE_INVALID'));
    const unknownMetadata = { ...valid.metadata, extra: true } as StoreMetadata;
    await assert.rejects(memoryStore.estimate(null, { ...valid, metadata: unknownMetadata }), isCode('STORE_INVALID'));
    const badTimestamp = metadata(project, ['mem_store_invalid001']);
    badTimestamp.records.mem_store_invalid001!.expiresAt = 'not-a-date';
    await assert.rejects(memoryStore.estimate(null, { ...valid, metadata: badTimestamp }), isCode('STORE_INVALID'));
    await assert.rejects(memoryStore.estimate(null, {
      ...valid,
      writes: [{ ...valid.writes[0]!, relativePath: `project/facts/${record('mem_store_invalid001').id}.md` }],
    }), isCode('STORE_INVALID'));
    assert.equal(lstatSync(project.memoryDir, { throwIfNoEntry: false }), undefined);
  });
});
