import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createArtifactWriter,
  parseCallsJsonl,
  type CallEntry,
  type SeedCallMetadata,
} from '../scripts/eval-recall/artifacts.ts';

const MAX_CALL_LINE_BYTES = 16 * 1024 * 1024;

const metadata: SeedCallMetadata = {
  kind: 'seed',
  runIndex: 1,
  factId: 'fact-1',
  factStage: 'base',
  factText: 'Halyard stores data in SQLite.',
  factKind: 'question',
  status: 'ok',
  recorded: true,
  recordCalls: 1,
};

const processEvidence: CallEntry['evidence']['process'] = {
  exitCode: 0,
  signal: null,
  stdoutBytes: 15,
  stdoutLimited: false,
  malformedOutput: false,
  partialFinalLine: false,
  spawnErrorCode: null,
  toolCalls: [{
    toolCallId: 'call-1',
    args: { action: 'record' },
    result: { details: { ok: true } },
    isError: false,
    completed: true,
  }],
};

function callEntry(overrides: Partial<CallEntry> = {}): CallEntry {
  return {
    metadata,
    evidence: { answer: 'Recorded.', process: processEvidence },
    ...overrides,
  };
}

async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'eval-recall-artifacts-'));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function manifestAt(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
}

test('createArtifactWriter creates separate UUID folders and writes calls and manifest states', async () => {
  await withRoot(async (root) => {
    const first = await createArtifactWriter(root, { model: 'provider/model', runs: 2, expectedCalls: 4 });
    const firstInitial = await manifestAt(first.directory);
    assert.equal(firstInitial.status, 'running');
    assert.match(String(firstInitial.id), /^[0-9a-f-]{36}$/);
    assert.equal((await readFile(join(first.directory, 'calls.jsonl'), 'utf8')), '');

    const appended = await first.appendCall(callEntry());
    assert.deepEqual(appended, { appended: true, evidenceOmitted: false });
    await first.finish('complete');
    const firstManifest = await manifestAt(first.directory);
    assert.equal(firstManifest.status, 'complete');
    assert.equal(firstManifest.model, 'provider/model');
    assert.equal(typeof firstManifest.completedAt, 'string');

    const second = await createArtifactWriter(root, { model: 'other/model', runs: 1, expectedCalls: 1 });
    assert.notEqual(second.directory, first.directory);
    assert.match(second.directory.split('/').at(-1) ?? '', /^[0-9a-f-]{36}$/);
    await second.finish('incomplete');
    assert.equal((await manifestAt(second.directory)).status, 'incomplete');

    for (const directory of [first.directory, second.directory]) {
      assert.deepEqual((await readdir(directory)).sort(), ['calls.jsonl', 'manifest.json']);
    }
    const callLog = await readFile(join(first.directory, 'calls.jsonl'), 'utf8');
    const parsed = parseCallsJsonl(callLog);
    assert.equal(parsed.invalidLines, 0);
    assert.equal(parsed.incompleteFinalLine, false);
    assert.equal(parsed.entries.length, 1);
    assert.deepEqual(parsed.entries[0]?.metadata, metadata);
    assert.equal(parsed.entries[0]?.evidenceOmitted, false);
    assert.deepEqual(parsed.entries[0]?.evidence, callEntry().evidence);
  });
});

test('appendCall accepts a line of exactly 16 MiB and omits oversized evidence', async () => {
  await withRoot(async (root) => {
    const exactWriter = await createArtifactWriter(root, { model: 'model', runs: 1, expectedCalls: 1 });
    const base = callEntry({ evidence: { answer: '', process: processEvidence } });
    const baseLine = `${JSON.stringify({ metadata: base.metadata, evidence: base.evidence, evidenceOmitted: false })}\n`;
    const answerBytes = MAX_CALL_LINE_BYTES - Buffer.byteLength(baseLine, 'utf8');
    assert.ok(answerBytes > 0);
    const exactEntry = callEntry({ evidence: { answer: 'x'.repeat(answerBytes), process: processEvidence } });
    const exactLine = `${JSON.stringify({ metadata: exactEntry.metadata, evidence: exactEntry.evidence, evidenceOmitted: false })}\n`;
    assert.equal(Buffer.byteLength(exactLine, 'utf8'), MAX_CALL_LINE_BYTES);
    const exactResult = await exactWriter.appendCall(exactEntry);
    assert.deepEqual(exactResult, { appended: true, evidenceOmitted: false });
    assert.equal(Buffer.byteLength(await readFile(join(exactWriter.directory, 'calls.jsonl')), 'utf8'), MAX_CALL_LINE_BYTES);
    await exactWriter.finish('complete');

    const omissionWriter = await createArtifactWriter(root, { model: 'model', runs: 1, expectedCalls: 1 });
    const oversized = callEntry({ evidence: { answer: 'y'.repeat(MAX_CALL_LINE_BYTES), process: processEvidence } });
    const omittedResult = await omissionWriter.appendCall(oversized);
    assert.equal(omittedResult.appended, true);
    assert.equal(omittedResult.evidenceOmitted, true);
    assert.match(omittedResult.warning ?? '', /evidence was omitted/i);
    const omittedLine = await readFile(join(omissionWriter.directory, 'calls.jsonl'), 'utf8');
    assert.ok(Buffer.byteLength(omittedLine, 'utf8') <= MAX_CALL_LINE_BYTES);
    const stored = parseCallsJsonl(omittedLine).entries[0];
    assert.deepEqual(stored?.metadata, metadata);
    assert.equal(stored?.evidenceOmitted, true);
    assert.equal(stored?.evidence, undefined);
    await omissionWriter.finish('complete');

    const metadataWriter = await createArtifactWriter(root, { model: 'model', runs: 1, expectedCalls: 1 });
    const tooLargeMetadata = {
      ...metadata,
      factText: 'z'.repeat(MAX_CALL_LINE_BYTES),
    };
    const noWrite = await metadataWriter.appendCall(callEntry({ metadata: tooLargeMetadata }));
    assert.equal(noWrite.appended, false);
    assert.equal(noWrite.evidenceOmitted, true);
    assert.match(noWrite.warning ?? '', /metadata exceeded/i);
    assert.equal(await readFile(join(metadataWriter.directory, 'calls.jsonl'), 'utf8'), '');
    await metadataWriter.finish('incomplete');
  });
});

test('append failure disables later appends and finish writes a write_failed manifest', async () => {
  await withRoot(async (root) => {
    const writer = await createArtifactWriter(root, { model: 'model', runs: 1, expectedCalls: 2 });
    const callsPath = join(writer.directory, 'calls.jsonl');
    await unlink(callsPath);
    await mkdir(callsPath);

    const first = await writer.appendCall(callEntry());
    assert.equal(first.appended, false);
    assert.match(first.warning ?? '', /append failed/i);
    const later = await writer.appendCall(callEntry());
    assert.equal(later.appended, false);
    assert.equal(later.warning, undefined);

    await writer.finish('complete');
    const manifest = await manifestAt(writer.directory);
    assert.equal(manifest.status, 'write_failed');
    assert.equal(typeof manifest.completedAt, 'string');
    assert.equal((await stat(callsPath)).isDirectory(), true);
  });
});

test('parseCallsJsonl accepts CRLF, rejects malformed lines, and excludes an incomplete JSON fragment', () => {
  const valid = JSON.stringify({ metadata, evidence: callEntry().evidence, evidenceOmitted: false });
  const parsed = parseCallsJsonl(`${valid}\r\n{invalid-json}\r\n${valid}\n${valid}`);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.invalidLines, 1);
  assert.equal(parsed.incompleteFinalLine, true);
  assert.deepEqual(parseCallsJsonl(''), { entries: [], invalidLines: 0, incompleteFinalLine: false });
  assert.deepEqual(parseCallsJsonl(`${JSON.stringify({ metadata, evidenceOmitted: 'yes' })}\n`), {
    entries: [],
    invalidLines: 1,
    incompleteFinalLine: false,
  });
});
