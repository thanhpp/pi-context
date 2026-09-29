import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openMemoryStore } from '../../src/store.ts';
import type { ProjectIdentity } from '../../src/project.ts';
import type { StoreMetadata, StorePhase } from '../../src/store.ts';
import { ecc } from '../../src/ecc.ts';

const [memoryDir, stopAt, root] = process.argv.slice(2);
if (!memoryDir || !stopAt || !root) throw new Error('Expected a memory directory, phase, and project root.');
const identityKey = `configured\0${root}`;
const project: ProjectIdentity = {
  id: 'fixture-project',
  identityKey,
  kind: 'configured',
  root,
  worktreeRoot: root,
  memoryDir,
};
const store = openMemoryStore(project, { maxBytes: 1_000_000, cleanupMode: 'auto' }, {
  onPhase(phase: StorePhase) {
    if (phase === stopAt) {
      rmSync(join(memoryDir, '.lock'), { recursive: true, force: true });
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
const record = ecc.normalizeMemory({
  schema: 'ecc.memory.v1',
  id: 'mem_process_record01',
  title: 'Process fixture',
  kind: 'note',
  scope: 'project',
  trust: 'unreviewed',
  status: 'active',
  sourceHarness: 'pi',
  targetHarnesses: ['pi'],
  tags: [],
  links: [],
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  body: 'Process fixture body.',
});
const metadata: StoreMetadata = {
  version: 1,
  identityKey,
  records: {
    [record.id]: {
      category: 'other',
      pinned: false,
      expiresAt: null,
      provenance: [],
      sourceRefs: [],
      consolidatedFrom: [],
    },
  },
};
try {
  await store.commit(null, {
    writes: [{ relativePath: `project/notes/${record.id}.md`, content: ecc.serializeMemoryDocument(record) }],
    deletes: [],
    metadata,
    value: 'fixture',
  });
} catch (error) {
  if (stopAt === 'attempt' && error instanceof Error && 'code' in error && error.code === 'STORE_BUSY') {
    process.stdout.write('busy');
  } else {
    throw error;
  }
}
