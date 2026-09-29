import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PiSessionError, runPiSession, type PiSessionInput } from '../scripts/longmemeval-v2/pi.ts';

const FAKE_PI = resolve('test/fixtures/fake-benchmark-pi.ts');
const PACKAGE_ROOT = resolve('.');

type Fixture = {
  root: string;
  workspace: string;
  runDirectory: string;
  input(name: string, overrides?: Partial<PiSessionInput>): PiSessionInput;
  captured(sessionFile: string): Promise<{ args: string[]; cwd: string }>;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'longmemeval-v2-pi-'));
  const workspace = join(root, 'workspace');
  const runDirectory = join(root, 'run');
  await mkdir(workspace);
  await mkdir(runDirectory);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  const fixture: Fixture = {
    root,
    workspace,
    runDirectory,
    input(name, overrides = {}) {
      const sessionFile = join(runDirectory, `${name}.session.jsonl`);
      return {
        cwd: workspace,
        sessionFile,
        stdoutPath: join(runDirectory, `${name}.stdout.jsonl`),
        stderrPath: join(runDirectory, `${name}.stderr.log`),
        prompt: 'question only',
        model: 'openai-codex/gpt-6-luna',
        thinking: 'medium',
        mode: 'control',
        extensionPath: PACKAGE_ROOT,
        timeoutMs: 5_000,
        maxStdoutBytes: 1024 * 1024,
        testOnlyExecutablePath: process.execPath,
        testOnlyExecutableArgs: ['--experimental-strip-types', FAKE_PI],
        ...overrides,
      };
    },
    async captured(sessionFile) {
      return JSON.parse(await readFile(`${sessionFile}.argv.json`, 'utf8')) as { args: string[]; cwd: string };
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

async function expectPiError(
  input: PiSessionInput,
  code: string,
): Promise<PiSessionError> {
  try {
    await runPiSession(input);
  } catch (error) {
    assert.ok(error instanceof PiSessionError);
    assert.equal(error.code, code);
    assert.equal(error.sessionFile, input.sessionFile);
    assert.ok(error.stage.length > 0);
    return error;
  }
  assert.fail(`Expected PiSessionError with code ${code}`);
}

test('the memory and control modes use isolated, restricted Pi arguments', async () => {
  await withFixture(async fixture => {
    const memoryInput = fixture.input('memory', {
      mode: 'memory',
      prompt: 'Store this history summary, then answer the question.',
    });
    const memoryResult = await runPiSession(memoryInput);
    const memoryCapture = await fixture.captured(memoryInput.sessionFile);
    const memoryArgs = memoryCapture.args;
    assert.equal(valueAfter(memoryArgs, '--mode'), 'json');
    assert.equal(valueAfter(memoryArgs, '--session'), memoryInput.sessionFile);
    assert.equal(valueAfter(memoryArgs, '--provider'), 'openai-codex');
    assert.equal(valueAfter(memoryArgs, '--model'), 'gpt-6-luna');
    assert.equal(valueAfter(memoryArgs, '--thinking'), 'medium');
    assert.equal(valueAfter(memoryArgs, '-e'), PACKAGE_ROOT);
    assert.equal(valueAfter(memoryArgs, '--tools'), 'pi_context');
    assert.ok(['-ne', '-ns', '-np', '-nc'].every(flag => memoryArgs.includes(flag)));
    assert.equal(valueAfter(memoryArgs, '-p'), memoryInput.prompt);
    assert.ok(!memoryArgs.includes('--no-tools'));
    assert.equal(memoryResult.toolActions.length, 1);
    assert.equal(memoryResult.toolActions[0]?.action, 'search');
    assert.equal(memoryResult.toolActions[0]?.valid, true);

    const controlInput = fixture.input('control', { mode: 'control', prompt: 'What is the answer?' });
    const controlResult = await runPiSession(controlInput);
    const controlCapture = await fixture.captured(controlInput.sessionFile);
    const controlArgs = controlCapture.args;
    assert.ok(controlArgs.includes('--no-tools'));
    assert.ok(!controlArgs.includes('-e'));
    assert.ok(!controlArgs.includes('--tools'));
    assert.equal(valueAfter(controlArgs, '-p'), controlInput.prompt);
    assert.deepEqual(controlResult.toolActions, []);
    assert.equal(controlCapture.cwd, memoryCapture.cwd);
    assert.equal(memoryCapture.cwd, fixture.workspace);

    assert.equal((await stat(fixture.runDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(memoryInput.stdoutPath)).mode & 0o777, 0o600);
    assert.equal((await stat(memoryInput.stderrPath)).mode & 0o777, 0o600);
  });
});

test('two fresh memory sessions share one Git workspace and do not copy history into the question', async () => {
  await withFixture(async fixture => {
    const historyInput = fixture.input('history', {
      mode: 'memory',
      prompt: 'History-only detail: Cedar station opened in 1998.',
    });
    const answerInput = fixture.input('answer', {
      mode: 'memory',
      prompt: 'In what year did Cedar station open?',
    });
    const history = await runPiSession(historyInput);
    const answer = await runPiSession(answerInput);
    const historyCapture = await fixture.captured(historyInput.sessionFile);
    const answerCapture = await fixture.captured(answerInput.sessionFile);
    assert.notEqual(history.session.sessionFile, answer.session.sessionFile);
    assert.notEqual(history.session.sessionId, answer.session.sessionId);
    assert.equal(historyCapture.cwd, fixture.workspace);
    assert.equal(answerCapture.cwd, fixture.workspace);
    assert.notEqual(valueAfter(historyCapture.args, '--session'), valueAfter(answerCapture.args, '--session'));
    assert.equal(valueAfter(answerCapture.args, '-p'), answerInput.prompt);
    assert.ok(!answerCapture.args.includes(historyInput.prompt));
    assert.ok(!answerCapture.args.includes('--continue'));
    assert.ok(!answerCapture.args.includes('-c'));
    assert.ok(await stat(historyInput.sessionFile));
    assert.ok(await stat(answerInput.sessionFile));
  });
});

test('final message usage is counted once and nested tool usage is added', async () => {
  await withFixture(async fixture => {
    const input = fixture.input('usage', { mode: 'memory', prompt: 'fixture:cumulative-usage' });
    const result = await runPiSession(input);
    assert.deepEqual({
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      totalTokens: result.usage.totalTokens,
    }, {
      input: 7,
      output: 4,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 11,
    });
    assert.ok(Math.abs((result.usage.reportedUsd ?? 0) - 0.104) < 1e-12);
  });
});

test('a zero exit code does not accept an assistant error result', async () => {
  await withFixture(async fixture => {
    const error = await expectPiError(
      fixture.input('assistant-error', { prompt: 'fixture:exit-zero-error' }),
      'ASSISTANT_ERROR',
    );
    assert.equal(error.evidence?.session.exitCode, 0);
    assert.equal(error.evidence?.session.settled, true);
  });
});

test('malformed JSONL fails with a session identifier', async () => {
  await withFixture(async fixture => {
    const input = fixture.input('malformed', { prompt: 'fixture:malformed' });
    const error = await expectPiError(input, 'JSONL_INVALID');
    assert.equal(error.stage, 'parse');
  });
});

test('stdout overflow is bounded and fails the session', async () => {
  await withFixture(async fixture => {
    const input = fixture.input('overflow', { prompt: 'fixture:overflow', maxStdoutBytes: 4096 });
    await expectPiError(input, 'STDOUT_LIMIT');
    assert.equal((await stat(input.stdoutPath)).size, 4096);
  });
});

test('wall-time timeout fails the session', async () => {
  await withFixture(async fixture => {
    const input = fixture.input('timeout', { prompt: 'fixture:timeout', timeoutMs: 100 });
    await expectPiError(input, 'SESSION_TIMEOUT');
  });
});

test('missing usage is reported as zero tokens and unknown USD', async () => {
  await withFixture(async fixture => {
    const result = await runPiSession(fixture.input('no-usage', { prompt: 'fixture:no-usage' }));
    assert.deepEqual(result.usage, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      reportedUsd: null,
    });
  });
});

test('control rejects a plugin call and memory rejects quota failures', async () => {
  await withFixture(async fixture => {
    const controlError = await expectPiError(
      fixture.input('control-call', { prompt: 'fixture:control-call', mode: 'control' }),
      'CONTROL_TOOL_CALL',
    );
    assert.deepEqual(controlError.evidence?.toolActions.map(action => action.callId), ['tool-1']);

    const memoryError = await expectPiError(
      fixture.input('tool-error', { prompt: 'fixture:tool-error', mode: 'memory' }),
      'QUOTA_EXCEEDED',
    );
    assert.equal(memoryError.evidence?.toolActions[0]?.valid, false);
    assert.ok(memoryError.evidence?.validationIssues.includes('PI_CONTEXT_ACTION_INVALID'));
  });
});

test('tool descriptions do not turn a successful memory action into a quota failure', async () => {
  await withFixture(async fixture => {
    const result = await runPiSession(fixture.input('description-codes', {
      prompt: 'fixture:tool-description-codes',
      mode: 'memory',
    }));
    assert.equal(result.toolActions[0]?.valid, true);
    assert.deepEqual(result.validationIssues, []);
  });
});

test('per-session environment overrides stay child-scoped and controls inherit the default environment', async () => {
  await withFixture(async fixture => {
    const captureScript = join(fixture.root, 'capture-env.mjs');
    await writeFile(captureScript, `
      import { writeFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      const value = flag => args[args.indexOf(flag) + 1];
      const session = value('--session');
      const model = value('--model');
      writeFileSync(session, 'test-session\\n', { mode: 0o600 });
      writeFileSync(session + '.agent.json', JSON.stringify({ agentDir: process.env.PI_CODING_AGENT_DIR ?? null }), { mode: 0o600 });
      const events = [
        { type: 'session', id: 'test-session' },
        { type: 'message_end', message: { id: 'answer', role: 'assistant', provider: 'openai-codex', model, responseModel: model, stopReason: 'stop', content: [{ type: 'text', text: '\\\\boxed{answer}' }] } },
        { type: 'agent_settled' },
      ];
      for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
    `);
    const previous = process.env.PI_CODING_AGENT_DIR;
    const privateAgentDir = join(fixture.root, 'run-agent');
    const memoryInput = fixture.input('scoped-memory', {
      mode: 'memory',
      env: { PI_CODING_AGENT_DIR: privateAgentDir },
      testOnlyExecutableArgs: [captureScript],
    });
    await runPiSession(memoryInput);
    const memoryEnv = JSON.parse(await readFile(`${memoryInput.sessionFile}.agent.json`, 'utf8')) as { agentDir: string | null };
    assert.equal(memoryEnv.agentDir, privateAgentDir);
    assert.equal(process.env.PI_CODING_AGENT_DIR, previous);

    const controlInput = fixture.input('scoped-control', {
      mode: 'control',
      testOnlyExecutableArgs: [captureScript],
    });
    await runPiSession(controlInput);
    const controlEnv = JSON.parse(await readFile(`${controlInput.sessionFile}.agent.json`, 'utf8')) as { agentDir: string | null };
    assert.equal(controlEnv.agentDir, previous ?? null);
    assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
  });
});

test('unconfigured project, guidance conflict, and model mismatch invalidate the run', async () => {
  await withFixture(async fixture => {
    const projectError = await expectPiError(
      fixture.input('project-disabled', { prompt: 'fixture:project-not-configured', mode: 'memory' }),
      'PROJECT_NOT_CONFIGURED',
    );
    assert.ok(projectError.evidence?.validationIssues.includes('PROJECT_NOT_CONFIGURED'));

    const guidanceError = await expectPiError(
      fixture.input('guidance-conflict', { prompt: 'fixture:guidance-conflict', mode: 'memory' }),
      'GUIDANCE_CONFLICT',
    );
    assert.ok(guidanceError.evidence?.validationIssues.includes('GUIDANCE_CONFLICT'));

    await expectPiError(
      fixture.input('wrong-model', { prompt: 'fixture:model-mismatch' }),
      'MODEL_MISMATCH',
    );
  });
});
