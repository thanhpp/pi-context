import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  judgeSemanticCase,
  parseBinaryJudgement,
  type SemanticJudgeInput,
  type SemanticJudgeResult,
} from '../scripts/longmemeval-v2/judge.ts';

const FAKE_JUDGE_PI = resolve('test/fixtures/fake-judge-pi.ts');
const ABSTENTION_SYSTEM_PROMPT = 'You are a strict grader for flawed-premise (abstention) questions. Judge whether a model answer correctly identifies that the question premise is wrong, consistent with the reference answer. If the model follows the flawed premise and gives a concrete answer under that premise, it must be graded 0. If the model\'s final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. Paraphrases are allowed when they preserve the same core flaw described by the reference answer.';
const GOTCHAS_SYSTEM_PROMPT = 'You are a strict grader for gotchas-style insight questions. The reference answer describes the key insight(s). Grade 1 if the model response includes at least one correct insight point from the reference answer (paraphrase allowed), and does not contradict any reference point. If the model\'s direction is wrong, or it contains contradictions against any reference point, grade 0. If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.';

const ABSTENTION_USER_PROMPT = `Evaluate whether the model correctly handled a flawed-premise question.\n\nQuestion:\nIs this premise valid?\n\nReference answer (the expected flaw-aware conclusion):\nThe premise is false.\n\nModel full response:\nThe premise is false.\n\nModel extracted final answer:\nThe premise is false.\n\nScoring rubric:\n- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion equivalent to the reference answer.\n- Label 1 also if the model explicitly says it lacks access to the user's specific live environment/instance/configuration and therefore cannot verify, provided it does not give a concrete premise-following answer.\n- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.\n- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not make the explicit environment-access limitation clear.\n- Label 0 if contradictory.\n\nOutput JSON only:\n{\"label\": 0 or 1, \"reason\": \"short rationale\"}`;
const GOTCHAS_USER_PROMPT = `Evaluate whether the model answer captures the gotcha insight.\n\nQuestion:\nIs this premise valid?\n\nReference answer (insight points):\nThe premise is false.\n\nModel full response:\nThe premise is false.\n\nModel extracted final answer:\nThe premise is false.\n\nScoring rubric:\n- Label 1 if the model includes at least one correct insight point from the reference answer (paraphrase acceptable), and does not contradict any reference point.\n- Label 1 even if only part of a multi-point reference answer is covered, as long as there is no contradiction.\n- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.\n- Label 0 if any point in the model response contradicts any reference point.\n- Label 0 if the response is irrelevant or generic without insight.\n\nOutput JSON only:\n{\"label\": 0 or 1, \"reason\": \"short rationale\"}`;

type FixtureCapture = {
  args: string[];
  cwd: string;
  piCodingAgentDir: string | null;
  openAiApiKeySet: boolean;
};

type Fixture = {
  root: string;
  cwd: string;
  authDirectory: string;
  input(
    evaluator: SemanticJudgeInput['evaluator'],
    scenario?: string,
    overrides?: Partial<SemanticJudgeInput>,
  ): SemanticJudgeInput;
  capture(): Promise<FixtureCapture>;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'longmemeval-v2-judge-'));
  const cwd = join(root, 'private-run');
  const authDirectory = join(root, 'private-agent');
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(authDirectory, { mode: 0o700 });
  await chmod(cwd, 0o700);
  await chmod(authDirectory, 0o700);
  await writeFile(join(authDirectory, 'auth.json'), '{"fixture":true}\n', { mode: 0o600 });
  const fixture: Fixture = {
    root,
    cwd,
    authDirectory,
    input(evaluator, scenario = 'valid', overrides = {}) {
      return {
        question: 'Is this premise valid?',
        answer: 'The premise is false.',
        responseRaw: 'The premise is false.',
        parsedAnswer: scenario === 'unknown-answer' ? 'UNKNOWN' : 'The premise is false.',
        evaluator,
        cwd,
        authDirectory,
        testOnlyExecutablePath: process.execPath,
        testOnlyExecutableArgs: ['--experimental-strip-types', FAKE_JUDGE_PI, scenario],
        testOnlyTimeoutMs: 5_000,
        ...overrides,
      };
    },
    async capture() {
      return JSON.parse(await readFile(join(cwd, 'fake-judge-pi.capture.json'), 'utf8')) as FixtureCapture;
    },
  };
  try {
    await run(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function assertSafeFailure(result: SemanticJudgeResult, errorCode: string): void {
  assert.deepEqual(result, { score: false, errorCode });
  assert.match(result.errorCode ?? '', /^[A-Z_]+$/u);
  assert.ok(!result.errorCode?.toLowerCase().includes('login'));
  assert.ok(!result.errorCode?.toLowerCase().includes('authentication'));
}

test('the binary parser accepts pinned JSON, fenced, and fallback forms', () => {
  assert.deepEqual(parseBinaryJudgement('{"label":1,"reason":"matches"}'), {
    label: 1,
    reason: 'matches',
  });
  assert.deepEqual(parseBinaryJudgement('{"label":"0","reason":"does not match"}'), {
    label: 0,
    reason: 'does not match',
  });
  assert.deepEqual(parseBinaryJudgement('```json\n{"label": 1, "reason": "fenced"}\n```'), {
    label: 1,
    reason: 'fenced',
  });
  assert.equal(parseBinaryJudgement('Result: "label": 0').label, 0);
  assert.equal(parseBinaryJudgement("Result: 'label': 1").label, 1);
  assert.equal(parseBinaryJudgement('Result: label = 0').label, 0);
  assert.throws(() => parseBinaryJudgement(''), /JUDGE_OUTPUT_INVALID/u);
  assert.throws(() => parseBinaryJudgement('{"reason":"missing label"}'), /JUDGE_OUTPUT_INVALID/u);
  assert.throws(() => parseBinaryJudgement('{"label":2}'), /JUDGE_OUTPUT_INVALID/u);
  assert.throws(() => parseBinaryJudgement('{"label":true}'), /JUDGE_OUTPUT_INVALID/u);
});

test('both upstream rubrics use one isolated gpt-6-sol high-thinking request', async () => {
  await withFixture(async fixture => {
    for (const [evaluator, expectedSystem, expectedUser] of [
      ['llm_abstention_checker', ABSTENTION_SYSTEM_PROMPT, ABSTENTION_USER_PROMPT],
      ['llm_gotchas_checker', GOTCHAS_SYSTEM_PROMPT, GOTCHAS_USER_PROMPT],
    ] as const) {
      const result = await judgeSemanticCase(fixture.input(evaluator));
      assert.deepEqual(result, { score: true, errorCode: null });
      const capture = await fixture.capture();
      assert.equal(capture.cwd, fixture.cwd);
      assert.equal(capture.piCodingAgentDir, fixture.authDirectory);
      assert.equal(capture.openAiApiKeySet, false);
      assert.equal(valueAfter(capture.args, '--mode'), 'json');
      assert.equal(valueAfter(capture.args, '--provider'), 'openai-codex');
      assert.equal(valueAfter(capture.args, '--model'), 'gpt-6-sol');
      assert.equal(valueAfter(capture.args, '--thinking'), 'high');
      assert.equal(valueAfter(capture.args, '--system-prompt'), expectedSystem);
      assert.equal(valueAfter(capture.args, '-p'), expectedUser);
      assert.ok(capture.args.includes('--no-session'));
      assert.ok(capture.args.includes('--no-tools'));
      assert.ok(['-ne', '-ns', '-np', '-nc', '-na'].every(flag => capture.args.includes(flag)));
      assert.ok(!capture.args.includes('--session'));
      assert.ok(!capture.args.includes('--api-key'));
      assert.ok(!capture.args.includes('--tools'));
      assert.deepEqual(await readdir(fixture.cwd), ['fake-judge-pi.capture.json']);
    }
  });
});

test('a literal UNKNOWN final answer stays incorrect after a valid judgment', async () => {
  await withFixture(async fixture => {
    const result = await judgeSemanticCase(fixture.input('llm_abstention_checker', 'unknown-answer'));
    assert.deepEqual(result, { score: false, errorCode: null });
  });
});

test('judge failures return false with stable codes and no raw error text', async () => {
  await withFixture(async fixture => {
    const cases: Array<[string, string, number?]> = [
      ['auth-failure', 'AUTH_ERROR'],
      ['model-failure', 'MODEL_ERROR'],
      ['process-failure', 'PROCESS_ERROR'],
      ['timeout', 'TIMEOUT', 50],
      ['oversized-output', 'OUTPUT_LIMIT'],
      ['malformed-jsonl', 'JSONL_INVALID'],
      ['invalid-output', 'JUDGE_OUTPUT_INVALID'],
      ['nonbinary-output', 'JUDGE_OUTPUT_INVALID'],
      ['model-mismatch', 'MODEL_MISMATCH'],
      ['missing-response-model', 'MODEL_MISMATCH'],
      ['not-settled', 'AGENT_NOT_SETTLED'],
      ['assistant-error', 'ASSISTANT_ERROR'],
      ['multiple-assistants', 'ASSISTANT_MESSAGE_COUNT_INVALID'],
    ];
    for (const [scenario, errorCode, timeout] of cases) {
      const result = await judgeSemanticCase(fixture.input('llm_gotchas_checker', scenario, {
        ...(timeout === undefined ? {} : { testOnlyTimeoutMs: timeout }),
      }));
      assertSafeFailure(result, errorCode);
    }
  });
});

test('invalid judge paths and evaluator names fail without starting Pi', async () => {
  await withFixture(async fixture => {
    const input = fixture.input('llm_abstention_checker');
    const invalidCwd = await judgeSemanticCase({ ...input, cwd: join(fixture.root, 'missing-run-directory') });
    assertSafeFailure(invalidCwd, 'RUN_DIRECTORY_INVALID');
    const invalidAuthDirectory = await judgeSemanticCase({ ...input, authDirectory: fixture.cwd });
    assertSafeFailure(invalidAuthDirectory, 'AUTH_DIRECTORY_INVALID');
    const invalidEvaluator = await judgeSemanticCase({
      ...input,
      evaluator: 'unsupported' as SemanticJudgeInput['evaluator'],
    });
    assertSafeFailure(invalidEvaluator, 'INPUT_INVALID');
  });
});
