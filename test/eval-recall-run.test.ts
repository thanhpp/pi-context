import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CASES, allFacts } from '../scripts/eval-recall/corpus.ts';
import { parseCallsJsonl } from '../scripts/eval-recall/artifacts.ts';
import { ABSTENTION_PHRASES } from '../scripts/eval-recall/score.ts';
import {
  buildAnswerPrompt,
  buildSeedPrompt,
  cleanupActiveIsolations,
  prepareIsolation,
  readOptions,
  removeIsolation,
  runEval,
  type EvalOptions,
} from '../scripts/eval-recall/run.ts';

const fakePiPath = fileURLToPath(new URL('./fixtures/fake-recall-pi.ts', import.meta.url));
const REAL_AUTH_CONTENT = '{"marker":"real-login"}';
const temporaryDirectories: string[] = [];

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
});

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeOptions(runs: number, overrides: Partial<EvalOptions> = {}): Promise<EvalOptions> {
  const tmpRoot = await makeTemporaryDirectory('recall-run-tmproot-');
  const realAgentDir = await makeTemporaryDirectory('recall-run-realagent-');
  const artifactRoot = await makeTemporaryDirectory('recall-run-artifacts-');
  await writeFile(join(realAgentDir, 'auth.json'), REAL_AUTH_CONTENT);
  return {
    runs,
    model: 'fake/model',
    timeoutMs: 30000,
    packageRoot: '/unused',
    realAgentDir,
    tmpRoot,
    artifactRoot,
    scoringVersion: 'answer-v2',
    executable: process.execPath,
    executableArgs: ['--experimental-strip-types', fakePiPath],
    ...overrides,
  };
}

async function assertRealLoginIntact(options: Pick<EvalOptions, 'realAgentDir'>): Promise<void> {
  const authPath = join(options.realAgentDir, 'auth.json');
  assert.equal((await lstat(authPath)).isFile(), true);
  assert.equal(await readFile(authPath, 'utf8'), REAL_AUTH_CONTENT);
  assert.deepEqual(await readdir(options.realAgentDir), ['auth.json']);
}

async function withEnvironment<T>(changes: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface FakeCall {
  kind: 'seed' | 'question';
  arm: 'extension' | 'control';
  id: string;
  agentDir: string;
  cwd: string;
  authLinkTarget: string | null;
}

async function readFakeCalls(directory: string): Promise<FakeCall[]> {
  const text = await readFile(join(directory, 'fake-calls.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as FakeCall);
}

async function readArtifact(directory: string): Promise<{
  manifest: Record<string, unknown>;
  entries: ReturnType<typeof parseCallsJsonl>['entries'];
}> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const parsed = parseCallsJsonl(await readFile(join(directory, 'calls.jsonl'), 'utf8'));
  assert.equal(parsed.invalidLines, 0);
  assert.equal(parsed.incompleteFinalLine, false);
  return { manifest, entries: parsed.entries };
}

const validEnvironment = { PI_CONTEXT_EVAL: '1', PI_EVAL_MODEL: 'openai-codex/some-model' };
const defaults = { packageRoot: '/pkg', realAgentDir: '/agent' };
const messages = {
  gate: 'PI_CONTEXT_EVAL=1 is required because this script makes paid model calls.',
  model: 'PI_EVAL_MODEL is required in provider/id form, for example openai-codex/<model id>.',
  runs: 'EVAL_RUNS must be a positive integer.',
};

test('readOptions rejects a missing gate variable first', () => {
  assert.deepEqual(readOptions({}, defaults), { ok: false, message: messages.gate });
  assert.deepEqual(readOptions({ PI_CONTEXT_EVAL: '0', EVAL_RUNS: 'abc' }, defaults), { ok: false, message: messages.gate });
});

test('readOptions rejects a model that is not in provider/id form', () => {
  assert.deepEqual(readOptions({ PI_CONTEXT_EVAL: '1' }, defaults), { ok: false, message: messages.model });
  for (const model of ['nomodel', 'a/', '/b', 'a b/c']) {
    assert.deepEqual(
      readOptions({ PI_CONTEXT_EVAL: '1', PI_EVAL_MODEL: model, EVAL_RUNS: 'abc' }, defaults),
      { ok: false, message: messages.model },
      model,
    );
  }
});

test('readOptions rejects an invalid run count', () => {
  for (const runs of ['0', 'abc', '-1']) {
    assert.deepEqual(readOptions({ ...validEnvironment, EVAL_RUNS: runs }, defaults), { ok: false, message: messages.runs }, runs);
  }
});

test('readOptions returns defaults and an explicit run count', () => {
  const result = readOptions(validEnvironment, defaults);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.options.runs, 3);
  assert.equal(result.options.model, 'openai-codex/some-model');
  assert.equal(result.options.timeoutMs, 120000);
  assert.equal(result.options.scoringVersion, 'answer-v2');
  assert.equal(result.options.executable, 'pi');
  assert.deepEqual(result.options.executableArgs, []);
  assert.equal(result.options.packageRoot, '/pkg');
  assert.equal(result.options.realAgentDir, '/agent');
  assert.equal(result.options.tmpRoot, tmpdir());
  assert.equal(result.options.artifactRoot, resolve('/pkg', '.benchmarks', 'recall'));
  const five = readOptions({ ...validEnvironment, EVAL_RUNS: '5' }, defaults);
  assert.equal(five.ok && five.options.runs, 5);
  const empty = readOptions({ ...validEnvironment, EVAL_RUNS: '' }, defaults);
  assert.equal(empty.ok && empty.options.runs, 3);
});

test('readOptions supports legacy scoring and rejects unknown scoring versions', () => {
  const legacy = readOptions({ ...validEnvironment, PI_EVAL_SCORING: 'strict-v1' }, defaults);
  assert.equal(legacy.ok && legacy.options.scoringVersion, 'strict-v1');
  for (const invalid of ['', 'unknown']) {
    assert.deepEqual(readOptions({ ...validEnvironment, PI_EVAL_SCORING: invalid }, defaults), {
      ok: false, message: 'PI_EVAL_SCORING must be strict-v1 or answer-v2.',
    });
  }
});

test('readOptions validates and uses an explicit artifact root', () => {
  const artifactRoot = resolve('/tmp/recall artifacts');
  const result = readOptions({ ...validEnvironment, PI_EVAL_ARTIFACT_ROOT: artifactRoot }, defaults);
  assert.equal(result.ok && result.options.artifactRoot, artifactRoot);
  for (const invalid of ['', 'relative/path']) {
    assert.deepEqual(readOptions({ ...validEnvironment, PI_EVAL_ARTIFACT_ROOT: invalid }, defaults), {
      ok: false,
      message: 'PI_EVAL_ARTIFACT_ROOT must be a non-empty absolute path.',
    });
  }
});

test('readOptions accepts an absolute executable path', () => {
  const executable = resolve('/opt/pi bin/pi');
  const result = readOptions({ ...validEnvironment, PI_EVAL_EXECUTABLE: executable }, defaults);
  assert.equal(result.ok && result.options.executable, executable);
});

test('readOptions rejects an empty or relative executable path', () => {
  for (const executable of ['', 'pi', './node_modules/.bin/pi']) {
    assert.deepEqual(readOptions({ ...validEnvironment, PI_EVAL_EXECUTABLE: executable }, defaults), {
      ok: false,
      message: 'PI_EVAL_EXECUTABLE must be an absolute path to the pi executable.',
    });
  }
});

test('prompts have the exact form and seed prompts avoid trigger words', () => {
  assert.equal(buildSeedPrompt('Fact text.'), 'Project update: Fact text. Confirm in one short sentence.');
  assert.equal(
    buildAnswerPrompt('What is X?', 'strict-v1'),
    'Answer from what you know about this project. If you do not know, say "I don\'t know".\n\nQuestion: What is X?',
  );
  const structured = buildAnswerPrompt('What is X?');
  assert.match(structured, /exactly two fields: "answer" and "context"/u);
  assert.match(structured, /set "answer" to null/u);
  assert.match(structured, /another subject or environment/u);
  assert.ok(structured.endsWith('Question: What is X?'));
  const forbiddenWords = /\b(memory|remember|record|tool)\b/i;
  for (const entry of allFacts()) {
    assert.doesNotMatch(buildSeedPrompt(entry.fact.text), forbiddenWords, entry.fact.id);
  }
});

test('prepareIsolation links the login and removeIsolation leaves the link target', async () => {
  const options = await makeOptions(1);
  const isolation = await prepareIsolation(options);
  assert.ok(isolation.root.startsWith(`${options.tmpRoot}/`));
  assert.equal((await stat(join(isolation.workspace, '.git'))).isDirectory(), true);
  const link = join(isolation.agentDir, 'auth.json');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readlink(link), resolve(options.realAgentDir, 'auth.json'));
  assert.equal(await readFile(link, 'utf8'), REAL_AUTH_CONTENT);

  await removeIsolation(isolation);
  await assert.rejects(stat(isolation.root));
  await assertRealLoginIntact(options);
});

test('cleanupActiveIsolations removes roots and leaves the link target', async () => {
  const options = await makeOptions(1);
  const first = await prepareIsolation(options);
  const second = await prepareIsolation(options);
  cleanupActiveIsolations();
  await assert.rejects(stat(first.root));
  await assert.rejects(stat(second.root));
  assert.deepEqual(await readdir(options.tmpRoot), []);
  await assertRealLoginIntact(options);
});

test('runEval seeds then asks in both arms with isolation per run', { timeout: 180_000 }, async () => {
  const options = await makeOptions(2);
  const callsDirectory = await makeTemporaryDirectory('recall-run-calls-');
  const evaluation = await withEnvironment({ FAKE_CALLS_DIR: callsDirectory }, () => runEval(options));
  const { questions, seeds } = evaluation;

  assert.equal(evaluation.artifactDirectory === null, false);
  const artifactDirectory = evaluation.artifactDirectory;
  assert.ok(artifactDirectory);
  assert.ok(!artifactDirectory.startsWith(`${options.tmpRoot}/`));
  const artifact = await readArtifact(artifactDirectory);
  assert.equal(artifact.manifest.status, 'complete');
  assert.equal(artifact.manifest.model, options.model);
  assert.equal(artifact.manifest.runs, 2);
  assert.equal(artifact.manifest.expectedCalls, 164);
  assert.equal(artifact.manifest.scoringVersion, 'answer-v2');
  assert.equal(artifact.manifest.recordAccountingVersion, 2);
  assert.equal(artifact.entries.length, 164);

  assert.equal(seeds.length, 68);
  assert.ok(seeds.every((seed) => seed.recorded && seed.status === 'ok'));
  for (const runIndex of [1, 2]) {
    const ofRun = seeds.filter((seed) => seed.runIndex === runIndex);
    assert.equal(ofRun.filter((seed) => seed.kind === 'question').length, 24);
    assert.equal(ofRun.filter((seed) => seed.kind === 'distractor').length, 10);
  }

  assert.equal(questions.length, 96);
  const extension = questions.filter((outcome) => outcome.arm === 'extension');
  const control = questions.filter((outcome) => outcome.arm === 'control');
  assert.equal(extension.length, 48);
  assert.ok(extension.every((outcome) => outcome.hit && outcome.status === 'ok'));
  assert.equal(control.length, 48);
  assert.equal(control.filter((outcome) => outcome.hit).length, 24);
  for (const outcome of control) {
    assert.equal(outcome.hit, outcome.caseType === 'absent' || outcome.caseType === 'adjacent', outcome.caseId);
  }

  const factById = new Map(allFacts().map((entry) => [entry.fact.id, entry]));
  const questionById = new Map(CASES.map((evalCase) => [evalCase.id, evalCase]));
  const seedEntries = artifact.entries.filter((entry) => entry.metadata.kind === 'seed');
  const questionEntries = artifact.entries.filter((entry) => entry.metadata.kind === 'question');
  assert.equal(seedEntries.length, 68);
  assert.equal(questionEntries.length, 96);
  for (const entry of seedEntries) {
    if (entry.metadata.kind !== 'seed') continue;
    const expected = factById.get(entry.metadata.factId);
    assert.ok(expected);
    assert.equal(entry.metadata.factStage, expected.fact.stage);
    assert.equal(entry.metadata.factText, expected.fact.text);
    assert.equal(entry.metadata.factKind, expected.kind);
    assert.equal(entry.metadata.status, 'ok');
    assert.equal(entry.metadata.recordCalls, 1);
    assert.equal(entry.metadata.recorded, true);
    assert.equal(entry.evidence?.answer, 'Noted.');
    assert.equal(entry.evidence?.process.exitCode, 0);
    assert.equal(entry.evidence?.process.toolCalls[0]?.toolCallId, 'call-1');
    assert.equal(entry.evidence?.process.toolCalls[0]?.completed, true);
  }
  for (const entry of questionEntries) {
    if (entry.metadata.kind !== 'question') continue;
    const metadata = entry.metadata;
    const expected = questionById.get(metadata.caseId);
    assert.ok(expected);
    assert.equal(metadata.question, expected.question);
    assert.equal(metadata.scoringVersion, 'answer-v2');
    assert.equal(metadata.scoreReason, metadata.score ? 'hit' : 'unexpected_abstention');
    assert.equal(metadata.caseType, expected.type);
    assert.deepEqual(metadata.scoringInputs.expectedKeywords, expected.expectedKeywords);
    assert.deepEqual(metadata.scoringInputs.forbiddenKeywords, expected.forbiddenKeywords);
    assert.deepEqual(metadata.scoringInputs.abstentionPhrases, ABSTENTION_PHRASES);
    const outcome = questions.find((candidate) => candidate.runIndex === metadata.runIndex
      && candidate.arm === metadata.arm && candidate.caseId === metadata.caseId);
    assert.equal(metadata.score, outcome?.hit);
    assert.equal(metadata.status, outcome?.status);
    assert.equal(entry.evidence?.process.exitCode, 0);
    if (metadata.arm === 'extension') {
      assert.equal(entry.evidence?.process.toolCalls[0]?.toolCallId, `question-${metadata.caseId}`);
      assert.equal(entry.evidence?.process.toolCalls[0]?.completed, true);
    } else {
      assert.deepEqual(entry.evidence?.process.toolCalls, []);
    }
  }

  const calls = await readFakeCalls(callsDirectory);
  const agentDirs = [...new Set(calls.map((call) => call.agentDir))];
  const workingDirectories = [...new Set(calls.map((call) => call.cwd))];
  assert.equal(agentDirs.length, 2);
  assert.equal(workingDirectories.length, 2);

  const stageOf = new Map(allFacts().map((entry) => [entry.fact.id, entry.fact.stage]));
  for (const agentDir of agentDirs) {
    const ofRun = calls.filter((call) => call.agentDir === agentDir);
    const seedIndexes = ofRun.flatMap((call, index) => (call.kind === 'seed' ? [index] : []));
    const questionIndexes = ofRun.flatMap((call, index) => (call.kind === 'question' ? [index] : []));
    assert.equal(seedIndexes.length, 34);
    assert.ok(Math.max(...seedIndexes) < Math.min(...questionIndexes));
    assert.equal(ofRun.filter((call) => call.kind === 'question' && call.arm === 'extension').length, 24);
    assert.equal(ofRun.filter((call) => call.kind === 'question' && call.arm === 'control').length, 24);
    const seedCalls = ofRun.filter((call) => call.kind === 'seed');
    const firstUpdate = seedCalls.findIndex((call) => stageOf.get(call.id) === 'update');
    const lastBase = seedCalls.map((call) => stageOf.get(call.id)).lastIndexOf('base');
    assert.ok(firstUpdate > lastBase);
  }
  for (const call of calls) assert.equal(call.authLinkTarget, resolve(options.realAgentDir, 'auth.json'));

  assert.deepEqual(await readdir(options.tmpRoot), []);
  await assertRealLoginIntact(options);
});

test('runEval reports a skipped record as recorded false', { timeout: 180_000 }, async () => {
  const options = await makeOptions(1);
  const { questions, seeds } = await withEnvironment(
    { FAKE_RECORD_SKIP_FACT_IDS: 'present-region-fact' },
    () => runEval(options),
  );
  const skipped = seeds.find((seed) => seed.factId === 'present-region-fact');
  assert.equal(skipped?.recorded, false);
  assert.equal(skipped?.status, 'ok');
  for (const seed of seeds.filter((candidate) => candidate.kind === 'question' && candidate.factId !== 'present-region-fact')) {
    assert.equal(seed.recorded, true, seed.factId);
  }
  const asked = questions.find((outcome) => outcome.arm === 'extension' && outcome.caseId === 'present-region');
  assert.equal(asked?.status, 'ok');
  assert.equal(asked?.hit, false);
  for (const outcome of questions.filter((candidate) => (
    candidate.arm === 'extension' && candidate.caseType === 'present' && candidate.caseId !== 'present-region'
  ))) {
    assert.equal(outcome.hit, true, outcome.caseId);
  }
  assert.deepEqual(await readdir(options.tmpRoot), []);
});

test('runEval resolves with failed outcomes and artifacts when the executable is missing', { timeout: 180_000 }, async () => {
  const options = await makeOptions(1, { executable: '/nonexistent/pi-binary', executableArgs: [] });
  const evaluation = await runEval(options);
  const { questions, seeds } = evaluation;
  assert.equal(seeds.length, 34);
  assert.ok(seeds.every((seed) => !seed.recorded && seed.status === 'failed'));
  assert.equal(questions.length, CASES.length * 2);
  assert.ok(questions.every((outcome) => !outcome.hit && outcome.status === 'failed'));
  assert.ok(evaluation.artifactDirectory);
  const artifact = await readArtifact(evaluation.artifactDirectory);
  assert.equal(artifact.manifest.status, 'complete');
  assert.equal(artifact.entries.length, 82);
  assert.ok(artifact.entries.every((entry) => entry.metadata.status === 'failed'));
  assert.deepEqual(await readdir(options.tmpRoot), []);
  await assertRealLoginIntact(options);
});

test('runEval records timeout outcomes and incomplete tool evidence', { timeout: 180_000 }, async () => {
  const options = await makeOptions(1, { timeoutMs: 300 });
  const firstFact = allFacts()[0];
  assert.ok(firstFact);
  const evaluation = await withEnvironment({ FAKE_HANG_FACT_ID: firstFact.fact.id }, () => runEval(options));
  const timedOut = evaluation.seeds.find((seed) => seed.factId === firstFact.fact.id);
  assert.equal(timedOut?.status, 'timeout');
  assert.equal(timedOut?.recorded, false);
  assert.ok(evaluation.artifactDirectory);
  const artifact = await readArtifact(evaluation.artifactDirectory);
  const entry = artifact.entries.find((candidate) => candidate.metadata.kind === 'seed'
    && candidate.metadata.factId === firstFact.fact.id);
  assert.ok(entry?.metadata.kind === 'seed');
  assert.equal(entry.metadata.status, 'timeout');
  assert.equal(entry.metadata.recordCalls, 0);
  assert.equal(entry.evidence?.process.toolCalls[0]?.toolCallId, 'hang-call');
  assert.equal(entry.evidence?.process.toolCalls[0]?.completed, false);
  assert.equal(artifact.entries.length, 82);
  assert.equal(artifact.manifest.status, 'complete');
  assert.deepEqual(await readdir(options.tmpRoot), []);
  await assertRealLoginIntact(options);
});

test('runEval counts a committed record even when the seed call times out', { timeout: 180_000 }, async () => {
  const options = await makeOptions(1, { timeoutMs: 1000 });
  const firstFact = allFacts()[0];
  assert.ok(firstFact);
  const evaluation = await withEnvironment({ FAKE_RECORD_HANG_FACT_ID: firstFact.fact.id }, () => runEval(options));
  const seed = evaluation.seeds.find(candidate => candidate.factId === firstFact.fact.id);
  assert.equal(seed?.status, 'timeout');
  assert.equal(seed?.recorded, true);
  assert.ok(evaluation.artifactDirectory);
  const artifact = await readArtifact(evaluation.artifactDirectory);
  const entry = artifact.entries.find(candidate => candidate.metadata.kind === 'seed' && candidate.metadata.factId === firstFact.fact.id);
  assert.ok(entry?.metadata.kind === 'seed');
  assert.equal(entry.metadata.recordCalls, 1);
  assert.equal(entry.metadata.recorded, true);
  assert.equal(entry.evidence?.process.toolCalls[0]?.completed, true);
  assert.equal(artifact.entries.length, 82);
  assert.deepEqual(await readdir(options.tmpRoot), []);
  await assertRealLoginIntact(options);
});

test('runEval preserves the legacy prompt and scorer in strict-v1 mode', { timeout: 180_000 }, async () => {
  const options = await makeOptions(1, { scoringVersion: 'strict-v1' });
  const evaluation = await runEval(options);
  assert.equal(evaluation.questions.filter(outcome => outcome.arm === 'extension' && outcome.hit).length, 24);
  assert.ok(evaluation.artifactDirectory);
  const artifact = await readArtifact(evaluation.artifactDirectory);
  assert.equal(artifact.manifest.scoringVersion, 'strict-v1');
  for (const entry of artifact.entries) {
    if (entry.metadata.kind !== 'question') continue;
    assert.equal(entry.metadata.scoringVersion, 'strict-v1');
    assert.doesNotMatch(entry.evidence?.answer ?? '', /^\{/u);
  }
});

test('runEval warns when artifact creation fails and continues all fixture calls', { timeout: 180_000 }, async () => {
  const options = await makeOptions(1);
  const blockedRoot = join(options.artifactRoot, 'not-a-directory');
  await writeFile(blockedRoot, 'file blocks directory creation');
  const callsDirectory = await makeTemporaryDirectory('recall-run-blocked-calls-');
  const warnings: string[] = [];
  const evaluation = await withEnvironment({ FAKE_CALLS_DIR: callsDirectory }, () => runEval(
    { ...options, artifactRoot: blockedRoot },
    (line) => warnings.push(line),
  ));
  assert.equal(evaluation.artifactDirectory, null);
  assert.ok(warnings.some((line) => line.startsWith('Artifact writer could not be created:')));
  assert.equal(evaluation.seeds.length, 34);
  assert.equal(evaluation.questions.length, CASES.length * 2);
  assert.equal((await readFakeCalls(callsDirectory)).length, 82);
  assert.deepEqual(await readdir(options.tmpRoot), []);
  await assertRealLoginIntact(options);
});

test('runEval marks artifacts incomplete and preserves an evaluation error', async () => {
  const options = await makeOptions(1, { tmpRoot: join(await makeTemporaryDirectory('missing-tmp-parent-'), 'missing') });
  await assert.rejects(runEval(options), { code: 'ENOENT' });
  const artifactDirectories = await readdir(options.artifactRoot);
  assert.equal(artifactDirectories.length, 1);
  const artifact = await readArtifact(join(options.artifactRoot, artifactDirectories[0] ?? ''));
  assert.equal(artifact.manifest.status, 'incomplete');
  assert.equal(typeof artifact.manifest.completedAt, 'string');
  assert.equal(artifact.entries.length, 0);
});
