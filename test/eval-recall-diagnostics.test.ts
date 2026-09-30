import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCallsJsonl, type QuestionCallMetadata, type StoredCallEntry } from '../scripts/eval-recall/artifacts.ts';
import { analyzeCalls } from '../scripts/eval-recall/diagnostics.ts';

const entryPath = fileURLToPath(new URL('../scripts/inspect-recall.ts', import.meta.url));
const processEvidence = {
  exitCode: 0, signal: null, stdoutBytes: 1, stdoutLimited: false, malformedOutput: false,
  partialFinalLine: false, spawnErrorCode: null, toolCalls: [],
};
const metadata: QuestionCallMetadata = {
  kind: 'question', runIndex: 1, arm: 'extension', caseId: 'deploy', caseType: 'superseded',
  question: 'Which deployment tool?', status: 'ok', score: false,
  scoringInputs: { expectedKeywords: ['flux'], forbiddenKeywords: ['argo'], abstentionPhrases: ['unknown'] },
};
const question = (answer: string, overrides: Partial<QuestionCallMetadata> = {}): StoredCallEntry => ({
  metadata: { ...metadata, ...overrides }, evidenceOmitted: false,
  evidence: { answer, process: processEvidence },
});

function timedOutSeed(): StoredCallEntry {
  return {
    metadata: {
      kind: 'seed', runIndex: 1, factId: 'seed', factKind: 'question', factStage: 'base',
      factText: 'Synthetic fact.', status: 'timeout', recorded: false, recordCalls: 0,
    },
    evidenceOmitted: false,
    evidence: {
      answer: '',
      process: {
        ...processEvidence,
        toolCalls: [
          { toolCallId: 'failed', args: { action: 'record' }, completed: true,
            result: { details: { ok: false, action: 'record', code: 'MEMORY_INVALID_INPUT' } } },
          { toolCallId: 'committed', args: { action: 'record' }, completed: true,
            result: { details: { ok: true, action: 'record', data: { state: 'committed_with_maintenance' } } } },
        ],
      },
    },
  };
}

test('offline diagnostics count commits independently from legacy timeout metadata', () => {
  const diagnostics = analyzeCalls([timedOutSeed()]);
  assert.deepEqual(diagnostics.seeds, {
    attempted: 1, reportedRecorded: 0, observedRecorded: 1, commitsBeforeUnsuccessfulExit: 1,
  });
  assert.deepEqual(diagnostics.toolErrors, { MEMORY_INVALID_INPUT: 1 });
});

test('offline replay uses the recorded score version and inputs without upgrading legacy prose', () => {
  const diagnostics = analyzeCalls([
    question('Flux now, Argo before.'),
    question(JSON.stringify({ answer: 'Flux', context: 'Argo before.' }), { scoringVersion: 'answer-v2', score: true }),
    question('unknown', { caseType: 'absent', score: true }),
    question("I don't know.", { caseType: 'absent' }),
    question('Flux', { status: 'timeout' }),
    question('Flux'),
  ]);
  assert.deepEqual(diagnostics.questions, {
    attempted: 6, reportedHits: 2, replayedHits: 3, replayed: 6, scoreMismatches: 1,
  });
  assert.deepEqual(diagnostics.rejections, { forbidden_keyword: 1, missing_abstention: 1, call_not_ok: 1 });
});

test('offline diagnostics report missing evidence instead of counting it as a miss', () => {
  const entry: StoredCallEntry = { metadata: { ...metadata, score: true }, evidenceOmitted: true };
  const diagnostics = analyzeCalls([entry]);
  assert.equal(diagnostics.missingEvidence, 1);
  assert.equal(diagnostics.questions.reportedHits, 1);
  assert.equal(diagnostics.questions.replayed, 0);
  assert.equal(diagnostics.questions.scoreMismatches, 0);
});

test('artifact parser accepts additive scoring fields and rejects unknown versions', () => {
  const entry = question('{"answer":"Flux","context":""}', { scoringVersion: 'answer-v2', scoreReason: 'hit', score: true });
  const serialize = (value: unknown) => `${JSON.stringify(value)}\n`;
  assert.deepEqual(parseCallsJsonl(serialize(entry)).entries, [entry]);
  const invalid = { ...entry, metadata: { ...entry.metadata, scoringVersion: 'future' } };
  assert.equal(parseCallsJsonl(serialize(invalid)).invalidLines, 1);
});

test('inspect entry reads artifacts without credentials, preserves files, and reports a partial final line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recall-inspect-'));
  try {
    const manifest = JSON.stringify({ schemaVersion: 1, model: 'fake/model', runs: 1, status: 'complete' });
    const calls = `${JSON.stringify(timedOutSeed())}\n${JSON.stringify(question('Flux now, Argo before.'))}\n{partial`;
    await writeFile(join(root, 'manifest.json'), manifest);
    await writeFile(join(root, 'calls.jsonl'), calls);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', entryPath, root], {
      encoding: 'utf8', timeout: 10_000, env: {},
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.scan, { invalidLines: 0, incompleteFinalLine: true });
    assert.equal(report.diagnostics.seeds.commitsBeforeUnsuccessfulExit, 1);
    assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), manifest);
    assert.equal(await readFile(join(root, 'calls.jsonl'), 'utf8'), calls);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspect entry rejects missing arguments without model calls', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', entryPath], {
    encoding: 'utf8', timeout: 10_000, env: {},
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run eval:inspect/u);
});
