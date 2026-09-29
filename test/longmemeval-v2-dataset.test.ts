import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DATASET_REVISION,
  MAX_RENDERED_CHUNK_BYTES,
  PINNED_SOURCE_HASHES,
  loadDataset,
  renderTrajectory,
  selectCases,
  type BenchmarkDataset,
  type DatasetSourceHashes,
} from '../scripts/longmemeval-v2/dataset.ts';
import { loadPilotManifest, selectPilotCases } from '../scripts/longmemeval-v2/select-pilot.ts';

interface FixtureQuestion {
  id: string;
  domain: 'web' | 'enterprise';
  question_type: string;
  question: string;
  image: string | null;
  answer: string;
  eval_function: string;
}

interface FixtureTrajectory {
  id: string;
  domain: 'web' | 'enterprise';
  states: Array<{
    state_index: number;
    action: string | null;
    accessibility_tree: string;
    thought: string;
    screenshot: string;
  }>;
}

interface FixtureData {
  questions: FixtureQuestion[];
  trajectories: FixtureTrajectory[];
  haystacks: Record<string, string[]>;
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeQuestion(
  id: string,
  domain: 'web' | 'enterprise',
  type: string,
  image: string | null = null,
): FixtureQuestion {
  return {
    id,
    domain,
    question_type: type,
    question: `Question text for ${id}`,
    image,
    answer: `GOLD-ANSWER-${id}`,
    eval_function: `SECRET-EVALUATOR-${id}`,
  };
}

function makeFixtureData(): FixtureData {
  const questions = [
    makeQuestion('q-static-web-z', 'web', 'static-environment'),
    makeQuestion('q-static-web-a', 'web', 'static-environment'),
    makeQuestion('q-static-enterprise', 'enterprise', 'static-environment'),
    makeQuestion('q-dynamic-enterprise-z', 'enterprise', 'dynamic-environment'),
    makeQuestion('q-dynamic-enterprise-a', 'enterprise', 'dynamic-environment'),
    makeQuestion('q-dynamic-web', 'web', 'dynamic-environment'),
    makeQuestion('q-procedure-web-z', 'web', 'procedure'),
    makeQuestion('q-procedure-web-a', 'web', 'procedure'),
    makeQuestion('q-procedure-enterprise', 'enterprise', 'procedure'),
    makeQuestion('q-abs-web-z', 'web', 'procedure-abs'),
    makeQuestion('q-abs-web-a', 'web', 'dynamic-environment-abs'),
    makeQuestion('q-abs-enterprise', 'enterprise', 'static-environment-abs'),
    makeQuestion('q-image-gotcha', 'web', 'errors-gotchas', 'question_screenshots/private.png'),
  ];
  const trajectories: FixtureTrajectory[] = [];
  for (const domain of ['web', 'enterprise'] as const) {
    for (let index = 0; index < 100; index += 1) {
      const id = `${domain}-t-${String(index).padStart(3, '0')}`;
      trajectories.push({
        id,
        domain,
        states: [
          {
            state_index: 0,
            action: null,
            accessibility_tree: `tree for ${id}, initial`,
            thought: 'private thought must not render',
            screenshot: `private/screenshots/${id}.png`,
          },
          {
            state_index: 1,
            action: `click ${id}`,
            accessibility_tree: `tree for ${id}, final`,
            thought: 'another private thought',
            screenshot: `private/screenshots/${id}-final.png`,
          },
        ],
      });
    }
  }
  const haystacks: Record<string, string[]> = {};
  for (const question of questions) {
    const ids = trajectories.filter(trajectory => trajectory.domain === question.domain).map(row => row.id);
    haystacks[question.id] = [...ids].reverse();
  }
  return { questions, trajectories, haystacks };
}

function sourceTexts(data: FixtureData): { questions: string; trajectories: string; haystack: string } {
  return {
    questions: `${data.questions.map(row => JSON.stringify(row)).join('\n')}\n`,
    trajectories: `${data.trajectories.map(row => JSON.stringify(row)).join('\n')}\n`,
    haystack: `${JSON.stringify(data.haystacks, null, 2)}\n`,
  };
}

async function writeFixture(root: string, data: FixtureData): Promise<DatasetSourceHashes> {
  const texts = sourceTexts(data);
  await mkdir(join(root, 'haystacks'), { recursive: true });
  await writeFile(join(root, 'questions.jsonl'), texts.questions);
  await writeFile(join(root, 'trajectories.jsonl'), texts.trajectories);
  await writeFile(join(root, 'haystacks/lme_v2_small.json'), texts.haystack);
  const hashes: DatasetSourceHashes = {
    'questions.jsonl': hash(texts.questions),
    'trajectories.jsonl': hash(texts.trajectories),
    'haystacks/lme_v2_small.json': hash(texts.haystack),
  };
  await writeFile(join(root, 'checksums.sha256'), [
    `${hashes['questions.jsonl']}  questions.jsonl`,
    `${hashes['trajectories.jsonl']}  trajectories.jsonl`,
    `${hashes['haystacks/lme_v2_small.json']}  haystacks/lme_v2_small.json`,
    '',
  ].join('\n'));
  return hashes;
}

async function withFixture(run: (root: string, data: FixtureData) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lme-v2-test-'));
  try {
    await run(root, makeFixtureData());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadFixture(root: string, data: FixtureData): Promise<BenchmarkDataset> {
  const expectedHashes = await writeFixture(root, data);
  return loadDataset(root, { expectedHashes });
}

test('loader reports missing source files', async () => {
  await withFixture(async (root, data) => {
    const hashes = await writeFixture(root, data);
    await rm(join(root, 'trajectories.jsonl'));
    await assert.rejects(
      loadDataset(root, { expectedHashes: hashes }),
      /MISSING_DATA_FILE: trajectories\.jsonl/u,
    );
  });
});

test('loader rejects changed source hashes', async () => {
  await withFixture(async (root, data) => {
    const hashes = await writeFixture(root, data);
    await writeFile(join(root, 'questions.jsonl'), 'changed source\n');
    await assert.rejects(
      loadDataset(root, { expectedHashes: hashes }),
      /DATA_HASH_MISMATCH: questions\.jsonl/u,
    );
  });
});

test('loader rejects duplicate question and trajectory IDs', async () => {
  await withFixture(async root => {
    const questionDuplicate = makeFixtureData();
    questionDuplicate.questions.push({ ...questionDuplicate.questions[0]! });
    const questionHashes = await writeFixture(root, questionDuplicate);
    await assert.rejects(loadDataset(root, { expectedHashes: questionHashes }), /DUPLICATE_QUESTION_ID/u);

    const trajectoryDuplicate = makeFixtureData();
    trajectoryDuplicate.trajectories.push({ ...trajectoryDuplicate.trajectories[0]! });
    const expectedHashes = await writeFixture(root, trajectoryDuplicate);
    await assert.rejects(loadDataset(root, { expectedHashes }), /DUPLICATE_TRAJECTORY_ID/u);
  });
});

test('loader rejects duplicate haystack references and cross-domain references', async () => {
  await withFixture(async root => {
    const duplicateReference = makeFixtureData();
    const firstQuestion = duplicateReference.questions[0]!;
    const firstIds = duplicateReference.haystacks[firstQuestion.id]!;
    firstIds[1] = firstIds[0]!;
    let expectedHashes = await writeFixture(root, duplicateReference);
    await assert.rejects(loadDataset(root, { expectedHashes }), /DUPLICATE_HAYSTACK_TRAJECTORY_ID/u);

    const crossDomain = makeFixtureData();
    const webQuestion = crossDomain.questions.find(row => row.domain === 'web')!;
    crossDomain.haystacks[webQuestion.id]![0] = 'enterprise-t-000';
    expectedHashes = await writeFixture(root, crossDomain);
    await assert.rejects(loadDataset(root, { expectedHashes }), /CROSS_DOMAIN_HAYSTACK/u);
  });
});

test('loader excludes image questions and preserves each ordered small history', async () => {
  await withFixture(async (root, data) => {
    const dataset = await loadFixture(root, data);
    assert.equal(dataset.questionCount, 13);
    assert.equal(dataset.questions.length, 12);
    assert.deepEqual(dataset.excludedImageQuestionIds, ['q-image-gotcha']);
    assert.equal(dataset.questions.some(question => question.id === 'q-image-gotcha'), false);
    assert.equal(dataset.questions.some(question => question.domain === 'web'), true);
    assert.equal(dataset.questions.some(question => question.domain === 'enterprise'), true);
    assert.deepEqual(
      dataset.haystacks.get('q-static-web-a'),
      [...data.haystacks['q-static-web-a']!],
    );
    assert.equal(dataset.haystacks.get('q-static-web-a')?.length, 100);
  });
});

test('pilot selection is deterministic, diverse, and uses the four text-only groups', async () => {
  await withFixture(async (root, data) => {
    const dataset = await loadFixture(root, data);
    const first = selectPilotCases(dataset);
    const second = selectPilotCases(dataset);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [
      { id: 'q-static-web-a', domain: 'web', questionType: 'static-environment' },
      { id: 'q-dynamic-enterprise-a', domain: 'enterprise', questionType: 'dynamic-environment' },
      { id: 'q-procedure-web-a', domain: 'web', questionType: 'procedure' },
      { id: 'q-abs-web-a', domain: 'web', questionType: 'dynamic-environment-abs' },
    ]);
    assert.equal(first.some(question => question.questionType === 'errors-gotchas'), false);
    assert.deepEqual(
      selectCases(dataset, 'pilot', first.map(question => question.id)).map(question => question.id),
      first.map(question => question.id),
    );
    assert.deepEqual(
      selectCases(dataset, 'full', []).map(question => question.id),
      [...dataset.questions.map(question => question.id)].sort(),
    );
  });
});

test('manifest loader rejects source hashes that do not match the dataset', async () => {
  await withFixture(async (root, data) => {
    const dataset = await loadFixture(root, data);
    const manifestDataset = {
      ...dataset,
      datasetRevision: DATASET_REVISION,
      sourceHashes: PINNED_SOURCE_HASHES,
    };
    const manifest = {
      datasetRevision: DATASET_REVISION,
      sourceHashes: { ...dataset.sourceHashes, 'questions.jsonl': '0'.repeat(64) },
      cases: selectPilotCases(manifestDataset),
    };
    const manifestPath = join(root, 'pilot.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadPilotManifest(manifestPath, manifestDataset), /PILOT_MANIFEST_HASH_MISMATCH/u);
  });
});

test('trajectory rendering keeps state and action order without thoughts or screenshots', async () => {
  await withFixture(async (root, data) => {
    const dataset = await loadFixture(root, data);
    const trajectory = dataset.trajectories.get('web-t-000');
    assert.ok(trajectory);
    const chunks = renderTrajectory(trajectory);
    const rendered = chunks.join('\n');
    const firstAction = rendered.indexOf('State 0 action:');
    const firstTree = rendered.indexOf('State 0 accessibility tree:');
    const secondAction = rendered.indexOf('State 1 action:');
    const secondTree = rendered.indexOf('State 1 accessibility tree:');
    assert.ok(firstAction >= 0 && firstAction < firstTree && firstTree < secondAction && secondAction < secondTree);
    assert.match(rendered, /click web-t-000/u);
    assert.doesNotMatch(rendered, /private thought|private\/screenshots/u);
    assert.equal(Object.hasOwn(trajectory.states[0]!, 'thought'), false);
    assert.equal(Object.hasOwn(trajectory.states[0]!, 'screenshot'), false);
    const question = dataset.questions.find(row => row.id === 'q-static-web-a')!;
    assert.equal(Object.hasOwn(question, 'answer'), false);
    assert.equal(Object.hasOwn(question, 'eval_function'), false);
    assert.doesNotMatch(JSON.stringify(question), /GOLD-ANSWER|SECRET-EVALUATOR/u);
  });
});

test('rendering splits large observations at UTF-8 boundaries without data loss', () => {
  const observation = 'A💖'.repeat(12_000);
  const chunks = renderTrajectory({
    id: 'large-observation',
    domain: 'web',
    states: [{ stateIndex: 7, action: 'inspect', accessibilityTree: observation }],
  });
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= MAX_RENDERED_CHUNK_BYTES));
  const treePieces = chunks
    .filter(chunk => chunk.startsWith('State 7 accessibility tree'))
    .map(chunk => chunk.slice(chunk.indexOf('\n') + 1));
  assert.equal(treePieces.join(''), observation);
  assert.equal(treePieces.some(piece => piece.includes('\ufffd')), false);
});

test('loader excludes gold fields from returned cases', async () => {
  await withFixture(async (root, data) => {
    const dataset = await loadFixture(root, data);
    const result = JSON.stringify({ questions: dataset.questions, trajectories: [...dataset.trajectories.values()] });
    assert.doesNotMatch(result, /GOLD-ANSWER|SECRET-EVALUATOR|private\/screenshots|private thought/u);
    assert.ok(await readFile(join(root, 'questions.jsonl'), 'utf8'));
  });
});
