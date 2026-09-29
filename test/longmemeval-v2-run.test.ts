import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  PINNED_SOURCE_HASHES,
  type DatasetSourceHashes,
} from '../scripts/longmemeval-v2/dataset.ts';
import {
  runBenchmark,
  type RunOptions,
  type RunReport,
} from '../scripts/longmemeval-v2/run.ts';

const EXPECTED_UPSTREAM = '2cc8c540bdb87fe6761629b585e727e1c4704520';
const MODEL = 'openai-codex/gpt-6-luna';
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

interface SyntheticQuestion {
  id: string;
  domain: 'web' | 'enterprise';
  question_type: string;
  question: string;
  image: string | null;
  answer: string;
  eval_function: string;
}

interface SyntheticData {
  questions: SyntheticQuestion[];
  trajectories: Array<{
    id: string;
    domain: 'web' | 'enterprise';
    states: Array<{
      state_index: number;
      action: string | null;
      accessibility_tree: string;
      thought: string;
      screenshot: string;
    }>;
  }>;
  haystacks: Record<string, string[]>;
}

interface Fixture {
  root: string;
  dataRoot: string;
  upstreamRoot: string;
  outputRoot: string;
  authPath: string;
  callsPath: string;
  gradesPath: string;
  piPath: string;
  graderPath: string;
  data: SyntheticData;
  hashes: DatasetSourceHashes;
  reportPaths: string[];
  options(overrides?: Partial<RunOptions>): RunOptions;
  run(options?: RunOptions): Promise<RunReport>;
  calls(): Promise<Array<{ cwd: string; args: string[]; prompt: string; agentDir: string | null }>>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeData(): SyntheticData {
  const questions: SyntheticQuestion[] = [
    {
      id: 'web-case', domain: 'web', question_type: 'procedure',
      question: 'Which web action happened first?', image: null,
      answer: 'GOLD_WEB_ANSWER', eval_function: 'exact_match',
    },
    {
      id: 'enterprise-case', domain: 'enterprise', question_type: 'dynamic-environment-abs',
      question: 'What was the enterprise setting?', image: null,
      answer: 'GOLD_ENTERPRISE_ANSWER', eval_function: 'llm_abstention_checker',
    },
    {
      id: 'image-case', domain: 'web', question_type: 'errors-gotchas',
      question: 'This image question is excluded.', image: 'question_screenshots/private.png',
      answer: 'GOLD_IMAGE_ANSWER', eval_function: 'llm_gotchas_checker',
    },
  ];
  const trajectories: SyntheticData['trajectories'] = [];
  const webIds: string[] = [];
  const enterpriseIds: string[] = [];
  for (const domain of ['web', 'enterprise'] as const) {
    for (let index = 0; index < 100; index += 1) {
      const id = `${domain}-trajectory-${String(index).padStart(3, '0')}`;
      (domain === 'web' ? webIds : enterpriseIds).push(id);
      trajectories.push({
        id,
        domain,
        states: [{
          state_index: 0,
          action: `action ${domain} ${String(index).padStart(3, '0')}`,
          accessibility_tree: `${domain} observation ${String(index).padStart(3, '0')}`,
          thought: 'PRIVATE_THOUGHT',
          screenshot: 'private/screenshots/item.png',
        }],
      });
    }
  }
  return {
    questions,
    trajectories,
    haystacks: {
      'web-case': webIds,
      'enterprise-case': enterpriseIds,
      'image-case': webIds,
    },
  };
}

async function writeDataset(root: string, data: SyntheticData): Promise<DatasetSourceHashes> {
  await mkdir(join(root, 'haystacks'), { recursive: true });
  const questionText = `${data.questions.map(row => JSON.stringify(row)).join('\n')}\n`;
  const trajectoryText = `${data.trajectories.map(row => JSON.stringify(row)).join('\n')}\n`;
  const haystackText = `${JSON.stringify(data.haystacks, null, 2)}\n`;
  const hashes: DatasetSourceHashes = {
    'questions.jsonl': sha256(questionText),
    'trajectories.jsonl': sha256(trajectoryText),
    'haystacks/lme_v2_small.json': sha256(haystackText),
  };
  await writeFile(join(root, 'questions.jsonl'), questionText);
  await writeFile(join(root, 'trajectories.jsonl'), trajectoryText);
  await writeFile(join(root, 'haystacks/lme_v2_small.json'), haystackText);
  await writeFile(join(root, 'checksums.sha256'), [
    `${hashes['questions.jsonl']}  questions.jsonl`,
    `${hashes['trajectories.jsonl']}  trajectories.jsonl`,
    `${hashes['haystacks/lme_v2_small.json']}  haystacks/lme_v2_small.json`,
    '',
  ].join('\n'));
  return hashes;
}

const FAKE_PI_SOURCE = `
import { appendFileSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--list-models')) {
  writeSync(1, process.env.LME_FAKE_MODEL_LIST ?? 'provider model context max-out thinking images\\nopenai-codex gpt-6-luna 1.1M 128K yes yes\\nopenai-codex gpt-6-sol 1.1M 128K yes yes\\n');
  process.exit(0);
}
const value = flag => args[args.indexOf(flag) + 1];
const prompt = value('-p') ?? '';
const callsPath = process.env.LME_FAKE_CALLS;
if (args.includes('--system-prompt')) {
  if (callsPath) appendFileSync(callsPath, JSON.stringify({ cwd: process.cwd(), args, prompt, agentDir: process.env.PI_CODING_AGENT_DIR ?? null }) + '\\n');
  const failure = process.env.LME_FAKE_JUDGE_FAILURE ?? '';
  const events = failure === 'auth'
    ? [{ type: 'provider_error', message: 'authentication unauthorized' }]
    : [
      { type: 'message_end', message: {
        id: 'assistant-judge', role: 'assistant', provider: 'openai-codex', model: 'gpt-6-sol',
        responseModel: 'gpt-6-sol', stopReason: 'stop',
        content: [{ type: 'text', text: failure === 'invalid-output' ? 'not a binary decision' : '{"label":1,"reason":"synthetic"}' }],
      } },
      { type: 'agent_settled' },
    ];
  for (const event of events) writeSync(1, JSON.stringify(event) + '\\n');
  process.exit(failure === 'auth' ? 1 : 0);
}
const session = value('--session');
const model = value('--model') ?? 'gpt-6-luna';
const mode = args.includes('--tools') ? 'memory' : 'control';
if (callsPath) appendFileSync(callsPath, JSON.stringify({ cwd: process.cwd(), args, prompt, agentDir: process.env.PI_CODING_AGENT_DIR ?? null }) + '\\n');
writeFileSync(session, 'fake-session\\n', { mode: 0o600 });
const history = prompt.startsWith('Store this ordered history');
const failure = process.env.LME_FAKE_PI_FAILURE ?? '';
if (failure === 'malformed' && history) {
  writeSync(1, '{bad-json}\\n');
  process.exit(0);
}
const events = [{ type: 'session', id: basename(session) }];
if (mode === 'memory') {
  const action = history ? 'record' : 'search';
  const quotaFailure = failure === 'quota' && history;
  const projectId = createHash('sha256').update('git\\0' + join(process.cwd(), '.git'), 'utf8').digest('hex');
  const details = quotaFailure
    ? { ok: false, action, code: 'QUOTA_EXCEEDED', projectId }
    : { ok: true, action, projectId, data: { results: [] } };
  events.push(
    { type: 'tool_execution_start', toolCallId: 'memory-call', toolName: 'pi_context', args: { action } },
    { type: 'tool_execution_end', toolCallId: 'memory-call', toolName: 'pi_context', result: { isError: quotaFailure, details } },
  );
}
const actualModel = failure === 'model-mismatch' ? 'wrong-model' : model;
events.push(
  { type: 'message_end', message: {
    id: 'assistant-answer', role: 'assistant', provider: 'openai-codex', model: actualModel,
    responseModel: actualModel, stopReason: 'stop', content: [{ type: 'text', text: '\\\\boxed{answer}' }],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { total: 0.001 } },
  } },
  { type: 'agent_settled' },
);
for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
`;

const FAKE_GRADER_SOURCE = `
import { appendFileSync } from 'node:fs';
let input = ''; 
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const q = payload.question;
const prepareSemantic = process.argv.includes('--prepare-semantic');
if (process.env.LME_FAKE_GRADE_FAILURE === '1' && prepareSemantic) {
  process.stderr.write('SCORE_ERROR case_id=' + q.id + ' code=FAKE_GRADE_FAILED\\n');
  process.exit(1);
}
if (process.env.LME_FAKE_GRADES) appendFileSync(process.env.LME_FAKE_GRADES, q.id + (prepareSemantic ? ':prepare' : ':score') + '\\n');
if (prepareSemantic) {
  process.stdout.write(JSON.stringify({ id: q.id, evalName: q.eval_function, parsedAnswer: 'answer', isUnknown: false }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ id: q.id, score: true, evalName: 'exact_match', parsedAnswer: 'answer', isUnknown: false, semanticJudge: false, judgeUsage: { callCount: 0 } }) + '\\n');
}
`;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'longmemeval-v2-run-'));
  const dataRoot = join(root, 'data');
  const upstreamRoot = join(root, 'upstream');
  const outputRoot = join(root, 'private-output');
  const authPath = join(root, 'fake-auth.json');
  const callsPath = join(root, 'pi-calls.jsonl');
  const gradesPath = join(root, 'grade-calls.txt');
  const piPath = join(root, 'fake-pi.mjs');
  const graderPath = join(root, 'fake-grader.mjs');
  const data = makeData();
  const reportPaths: string[] = [];
  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(join(upstreamRoot, 'evaluation'), { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
  ]);
  await writeFile(join(upstreamRoot, 'evaluation', 'qa_eval_metrics.py'), '# synthetic pinned evaluator fixture\n');
  await writeFile(authPath, 'SYNTHETIC_AUTH_SECRET_DO_NOT_COPY', { mode: 0o600 });
  await writeFile(piPath, FAKE_PI_SOURCE);
  await writeFile(graderPath, FAKE_GRADER_SOURCE);
  let hashes = await writeDataset(dataRoot, data);

  const fixture: Fixture = {
    root, dataRoot, upstreamRoot, outputRoot, authPath, callsPath, gradesPath, piPath, graderPath,
    data, hashes, reportPaths,
    options(overrides = {}) {
      const testOnly = {
        piExecutablePath: process.execPath,
        piExecutableArgs: [piPath],
        graderExecutablePath: process.execPath,
        graderExecutableArgs: [graderPath],
        expectedHashes: hashes,
        datasetRevision: 'fixture-revision-1',
        upstreamRevision: EXPECTED_UPSTREAM,
        availableBytes: 2 * 1024 * 1024 * 1024,
        authPath,
        skipPilotManifest: true,
        ...overrides.testOnly,
      };
      return {
        dataRoot,
        upstreamRoot,
        set: 'full',
        model: MODEL,
        thinking: 'medium',
        outputRoot,
        execute: false,
        ...overrides,
        testOnly,
      };
    },
    async run(this: Fixture, options: RunOptions = this.options()) {
      const report = await runBenchmark(options);
      reportPaths.push(report.reportPath);
      return report;
    },
    async calls() {
      try {
        return (await readFile(callsPath, 'utf8')).split('\n').filter(Boolean)
          .map(line => JSON.parse(line) as { cwd: string; args: string[]; prompt: string; agentDir: string | null });
      } catch {
        return [];
      }
    },
  };
  const saved = {
    callPath: process.env.LME_FAKE_CALLS,
    gradePath: process.env.LME_FAKE_GRADES,
    piFailure: process.env.LME_FAKE_PI_FAILURE,
    gradeFailure: process.env.LME_FAKE_GRADE_FAILURE,
    judgeFailure: process.env.LME_FAKE_JUDGE_FAILURE,
    modelList: process.env.LME_FAKE_MODEL_LIST,
    openAiKey: process.env.OPENAI_API_KEY,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.LME_FAKE_CALLS = callsPath;
  process.env.LME_FAKE_GRADES = gradesPath;
  delete process.env.LME_FAKE_PI_FAILURE;
  delete process.env.LME_FAKE_GRADE_FAILURE;
  delete process.env.LME_FAKE_JUDGE_FAILURE;
  delete process.env.OPENAI_API_KEY;
  try {
    await run(fixture);
  } finally {
    for (const path of reportPaths) await rm(path, { force: true });
    await rm(root, { recursive: true, force: true });
    if (saved.callPath === undefined) delete process.env.LME_FAKE_CALLS;
    else process.env.LME_FAKE_CALLS = saved.callPath;
    if (saved.gradePath === undefined) delete process.env.LME_FAKE_GRADES;
    else process.env.LME_FAKE_GRADES = saved.gradePath;
    if (saved.piFailure === undefined) delete process.env.LME_FAKE_PI_FAILURE;
    else process.env.LME_FAKE_PI_FAILURE = saved.piFailure;
    if (saved.gradeFailure === undefined) delete process.env.LME_FAKE_GRADE_FAILURE;
    else process.env.LME_FAKE_GRADE_FAILURE = saved.gradeFailure;
    if (saved.judgeFailure === undefined) delete process.env.LME_FAKE_JUDGE_FAILURE;
    else process.env.LME_FAKE_JUDGE_FAILURE = saved.judgeFailure;
    if (saved.modelList === undefined) delete process.env.LME_FAKE_MODEL_LIST;
    else process.env.LME_FAKE_MODEL_LIST = saved.modelList;
    if (saved.openAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.openAiKey;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  }
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function resultSummary(report: RunReport): { status: string; failureCode: string | null } {
  return { status: report.status, failureCode: report.failureCode };
}

test('pinned snapshot preflight keeps its revision and rejects a changed source hash before execution', async t => {
  const configuredDataRoot = process.env.LME_TEST_DATA_ROOT;
  const configuredUpstreamRoot = process.env.LME_TEST_UPSTREAM_ROOT;
  if (!configuredDataRoot || !configuredUpstreamRoot) {
    t.skip('Set LME_TEST_DATA_ROOT and LME_TEST_UPSTREAM_ROOT to run the local pinned-snapshot check.');
    return;
  }

  const dataRoot = resolve(configuredDataRoot);
  const upstreamRoot = resolve(configuredUpstreamRoot);
  try {
    await Promise.all([
      access(join(dataRoot, 'questions.jsonl')),
      access(join(dataRoot, 'trajectories.jsonl')),
      access(join(dataRoot, 'haystacks', 'lme_v2_small.json')),
      access(join(upstreamRoot, 'evaluation', 'qa_eval_metrics.py')),
    ]);
  } catch {
    t.skip('The configured pinned dataset or upstream checkout is incomplete.');
    return;
  }

  const outputRoot = await mkdtemp(join(tmpdir(), 'longmemeval-v2-pinned-run-'));
  const reports: string[] = [];
  const options: RunOptions = {
    dataRoot,
    upstreamRoot,
    set: 'pilot',
    model: MODEL,
    thinking: 'medium',
    outputRoot,
    execute: false,
  };
  try {
    const pinned = await runBenchmark(options);
    reports.push(pinned.reportPath);
    assert.equal(pinned.status, 'preflight');
    assert.equal(pinned.dataRevision, 'f152293e235517d504809563c833d7190b8c713b');
    assert.deepEqual(pinned.sourceHashes, PINNED_SOURCE_HASHES);
    assert.equal(pinned.eligibleCount, 4);
    assert.equal(pinned.excludedCount, 29);

    const changedHashes = { ...PINNED_SOURCE_HASHES, 'questions.jsonl': '0'.repeat(64) };
    const changed = await runBenchmark({
      ...options,
      testOnly: { expectedHashes: changedHashes },
    });
    reports.push(changed.reportPath);
    assert.equal(changed.status, 'incomplete');
    assert.equal(changed.eligibleCount, 0);
    assert.equal(changed.modelVisible, null);
    assert.equal(changed.measuredUsage.totalTokens, 0);
  } finally {
    for (const reportPath of reports) await rm(reportPath, { force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('dry preflight checks answer and judge model visibility without paid calls', async () => {
  await withFixture(async fixture => {
    process.env.LME_FAKE_MODEL_LIST = 'provider model context max-out thinking images\nopenai-codex gpt-6-luna 1.1M 128K yes yes\nopenai-codex gpt-6-sol 1.1M 128K yes yes\n';
    const visible = await fixture.run(fixture.options());
    assert.equal(visible.modelVisible, true);
    assert.ok(!visible.warnings.some(warning => warning.includes('Judge model')));

    process.env.LME_FAKE_MODEL_LIST = 'provider model context max-out thinking images\nopenai-codex gpt-6-luna 1.1M 128K yes yes\n';
    const judgeAbsent = await fixture.run(fixture.options());
    assert.equal(judgeAbsent.modelVisible, true);
    assert.ok(judgeAbsent.warnings.some(warning => warning.includes('Judge model openai-codex/gpt-6-sol is not visible')));
    assert.equal((await fixture.calls()).length, 0);
    assert.doesNotMatch(await readFile(judgeAbsent.reportPath, 'utf8'), /OPENAI_API_KEY/u);

    process.env.LME_FAKE_MODEL_LIST = 'provider model context max-out thinking images\nopenai-codex gpt-6-sol 1.1M 128K yes yes\n';
    const answerAbsent = await fixture.run(fixture.options());
    assert.equal(answerAbsent.modelVisible, false);

    process.env.LME_FAKE_MODEL_LIST = 'provider model context max-out thinking images\nother-provider gpt-6-luna 1.1M 128K yes yes\n';
    const wrongProvider = await fixture.run(fixture.options());
    assert.equal(wrongProvider.modelVisible, false);
  });
});

test('offline preflight reports coverage and unknown cost without paid processes and writes a sanitized dated report', async () => {
  await withFixture(async fixture => {
    delete process.env.OPENAI_API_KEY;
    const report = await fixture.run(fixture.options({
      testOnly: { authAvailable: false, availableBytes: 0 },
    }));
    assert.deepEqual(resultSummary(report), { status: 'preflight', failureCode: null });
    assert.equal(report.eligibleCount, 2);
    assert.equal(report.excludedCount, 1);
    assert.deepEqual(report.excludedIds, ['image-case']);
    assert.equal(report.answerSessionCount, 4);
    assert.equal(report.plannedJudgeCallCount, 2);
    assert.equal(report.pluginGitRevision, null);
    assert.match(report.pluginSource ?? '', /^source-fingerprint:/u);
    assert.equal(report.ingestionCost?.usd, null);
    assert.equal(report.pluginAnswerCost?.usd, null);
    assert.equal(report.controlCost?.usd, null);
    assert.equal(report.judgeCost?.usd, null);
    assert.equal(report.authAvailable, false);
    assert.equal(report.storageAvailableBytes, 0);
    assert.ok(report.warnings.some(warning => warning.includes('auth file is missing')));
    assert.ok(report.warnings.some(warning => warning.includes('less than 1 GiB')));
    assert.equal((await fixture.calls()).length, 0);
    assert.equal(await lstat(fixture.gradesPath).then(() => true, () => false), false);
    const text = await readFile(report.reportPath, 'utf8');
    assert.match(report.reportPath, /docs\/benchmarks\/\d{4}-\d{2}-\d{2}T/u);
    assert.match(text, /Eligible cases: 2/u);
    assert.match(text, /Excluded image cases: 1/u);
    assert.match(text, /unknown/u);
    assert.match(text, /non-official/u);
    assert.doesNotMatch(text, /GOLD_|SYNTHETIC_AUTH_SECRET|qa_eval_metrics\.py|private-output|fake-auth\.json|OPENAI_API_KEY/u);
    assert.match(text, /Semantic judge API-rate comparison \(not a subscription charge\)/u);
  });
});

test('two-domain fake run pairs cases, preserves history order, isolates extension mode, links auth, and checkpoints private files', async () => {
  await withFixture(async fixture => {
    const report = await fixture.run(fixture.options({ execute: true }));
    assert.deepEqual(resultSummary(report), { status: 'complete', failureCode: null });
    assert.equal(report.cases.length, 2);
    assert.ok(report.cases.every(row => row.status === 'scored' && row.pluginScore === true && row.controlScore === true));
    assert.equal(report.judgeCallCount, 2);
    assert.equal(report.plannedJudgeCallCount, 2);
    const expectedEnterpriseId = sha256(`git\0${join(report.runDirectory!, 'fixtures', 'enterprise', '.git')}`);
    const expectedWebId = sha256(`git\0${join(report.runDirectory!, 'fixtures', 'web', '.git')}`);
    assert.equal(report.projectId, `enterprise:${expectedEnterpriseId}; web:${expectedWebId}`);
    assert.equal(report.actualModelIdentity, 'openai-codex/gpt-6-luna/gpt-6-luna');
    assert.ok(report.measuredUsage.totalTokens > 0);
    assert.ok(Math.abs((report.measuredUsage.reportedUsd ?? 0) - 0.006) < 1e-12);
    assert.ok((report.ingestionCost?.usage?.totalTokens ?? 0) > 0);
    assert.match(report.reportPath, /docs\/benchmarks\//u);

    const markdown = await readFile(report.reportPath, 'utf8');
    assert.match(markdown, /Accuracy by domain and question type/u);
    assert.match(markdown, /domain:web/u);
    assert.match(markdown, /domain:enterprise/u);
    assert.match(markdown, /Semantic judge API-rate comparison \(not a subscription charge\)/u);
    assert.doesNotMatch(markdown, /GOLD_|SYNTHETIC_AUTH_SECRET|FAKE_RAW_EVENT|fake-auth\.json|private-output|OPENAI_API_KEY|\.benchmarks/u);

    const calls = await fixture.calls();
    const modelCalls = calls.filter(call => call.args.includes('--session'));
    const judgeCalls = calls.filter(call => call.args.includes('--system-prompt'));
    assert.equal(modelCalls.length, report.historyChunkCount + report.answerSessionCount);
    assert.equal(judgeCalls.length, 2);
    assert.ok(judgeCalls.every(call => call.args.includes('--provider') && optionValue(call.args, '--provider') === 'openai-codex'));
    assert.ok(judgeCalls.every(call => optionValue(call.args, '--model') === 'gpt-6-sol'));
    assert.ok(judgeCalls.every(call => optionValue(call.args, '--thinking') === 'high'));
    assert.ok(judgeCalls.every(call => call.args.includes('--no-session') && call.args.includes('--no-tools')));
    assert.ok(judgeCalls.every(call => call.agentDir === join(report.runDirectory!, 'agent')));
    const semanticAnswerIndexes = calls.flatMap((call, index) =>
      call.args.includes('--session') && call.prompt.endsWith('What was the enterprise setting?') ? [index] : [],
    );
    assert.equal(semanticAnswerIndexes.length, 2);
    assert.ok(Math.min(...judgeCalls.map(call => calls.indexOf(call))) > Math.max(...semanticAnswerIndexes));
    const memoryCalls = modelCalls.filter(call => call.args.includes('--tools'));
    const controlCalls = modelCalls.filter(call => call.args.includes('--no-tools'));
    assert.ok(memoryCalls.length > controlCalls.length);
    assert.ok(memoryCalls.every(call => call.args.includes('-e') && optionValue(call.args, '--tools') === 'pi_context'));
    assert.ok(controlCalls.every(call => !call.args.includes('-e') && call.agentDir === (ORIGINAL_AGENT_DIR ?? null)));
    assert.ok(controlCalls.every(call => !call.prompt.includes('observation')));
    assert.ok(memoryCalls.every(call => call.agentDir === join(report.runDirectory!, 'agent')));
    assert.ok(modelCalls.every(call => !call.prompt.includes('GOLD_') && !call.prompt.includes('image-case')));

    const history = modelCalls.filter(call => call.prompt.startsWith('Store this ordered history'));
    assert.equal(history.length, 2);
    for (const domain of ['web', 'enterprise']) {
      const prompt = history.find(call => call.cwd.endsWith(`/fixtures/${domain}`))?.prompt ?? '';
      assert.ok(prompt.indexOf(`${domain} observation 000`) < prompt.indexOf(`${domain} observation 099`));
    }
    for (const row of report.cases) {
      const paired = modelCalls.filter(call => call.prompt.endsWith(fixture.data.questions.find(question => question.id === row.id)?.question ?? ''));
      assert.equal(paired.length, 2);
      assert.equal(paired.filter(call => call.args.includes('--tools')).length, 1);
      assert.equal(paired.filter(call => call.args.includes('--no-tools')).length, 1);
    }

    const runDirectory = report.runDirectory!;
    assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(runDirectory, 'sessions'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(runDirectory, 'fixtures', 'web'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(runDirectory, 'fixtures', 'enterprise'))).mode & 0o777, 0o700);
    assert.notEqual(
      resolve(join(runDirectory, 'fixtures', 'web', '.git')),
      resolve(join(runDirectory, 'fixtures', 'enterprise', '.git')),
    );
    assert.deepEqual(await readdir(join(runDirectory, 'fixtures', 'web')), ['.git']);
    assert.deepEqual(await readdir(join(runDirectory, 'fixtures', 'enterprise')), ['.git']);
    assert.equal((await stat(join(runDirectory, 'agent'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(runDirectory, 'checkpoint.json'))).mode & 0o777, 0o600);
    const sessionLogs = (await readdir(join(runDirectory, 'sessions'))).filter(name => name.endsWith('.stdout.jsonl') || name.endsWith('.stderr.log') || name.endsWith('.session.jsonl'));
    assert.ok(sessionLogs.length > 0);
    for (const name of sessionLogs) assert.equal((await stat(join(runDirectory, 'sessions', name))).mode & 0o777, 0o600);

    const agentConfig = JSON.parse(await readFile(join(runDirectory, 'agent', 'pi-context.json'), 'utf8')) as { projects: Array<{ root: string; maxBytes: number }> };
    assert.equal(agentConfig.projects.length, 2);
    assert.ok(agentConfig.projects.every(project => project.maxBytes === 10_485_760));
    assert.equal((await stat(join(runDirectory, 'agent', 'pi-context.json'))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(runDirectory, 'agent', 'auth.json'))).isSymbolicLink(), true);
    assert.equal(resolve(await readlink(join(runDirectory, 'agent', 'auth.json'))), fixture.authPath);
    assert.equal((await lstat(fixture.authPath)).isFile(), true);
    assert.equal((await readFile(join(runDirectory, 'agent', 'auth.json'), 'utf8')), 'SYNTHETIC_AUTH_SECRET_DO_NOT_COPY');
    assert.equal(process.env.PI_CODING_AGENT_DIR, ORIGINAL_AGENT_DIR);
  });
});

test('invalid subscription judge output creates a complete incorrect semantic grade', async () => {
  await withFixture(async fixture => {
    process.env.LME_FAKE_JUDGE_FAILURE = 'invalid-output';
    const report = await fixture.run(fixture.options({ execute: true }));
    assert.deepEqual(resultSummary(report), { status: 'complete', failureCode: null });
    assert.deepEqual(report.cases.find(row => row.id === 'web-case')?.pluginScore, true);
    assert.deepEqual(report.cases.find(row => row.id === 'enterprise-case')?.pluginScore, false);
    assert.deepEqual(report.cases.find(row => row.id === 'enterprise-case')?.controlScore, false);
    assert.equal(report.judgeCallCount, 2);

    const checkpoint = JSON.parse(await readFile(join(report.runDirectory!, 'checkpoint.json'), 'utf8')) as {
      stages: Record<string, { status: string; score?: { score: boolean; semanticJudge: boolean; judgeUsage: unknown }; errorCode?: string; stdout: string; stderr: string }>;
    };
    for (const mode of ['memory', 'control']) {
      const stage = checkpoint.stages[`grade-enterprise-case-${mode}`];
      assert.equal(stage?.status, 'complete');
      assert.equal(stage?.score?.score, false);
      assert.equal(stage?.score?.semanticJudge, true);
      assert.equal(stage?.score?.judgeUsage, null);
      assert.equal(stage?.errorCode, 'JUDGE_OUTPUT_INVALID');
      assert.equal(JSON.parse(await readFile(join(report.runDirectory!, stage!.stdout), 'utf8')).score, false);
      assert.equal(await readFile(join(report.runDirectory!, stage!.stderr), 'utf8'), 'JUDGE_OUTPUT_INVALID\n');
    }
    const markdown = await readFile(report.reportPath, 'utf8');
    assert.doesNotMatch(markdown, /GOLD_|SYNTHETIC_AUTH_SECRET|FAKE_RAW_EVENT|fake-auth\.json|private-output|OPENAI_API_KEY|\.benchmarks/u);
  });
});

test('judge auth failure after answer writes incorrect grades and continues the run', async () => {
  await withFixture(async fixture => {
    process.env.LME_FAKE_JUDGE_FAILURE = 'auth';
    const report = await fixture.run(fixture.options({ execute: true }));
    assert.deepEqual(resultSummary(report), { status: 'complete', failureCode: null });
    assert.equal(report.judgeCallCount, 2);
    assert.equal(report.cases.find(row => row.id === 'enterprise-case')?.pluginScore, false);
    assert.equal(report.cases.find(row => row.id === 'enterprise-case')?.controlScore, false);
    assert.ok(report.cases.every(row => row.status === 'scored'));

    const calls = await fixture.calls();
    const judgeIndexes = calls.flatMap((call, index) => call.args.includes('--system-prompt') ? [index] : []);
    assert.equal(judgeIndexes.length, 2);
    const semanticAnswerIndexes = calls.flatMap((call, index) =>
      call.args.includes('--session') && call.prompt.endsWith('What was the enterprise setting?') ? [index] : [],
    );
    assert.equal(semanticAnswerIndexes.length, 2);
    assert.ok(Math.min(...judgeIndexes) > Math.max(...semanticAnswerIndexes));
    assert.equal(calls.filter(call => call.args.includes('--session')).length, report.historyChunkCount + report.answerSessionCount);

    const checkpoint = JSON.parse(await readFile(join(report.runDirectory!, 'checkpoint.json'), 'utf8')) as {
      stages: Record<string, { status: string; errorCode?: string; score?: { score: boolean } }>;
    };
    for (const mode of ['memory', 'control']) {
      const stage = checkpoint.stages[`grade-enterprise-case-${mode}`];
      assert.equal(stage?.status, 'complete');
      assert.equal(stage?.score?.score, false);
      assert.equal(stage?.errorCode, 'AUTH_ERROR');
    }
    const markdown = await readFile(report.reportPath, 'utf8');
    assert.doesNotMatch(markdown, /GOLD_|SYNTHETIC_AUTH_SECRET|FAKE_RAW_EVENT|authentication unauthorized|fake-auth\.json|private-output|OPENAI_API_KEY|\.benchmarks/u);
  });
});

test('missing shared auth creates replaceable incorrect grades and keeps the run incomplete', async () => {
  await withFixture(async fixture => {
    const first = await fixture.run(fixture.options({
      execute: true,
      testOnly: { authAvailable: false },
    }));
    assert.deepEqual(resultSummary(first), { status: 'incomplete', failureCode: 'MODEL_AUTH_NOT_AVAILABLE' });
    assert.equal(first.authAvailable, false);
    assert.equal(first.judgeCallCount, 0);
    assert.ok(first.cases.every(row => row.status === 'incomplete' && row.pluginScore === false && row.controlScore === false));
    assert.equal((await fixture.calls()).length, 0);

    const checkpointPath = join(first.runDirectory!, 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      status: string;
      failure: { code: string };
      stages: Record<string, {
        status: string;
        errorCode?: string;
        score?: { id: string; score: boolean; evalName: string; parsedAnswer: string; isUnknown: boolean; semanticJudge: boolean; judgeUsage: unknown };
        stdout: string;
        stderr: string;
      }>;
    };
    assert.equal(checkpoint.status, 'incomplete');
    assert.equal(checkpoint.failure.code, 'MODEL_AUTH_NOT_AVAILABLE');
    assert.ok(Object.keys(checkpoint.stages).every(key => key.startsWith('grade-')));
    for (const stage of Object.values(checkpoint.stages)) {
      assert.equal(stage.status, 'failed');
      assert.equal(stage.errorCode, 'MODEL_AUTH_NOT_AVAILABLE');
      assert.equal(stage.score?.score, false);
      assert.equal(await readFile(join(first.runDirectory!, stage.stdout), 'utf8').then(text => JSON.parse(text).score), false);
    }

    const preservedKey = 'grade-web-case-memory';
    const preservedStage = checkpoint.stages[preservedKey];
    assert.ok(preservedStage);
    const preservedScore = {
      id: 'web-case', score: true, evalName: 'exact_match', parsedAnswer: 'answer',
      isUnknown: false, semanticJudge: false, judgeUsage: { callCount: 0 },
    };
    preservedStage.status = 'complete';
    delete preservedStage.errorCode;
    preservedStage.score = preservedScore;
    await writeFile(join(first.runDirectory!, preservedStage.stdout), `${JSON.stringify(preservedScore)}\n`, { mode: 0o600 });
    await writeFile(join(first.runDirectory!, preservedStage.stderr), '', { mode: 0o600 });
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });

    const resumed = await fixture.run(fixture.options({
      execute: true,
      resumeDir: first.runDirectory!,
      testOnly: { authAvailable: true },
    }));
    assert.deepEqual(resultSummary(resumed), { status: 'complete', failureCode: null });
    assert.ok(resumed.cases.every(row => row.status === 'scored' && row.pluginScore === true && row.controlScore === true));
    assert.equal(resumed.judgeCallCount, 2);
    const after = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      status: string;
      stages: Record<string, { status: string; errorCode?: string; score?: { score: boolean } }>;
    };
    assert.equal(after.status, 'complete');
    assert.equal(after.stages[preservedKey]?.status, 'complete');
    assert.equal(after.stages[preservedKey]?.score?.score, true);
    assert.equal(after.stages[preservedKey]?.errorCode, undefined);
    assert.ok(Object.values(after.stages).every(stage => stage.errorCode !== 'MODEL_AUTH_NOT_AVAILABLE'));
  });
});

test('model mismatch, quota, and semantic preparation failures remain incomplete', async () => {
  await withFixture(async fixture => {
    process.env.LME_FAKE_PI_FAILURE = 'model-mismatch';
    const wrongModel = await fixture.run(fixture.options({ execute: true }));
    assert.deepEqual(resultSummary(wrongModel), { status: 'incomplete', failureCode: 'MODEL_MISMATCH' });
    assert.ok(wrongModel.measuredUsage.totalTokens > 0);

    process.env.LME_FAKE_PI_FAILURE = 'quota';
    const quota = await fixture.run(fixture.options({ execute: true }));
    assert.deepEqual(resultSummary(quota), { status: 'incomplete', failureCode: 'QUOTA_EXCEEDED' });
    assert.ok(quota.measuredUsage.totalTokens > 0);
    assert.ok(quota.ingestionCost !== null);
    assert.ok(quota.cases.every(row => row.status === 'incomplete'));

    delete process.env.LME_FAKE_PI_FAILURE;
    process.env.LME_FAKE_GRADE_FAILURE = '1';
    const gradeFailure = await fixture.run(fixture.options({ execute: true }));
    assert.deepEqual(resultSummary(gradeFailure), { status: 'incomplete', failureCode: 'FAKE_GRADE_FAILED' });
    const markdown = await readFile(gradeFailure.reportPath, 'utf8');
    assert.doesNotMatch(markdown, /Accuracy by domain and question type/u);
    const gradeCheckpoint = JSON.parse(await readFile(join(gradeFailure.runDirectory!, 'checkpoint.json'), 'utf8')) as { status: string; failure: { code: string } };
    assert.equal(gradeCheckpoint.status, 'incomplete');
    assert.equal(gradeCheckpoint.failure.code, 'FAKE_GRADE_FAILED');
  });
});

test('malformed ingestion logs are ambiguous and resume does not replay record calls', async () => {
  await withFixture(async fixture => {
    process.env.LME_FAKE_PI_FAILURE = 'malformed';
    const failed = await fixture.run(fixture.options({ execute: true }));
    assert.deepEqual(resultSummary(failed), { status: 'incomplete', failureCode: 'JSONL_INVALID' });
    const checkpointPath = join(failed.runDirectory!, 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      stages: Record<string, { status: string }>;
      status: string;
    };
    assert.equal(checkpoint.status, 'incomplete');
    assert.equal(checkpoint.stages['history-enterprise-0001']?.status, 'failed');
    const callsBeforeResume = (await fixture.calls()).filter(call => call.args.includes('--session')).length;
    delete process.env.LME_FAKE_PI_FAILURE;
    const resumed = await fixture.run(fixture.options({ execute: true, resumeDir: failed.runDirectory! }));
    assert.deepEqual(resultSummary(resumed), { status: 'incomplete', failureCode: 'STAGE_LOG_AMBIGUOUS' });
    const callsAfterResume = (await fixture.calls()).filter(call => call.args.includes('--session')).length;
    assert.equal(callsAfterResume, callsBeforeResume);
    const after = JSON.parse(await readFile(checkpointPath, 'utf8')) as { status: string; failure: { code: string } };
    assert.equal(after.status, 'incomplete');
    assert.equal(after.failure.code, 'STAGE_LOG_AMBIGUOUS');
  });
});

test('resume recovers settled logs, skips valid work, and rejects changed dataset hashes', async () => {
  await withFixture(async fixture => {
    const first = await fixture.run(fixture.options({ execute: true }));
    assert.equal(first.status, 'complete');
    const runDirectory = first.runDirectory!;
    const checkpointPath = join(runDirectory, 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      status: string;
      stages: Record<string, unknown>;
    };
    delete checkpoint.stages['history-web-0001'];
    checkpoint.status = 'incomplete';
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    const beforeRecovery = (await fixture.calls()).filter(call => call.args.includes('--session')).length;
    const recovered = await fixture.run(fixture.options({ execute: true, resumeDir: runDirectory }));
    assert.equal(recovered.status, 'complete');
    const afterRecovery = (await fixture.calls()).filter(call => call.args.includes('--session')).length;
    assert.equal(afterRecovery, beforeRecovery);
    const recoveredCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      status: string;
      stages: Record<string, { status: string }>;
    };
    assert.equal(recoveredCheckpoint.status, 'complete');
    assert.equal(recoveredCheckpoint.stages['history-web-0001']?.status, 'complete');

    fixture.data.questions[0]!.question = 'Changed source question text.';
    fixture.hashes = await writeDataset(fixture.dataRoot, fixture.data);
    const stale = await fixture.run(fixture.options({
      execute: true,
      resumeDir: runDirectory,
      testOnly: { expectedHashes: fixture.hashes },
    }));
    assert.deepEqual(resultSummary(stale), { status: 'incomplete', failureCode: 'STALE_RESUME_INPUTS' });
    const afterStale = (await fixture.calls()).filter(call => call.args.includes('--session')).length;
    assert.equal(afterStale, beforeRecovery);
    assert.equal(stale.pluginGitRevision, null);
  });
});

test('execution rejects less than 1 GiB output storage before ingestion', async () => {
  await withFixture(async fixture => {
    const report = await fixture.run(fixture.options({
      execute: true,
      testOnly: { availableBytes: 1024 * 1024 * 1024 - 1 },
    }));
    assert.deepEqual(resultSummary(report), { status: 'incomplete', failureCode: 'OUTPUT_STORAGE_INSUFFICIENT' });
    assert.equal((await fixture.calls()).filter(call => call.args.includes('--session')).length, 0);
    const checkpoint = JSON.parse(await readFile(join(report.runDirectory!, 'checkpoint.json'), 'utf8')) as { status: string; failure: { code: string } };
    assert.equal(checkpoint.status, 'incomplete');
    assert.equal(checkpoint.failure.code, 'OUTPUT_STORAGE_INSUFFICIENT');
  });
});

test('the CLI accepts the ignored relative output root and rejects public or symlinked roots', async () => {
  const { parseRunArguments } = await import('../scripts/longmemeval-v2/run.ts');
  const parse = (outputRoot: string) => parseRunArguments([
    '--data-root', '/tmp/lme-data', '--upstream-root', '/tmp/lme-upstream', '--set', 'pilot', '--model', MODEL,
    '--thinking', 'medium', '--output-root', outputRoot,
  ]);
  assert.equal(parse('.benchmarks/lme-v2').outputRoot, resolve(process.cwd(), '.benchmarks/lme-v2'));
  assert.equal(parse('/tmp/lme-v2-external-output').outputRoot, '/tmp/lme-v2-external-output');
  assert.throws(() => parse('docs/benchmarks'), /PATH_MUST_BE_ABSOLUTE_OUTPUT_ROOT/u);
  assert.throws(() => parse('.benchmarks/../docs/benchmarks'), /PATH_MUST_BE_ABSOLUTE_OUTPUT_ROOT/u);
  assert.throws(() => parse(resolve(process.cwd(), 'docs/benchmarks')), /OUTPUT_ROOT_MUST_BE_OUTSIDE_PROJECT/u);

  const benchmarkRoot = resolve(process.cwd(), '.benchmarks');
  const rootInfo = await lstat(benchmarkRoot).catch(() => null);
  let createdRoot = false;
  if (rootInfo === null) {
    await mkdir(benchmarkRoot, { mode: 0o700 });
    createdRoot = true;
  }
  const linkPath = join(benchmarkRoot, `symlink-check-${process.pid}-${Date.now()}`);
  try {
    await symlink(tmpdir(), linkPath, 'dir');
    assert.throws(() => parse(`.benchmarks/${linkPath.slice(benchmarkRoot.length + 1)}/output`), /OUTPUT_ROOT_SYMLINK/u);
  } finally {
    await rm(linkPath, { force: true });
    if (createdRoot) await rm(benchmarkRoot, { recursive: true, force: true });
  }
});

test('the CLI argument parser rejects unknown flags, unsupported models, and resumes without execute', async () => {
  const { parseRunArguments } = await import('../scripts/longmemeval-v2/run.ts');
  assert.throws(() => parseRunArguments(['--unknown']), /UNKNOWN_FLAG/u);
  assert.throws(() => parseRunArguments([
    '--data-root', '/tmp/data', '--upstream-root', '/tmp/upstream', '--set', 'full', '--model', 'openai/unsupported',
    '--thinking', 'medium', '--output-root', '/tmp/output',
  ]), /MODEL_UNSUPPORTED/u);
  assert.throws(() => parseRunArguments([
    '--data-root', '/tmp/data', '--upstream-root', '/tmp/upstream', '--set', 'full', '--model', MODEL,
    '--thinking', 'medium', '--output-root', '/tmp/output', '--resume', '/tmp/run',
  ]), /RESUME_REQUIRES_EXECUTE/u);
  assert.deepEqual(PINNED_SOURCE_HASHES['questions.jsonl'].length, 64);
});
