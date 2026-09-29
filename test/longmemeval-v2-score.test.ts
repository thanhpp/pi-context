import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const SCORE_SCRIPT = resolve('scripts/longmemeval-v2/score.py');
const DEFAULT_PYTHON = join(homedir(), 'benchmarks/lme-venv/bin/python');
const PYTHON = process.env.LME_PYTHON ?? (existsSync(DEFAULT_PYTHON) ? DEFAULT_PYTHON : 'python3');
const UPSTREAM_NOT_CONFIGURED = !process.env.LME_UPSTREAM
  ? 'LME_UPSTREAM is not configured; pinned-upstream scoring checks are skipped.'
  : false;

type ScorePayload = {
  question: Record<string, unknown>;
  responseRaw: string;
};

function runScore(
  payload: ScorePayload,
  options: {
    execute?: boolean;
    prepareSemantic?: boolean;
    evaluatorModel?: string;
    blockOpenAI?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const scriptArgs = [];
  if (options.execute) scriptArgs.push('--execute');
  if (options.prepareSemantic) scriptArgs.push('--prepare-semantic');
  if (options.evaluatorModel) scriptArgs.push('--evaluator-model', options.evaluatorModel);
  const env = { ...process.env, ...options.env };
  const apiGuard = String.raw`
import importlib.util, sys, types
openai = types.ModuleType('openai')
class OpenAI:
    def __init__(self, **kwargs):
        raise RuntimeError('blocked test API call')
openai.OpenAI = OpenAI
sys.modules['openai'] = openai
script_path = sys.argv[1]
spec = importlib.util.spec_from_file_location('_score_under_test', script_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
sys.argv = [script_path, *sys.argv[2:]]
raise SystemExit(module.main())
`;
  const command = options.blockOpenAI
    ? [PYTHON, '-c', apiGuard, SCORE_SCRIPT, ...scriptArgs]
    : [PYTHON, SCORE_SCRIPT, ...scriptArgs];
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    env,
    input: JSON.stringify(payload),
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function casePayload(evalFunction: string, answer: string, responseRaw: string, id = 'score-case-1'): ScorePayload {
  return {
    question: {
      id,
      question: 'What is the correct answer?',
      question_type: 'static-environment',
      answer,
      eval_function: evalFunction,
    },
    responseRaw,
  };
}

test('scoring fails closed when the upstream checkout is not configured', () => {
  const payload = casePayload('mc_choice_match', 'A', '\\boxed{A}', 'no-upstream-case');
  const env = { ...process.env, LME_UPSTREAM: '' };
  const result = runScore(payload, { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /case_id=no-upstream-case/u);
  assert.match(result.stderr, /LME_UPSTREAM_NOT_CONFIGURED/u);
  assert.equal(result.stdout, '');
});

test('pinned upstream scorer handles correct, wrong, UNKNOWN, and malformed cases', { skip: UPSTREAM_NOT_CONFIGURED }, () => {
  const correct = runScore(casePayload('mc_choice_match', 'A', 'Reasoning. \\boxed{A}'));
  assert.equal(correct.status, 0, correct.stderr);
  assert.deepEqual(JSON.parse(correct.stdout), {
    id: 'score-case-1',
    score: true,
    evalName: 'mc_choice_match',
    parsedAnswer: 'A',
    isUnknown: false,
    semanticJudge: false,
    judgeUsage: { callCount: 0 },
  });

  const wrong = runScore(casePayload('mc_choice_match', 'A', '\\boxed{B}', 'wrong-case'));
  assert.equal(wrong.status, 0, wrong.stderr);
  assert.equal(JSON.parse(wrong.stdout).score, false);

  const unknown = runScore(casePayload('norm_phrase_set_match', 'unknown', '\\boxed{UNKNOWN}', 'unknown-case'));
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(JSON.parse(unknown.stdout).isUnknown, true);
  assert.equal(JSON.parse(unknown.stdout).score, false);

  const malformed = runScore(casePayload('mc_choice_match|bad-option', 'A', '\\boxed{A}', 'malformed-case'));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /case_id=malformed-case/u);
  assert.match(malformed.stderr, /EVALUATION_FAILED/u);
  assert.equal(malformed.stdout, '');
});

test('semantic preparation returns pinned metadata without a model call', { skip: UPSTREAM_NOT_CONFIGURED }, () => {
  const key = 'test-key-must-not-be-used';
  const abstention = runScore(
    casePayload('llm_abstention_checker', 'The premise is false.', 'Reasoning. \\boxed{UNKNOWN}', 'abstention-case'),
    {
      prepareSemantic: true,
      blockOpenAI: true,
      env: { OPENAI_API_KEY: key },
    },
  );
  assert.equal(abstention.status, 0, abstention.stderr);
  assert.deepEqual(JSON.parse(abstention.stdout), {
    id: 'abstention-case',
    evalName: 'llm_abstention_checker',
    parsedAnswer: 'UNKNOWN',
    isUnknown: true,
  });

  const gotchas = runScore(
    casePayload('llm_gotchas_checker', 'A key insight.', 'Reasoning. \\boxed{A key insight.}', 'gotchas-case'),
    {
      prepareSemantic: true,
      blockOpenAI: true,
      env: { OPENAI_API_KEY: key },
    },
  );
  assert.equal(gotchas.status, 0, gotchas.stderr);
  assert.deepEqual(JSON.parse(gotchas.stdout), {
    id: 'gotchas-case',
    evalName: 'llm_gotchas_checker',
    parsedAnswer: 'A key insight.',
    isUnknown: false,
  });
  assert.doesNotMatch(abstention.stderr + gotchas.stderr, /test-key-must-not-be-used/u);
});

test('semantic preparation rejects deterministic evaluators with the case ID', { skip: UPSTREAM_NOT_CONFIGURED }, () => {
  const result = runScore(casePayload('mc_choice_match', 'A', '\\boxed{A}', 'not-semantic-case'), {
    prepareSemantic: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /case_id=not-semantic-case/u);
  assert.match(result.stderr, /SEMANTIC_EVALUATOR_REQUIRED/u);
  assert.equal(result.stdout, '');
});

test('direct semantic execution returns a stable error without an API call', { skip: UPSTREAM_NOT_CONFIGURED }, () => {
  const key = 'test-key-must-not-be-used';
  const result = runScore(
    casePayload('llm_gotchas_checker', 'The saved order was incorrect.', 'The order was incorrect. \\boxed{The order was incorrect.}', 'semantic-case'),
    {
      execute: true,
      evaluatorModel: 'gpt-4.1',
      blockOpenAI: true,
      env: { OPENAI_API_KEY: key },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /case_id=semantic-case/u);
  assert.match(result.stderr, /SEMANTIC_RUNNER_REQUIRED/u);
  assert.doesNotMatch(result.stderr, /test-key-must-not-be-used/u);
  assert.equal(result.stdout, '');
});
