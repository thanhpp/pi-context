import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEccOptions, ecc } from '../src/ecc.ts';
import type { EccOptions, MemoryRecord } from '../src/ecc.ts';

const FIXED_NOW = '2025-02-03T04:05:06.000Z';

async function withVault(
  run: (options: EccOptions, baseDir: string) => void | Promise<void>,
): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), 'pi-context-ecc-'));
  try {
    const base = createEccOptions(baseDir);
    ecc.initializeVault(base);
    let nextId = 0;
    const options: EccOptions = {
      ...base,
      now: () => FIXED_NOW,
      idFactory: () => `mem_fixture_${String(++nextId).padStart(4, '0')}`,
    };
    await run(options, baseDir);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return ecc.normalizeMemory({
    schema: 'ecc.memory.v1',
    id: 'mem_fixture_record01',
    title: 'Fixture title',
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
    body: 'Fixture body.',
    ...overrides,
  });
}

function save(
  options: EccOptions,
  input: Partial<MemoryRecord> & Pick<MemoryRecord, 'title' | 'body'>,
): MemoryRecord {
  return ecc.saveMemory({
    id: input.id,
    title: input.title,
    kind: input.kind,
    scope: input.scope,
    sourceHarness: input.sourceHarness,
    targetHarnesses: input.targetHarnesses,
    tags: input.tags,
    links: input.links,
    body: input.body,
  }, options).memory;
}

function writeDocument(
  options: EccOptions,
  memory: MemoryRecord,
  directoryKind: MemoryRecord['kind'] = memory.kind,
  filename = memory.id,
): string {
  const directory = join(options.roots.project, `${directoryKind}s`);
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, `${filename}.md`);
  writeFileSync(filePath, ecc.serializeMemoryDocument(memory), 'utf8');
  return filePath;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    return String((error as Error & { code: unknown }).code);
  }
  return undefined;
}

test('createEccOptions fixes project scope and rejects ambient ECC root overrides', async () => {
  const oldProject = process.env.ECC_MEMORY_PROJECT_ROOT;
  const oldUser = process.env.ECC_MEMORY_USER_ROOT;
  const ambientProject = join(tmpdir(), 'ambient-project-root');
  const ambientUser = join(tmpdir(), 'ambient-user-root');
  process.env.ECC_MEMORY_PROJECT_ROOT = ambientProject;
  process.env.ECC_MEMORY_USER_ROOT = ambientUser;
  try {
    await withVault((options, baseDir) => {
      assert.deepEqual(options.scopes, ['project']);
      assert.equal(options.targetHarness, 'pi');
      assert.equal(options.roots.project, join(baseDir, 'project'));
      assert.equal(options.roots.user, join(baseDir, '.disabled-user'));
      assert.notEqual(options.roots.project, ambientProject);
      assert.notEqual(options.roots.user, ambientUser);
      assert.ok(Object.getOwnPropertySymbols(options.roots).length > 0);
      assert.equal(process.env.ECC_MEMORY_PROJECT_ROOT, ambientProject);
      assert.equal(process.env.ECC_MEMORY_USER_ROOT, ambientUser);
      const memory = save(options, { title: 'isolated', body: 'local record' });
      assert.equal(
        ecc.readMemoryById(memory.id, options).path,
        `project:notes/${memory.id}.md`,
      );
    });
  } finally {
    if (oldProject === undefined) delete process.env.ECC_MEMORY_PROJECT_ROOT;
    else process.env.ECC_MEMORY_PROJECT_ROOT = oldProject;
    if (oldUser === undefined) delete process.env.ECC_MEMORY_USER_ROOT;
    else process.env.ECC_MEMORY_USER_ROOT = oldUser;
  }
});

test('format facade preserves all frontmatter fields, record kinds, and boundaries', () => {
  const memory = makeMemory();
  const document = ecc.serializeMemoryDocument(memory);
  const fields = document.split('\n').slice(1, 14);
  assert.deepEqual(fields.map(field => field.slice(0, field.indexOf(':'))), [
    'schema',
    'id',
    'title',
    'kind',
    'scope',
    'trust',
    'status',
    'source_harness',
    'target_harnesses',
    'tags',
    'links',
    'created_at',
    'updated_at',
  ]);
  for (const field of fields) {
    assert.doesNotThrow(() => JSON.parse(field.slice(field.indexOf(':') + 1).trim()));
  }
  assert.deepEqual(ecc.parseMemoryDocument(document), memory);

  const kinds: MemoryRecord['kind'][] = [
    'context', 'decision', 'fact', 'handoff', 'lesson', 'note', 'preference', 'runbook',
  ];
  for (const kind of kinds) {
    assert.equal(makeMemory({ kind }).kind, kind);
  }

  assert.equal(Buffer.byteLength(makeMemory({ body: 'x'.repeat(64 * 1024) }).body), 64 * 1024);
  assert.throws(() => makeMemory({ body: 'x'.repeat(64 * 1024 + 1) }), /too large/);
  assert.throws(
    () => ecc.parseMemoryDocument(`---\n${'x'.repeat(128 * 1024 - 4)}`),
    /no closing frontmatter marker/,
  );
  assert.throws(
    () => ecc.parseMemoryDocument(`---\n${'x'.repeat(128 * 1024 - 3)}`),
    /too large/,
  );
});

test('format facade rejects extra and duplicate fields, unsafe controls, and secrets', async () => {
  const document = ecc.serializeMemoryDocument(makeMemory());
  const closingMarker = document.indexOf('\n---\n');
  const withExtraField = `${document.slice(0, closingMarker)}\nextra: "value"${document.slice(closingMarker)}`;
  assert.throws(() => ecc.parseMemoryDocument(withExtraField), /Unknown memory frontmatter field/);
  assert.throws(
    () => ecc.parseMemoryDocument(document.replace('---\n', '---\nschema: "ecc.memory.v1"\n')),
    /Duplicate memory frontmatter field/,
  );
  assert.throws(() => makeMemory({ title: 'unsafe\u0001title' }), /control/);
  assert.throws(() => makeMemory({ body: 'unsafe\u0001body' }), /control/);
  assert.equal(ecc.hasUnsafeControlCharacters('\u202e'), true);
  assert.deepEqual(ecc.findPotentialSecrets(`key sk-${'A'.repeat(24)}`), ['provider API key']);

  await withVault(options => {
    assert.throws(
      () => save(options, { title: 'secret', body: `key sk-${'A'.repeat(24)}` }),
      /suspected secret/,
    );
  });
});

test('format facade validates identifiers and slugs', () => {
  assert.equal(ecc.validateMemoryId('mem_valid_record01'), 'mem_valid_record01');
  assert.throws(() => ecc.validateMemoryId('../outside'), /memory id/);
  assert.equal(ecc.validateSlug('pi-agent', 'harness'), 'pi-agent');
  assert.throws(() => ecc.validateSlug('Not Valid', 'harness'), /lowercase/);
  assert.equal(ecc.asNonEmptyString(' value ', 'label'), 'value');
});

test('scanner reports malformed UTF-8 without exposing source text', async () => {
  await withVault(options => {
    const invalidPath = join(options.roots.project, 'notes', 'mem_invalid_utf8_001.md');
    writeFileSync(invalidPath, Buffer.concat([
      Buffer.from('RAW_INVALID_BODY', 'utf8'),
      Buffer.from([0xff]),
    ]));
    const scan = ecc.readMemoryFiles(options);
    assert.equal(scan.invalidFileCount, 1);
    assert.deepEqual(scan.invalidFiles[0], {
      path: 'project:notes/mem_invalid_utf8_001.md',
      code: 'invalid-document',
      message: 'Memory document is invalid or unreadable.',
    });
    assert.doesNotMatch(JSON.stringify(scan.invalidFiles), /RAW_INVALID_BODY/);
    assert.throws(
      () => ecc.readMemoryById('mem_fixture_missing01', options),
      error => errorCode(error) === 'ECC_MEMORY_INCOMPLETE',
    );
  });
});

test('scanner accepts filename mismatch and rejects scope or kind location mismatch', async () => {
  await withVault(options => {
    const renamedMemory = save(options, { title: 'filename identity', body: 'readable' });
    const savedPath = join(options.roots.project, 'notes', `${renamedMemory.id}.md`);
    const mismatchedPath = join(options.roots.project, 'notes', 'mem_filename_other01.md');
    renameSync(savedPath, mismatchedPath);

    writeDocument(options, makeMemory({
      id: 'mem_scope_mismatch01',
      scope: 'team',
    }));
    writeDocument(options, makeMemory({
      id: 'mem_kind_mismatch01',
      kind: 'fact',
    }), 'note');

    const scan = ecc.readMemoryFiles(options);
    assert.equal(scan.entries.length, 1);
    assert.equal(scan.entries[0]?.memory.id, renamedMemory.id);
    assert.equal(scan.entries[0]?.path, 'project:notes/mem_filename_other01.md');
    assert.equal(scan.invalidFileCount, 2);
    assert.deepEqual(scan.invalidFiles.map(file => file.code).sort(), [
      'location-mismatch', 'location-mismatch',
    ]);
    assert.throws(
      () => ecc.readMemoryById(renamedMemory.id, options),
      error => errorCode(error) === 'ECC_MEMORY_INCOMPLETE',
    );
  });
});

test('lexical ranking uses ECC title, tag, metadata, body, and phrase weights', () => {
  const title = makeMemory({ title: 'alpha', body: 'unrelated' });
  const tag = makeMemory({ title: 'unrelated', body: 'unrelated', tags: ['alpha'] });
  const metadata = makeMemory({
    title: 'unrelated',
    body: 'unrelated',
    kind: 'decision',
  });
  const body = makeMemory({ title: 'unrelated', body: 'alpha '.repeat(9) });
  const bodyPhrase = makeMemory({ title: 'unrelated', body: 'alpha appears here' });
  assert.equal(ecc.scoreMemory(title, 'alpha'), 28);
  assert.equal(ecc.scoreMemory(title, 'alpha missing'), 8);
  assert.equal(ecc.scoreMemory(tag, 'alpha'), 6);
  assert.equal(ecc.scoreMemory(metadata, 'decision missing'), 3);
  assert.equal(ecc.scoreMemory(body, 'alpha missing'), 5);
  assert.equal(ecc.scoreMemory(body, 'alpha'), 10);
  assert.equal(ecc.scoreMemory(bodyPhrase, 'alpha'), 6);
});

test('tokenization handles Unicode and punctuation and scoring counts unique query tokens', () => {
  assert.deepEqual(ecc.tokenize('CAFÉ café 世界! foo-bar foo_bar'), [
    'café', 'café', '世界', 'foo-bar', 'foo_bar',
  ]);
  assert.deepEqual(ecc.tokenize('!!!'), []);
  assert.equal(ecc.scoreMemory(makeMemory({ title: 'café' }), 'café café'), 8);
});

test('search sorts ties by update time and ID and applies kind, trust, and target filters', async () => {
  await withVault(options => {
    save({ ...options, now: () => '2025-02-01T00:00:00.000Z' }, {
      id: 'mem_tie_old001', title: 'needle tie', body: 'old', kind: 'note',
    });
    save({ ...options, now: () => '2025-02-03T00:00:00.000Z' }, {
      id: 'mem_tie_zz001', title: 'needle tie', body: 'newer ID later', kind: 'decision',
    });
    save({ ...options, now: () => '2025-02-03T00:00:00.000Z' }, {
      id: 'mem_tie_aa001', title: 'needle tie', body: 'same time earlier ID', kind: 'decision',
    });
    save({ ...options, now: () => '2025-01-01T00:00:00.000Z' }, {
      id: 'mem_target_other01', title: 'needle tie', body: 'other target',
      kind: 'decision', targetHarnesses: ['claude'],
    });

    const ranked = ecc.searchMemories('needle', { ...options, targetHarness: '' });
    assert.deepEqual(ranked.results.map(result => result.memory.id), [
      'mem_tie_aa001', 'mem_tie_zz001', 'mem_tie_old001', 'mem_target_other01',
    ]);
    const filtered = ecc.searchMemories('needle', {
      ...options,
      kinds: ['decision'],
      trust: 'unreviewed',
      targetHarness: 'pi',
    });
    assert.deepEqual(filtered.results.map(result => result.memory.id), [
      'mem_tie_aa001', 'mem_tie_zz001',
    ]);
    const empty = ecc.searchMemories('', { ...options, targetHarness: '' });
    assert.equal(empty.results.length, 4);
    assert.ok(empty.results.every(result => result.score === 0));
    assert.deepEqual(ecc.searchMemories('!!!', options).results, []);
  });
});

test('search defaults to 20 results and caps results at 100', async () => {
  await withVault(options => {
    for (let index = 0; index < 105; index += 1) {
      save(options, { title: 'capacity', body: 'fixture' });
    }
    assert.equal(ecc.searchMemories('', options).results.length, 20);
    assert.equal(ecc.searchMemories('', { ...options, limit: 1_000 }).results.length, 100);
  });
});

test('search excerpt uses a 240-character slice and both ellipses', async () => {
  await withVault(options => {
    save(options, {
      id: 'mem_excerpt_record01',
      title: 'excerpt check',
      body: `${'a'.repeat(180)}needle ${'b'.repeat(180)}`,
    });
    const excerpt = ecc.searchMemories('needle', options).results[0]?.excerpt;
    assert.ok(excerpt);
    assert.equal(excerpt.length, 242);
    assert.ok(excerpt.startsWith('…'));
    assert.ok(excerpt.endsWith('…'));
  });
});

test('direct read ignores skipped symlinks but reports incomplete invalid files', async () => {
  await withVault(options => {
    const memory = save(options, { title: 'valid read', body: 'readable' });
    const outside = join(tmpdir(), `pi-context-outside-${process.pid}.md`);
    writeFileSync(outside, 'outside');
    try {
      symlinkSync(outside, join(options.roots.project, 'notes', 'linked.md'));
      const scan = ecc.readMemoryFiles(options);
      assert.equal(scan.skippedSymlinkCount, 1);
      assert.equal(ecc.readMemoryById(memory.id, options).memory.id, memory.id);

      writeFileSync(join(options.roots.project, 'notes', 'mem_invalid_doc01.md'), 'not a document');
      const invalidScan = ecc.readMemoryFiles(options);
      assert.equal(invalidScan.invalidFileCount, 1);
      assert.throws(
        () => ecc.readMemoryById(memory.id, options),
        error => errorCode(error) === 'ECC_MEMORY_INCOMPLETE',
      );
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

test('scanner truncates after 5,000 visited entries and direct reads fail closed', async () => {
  await withVault(options => {
    const memory = save(options, { title: 'scan seed', body: 'readable' });
    const notes = join(options.roots.project, 'notes');
    for (let index = 0; index < 5_001; index += 1) {
      writeFileSync(join(notes, `.ignored-${String(index).padStart(5, '0')}`), '');
    }
    const scan = ecc.readMemoryFiles(options);
    assert.equal(scan.truncated, true);
    assert.throws(
      () => ecc.readMemoryById(memory.id, options),
      error => errorCode(error) === 'ECC_MEMORY_INCOMPLETE',
    );
  });
});

test('scanner permits depth 8, truncates below it, and direct reads fail closed', async () => {
  await withVault(options => {
    const memory = save(options, { title: 'depth seed', body: 'readable' });
    const originalPath = join(options.roots.project, 'notes', `${memory.id}.md`);
    let path = join(options.roots.project, 'notes');
    for (let depth = 0; depth < 7; depth += 1) {
      path = join(path, `deep-${depth}`);
      mkdirSync(path);
    }
    renameSync(originalPath, join(path, `${memory.id}.md`));
    mkdirSync(join(path, 'deep-7'));

    const scan = ecc.readMemoryFiles(options);
    assert.equal(scan.entries.length, 1);
    assert.equal(scan.truncated, true);
    assert.throws(
      () => ecc.readMemoryById(memory.id, options),
      error => errorCode(error) === 'ECC_MEMORY_INCOMPLETE',
    );
  });
});

test('scanner enforces the 16 MiB text limit and direct reads fail closed', async () => {
  await withVault(options => {
    const memory = save(options, { title: 'byte seed', body: 'readable' });
    const large = makeMemory({
      id: 'mem_large_template01',
      title: 'large fixture',
      body: 'x'.repeat(60_000),
    });
    const notes = join(options.roots.project, 'notes');
    for (let index = 0; index < 280; index += 1) {
      const current = makeMemory({
        ...large,
        id: `mem_large_${String(index).padStart(5, '0')}`,
      });
      writeFileSync(join(notes, `${current.id}.md`), ecc.serializeMemoryDocument(current));
    }
    const scan = ecc.readMemoryFiles(options);
    assert.equal(scan.truncated, true);
    assert.ok(scan.scannedBytes <= 16 * 1024 * 1024);
    assert.throws(
      () => ecc.readMemoryById(memory.id, options),
      error => errorCode(error) === 'ECC_MEMORY_INCOMPLETE',
    );
  });
});
