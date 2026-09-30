import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPiArguments,
  countSuccessfulRecords,
  killLivePiProcesses,
  parseSessionOutput,
  runPi,
  type Arm,
  type PiCallInput,
  type PiCallResult,
} from '../scripts/eval-recall/pi.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-pi-process.ts', import.meta.url));
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

const jsonLines = (...events: unknown[]): string => events.map((event) => `${JSON.stringify(event)}\n`).join('');
const answerEvent = (text: string) => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const recordStart = (toolName = 'pi_context') => ({
  type: 'tool_execution_start',
  toolCallId: 'c1',
  toolName,
  args: { action: 'record' },
});
const recordEnd = (result: unknown, isError: boolean) => ({
  type: 'tool_execution_end',
  toolCallId: 'c1',
  toolName: 'pi_context',
  result,
  isError,
});
const settled = { type: 'agent_settled' };

function baseInput(overrides: Partial<PiCallInput> = {}): PiCallInput {
  return {
    cwd: '/work',
    agentDir: '/agent',
    prompt: 'question',
    model: 'provider/model',
    arm: 'extension',
    extensionPath: '/ext/index.ts',
    timeoutMs: 10_000,
    ...overrides,
  };
}

async function withFixture<T>(
  prompt: string,
  arm: Arm,
  body: (input: PiCallInput, cwd: string, agentDir: string) => Promise<T>,
  overrides: Partial<PiCallInput> = {},
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'eval-recall-pi-cwd-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'eval-recall-pi-agent-'));
  try {
    return await body(baseInput({
      cwd,
      agentDir,
      prompt,
      arm,
      executable: process.execPath,
      executableArgs: ['--experimental-strip-types', fixturePath],
      ...overrides,
    }), cwd, agentDir);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function readCapture(cwd: string): Promise<{ args: string[]; agentDir: string | null }> {
  return JSON.parse(await readFile(join(cwd, 'fake-pi.capture.json'), 'utf8'));
}

function assertOutcome(result: PiCallResult, status: string, answer: string, recordCalls: number): void {
  assert.equal(result.status, status);
  assert.equal(result.answer, answer);
  assert.equal(result.recordCalls, recordCalls);
  assert.deepEqual(Object.keys(result.evidence).sort(), [
    'exitCode', 'malformedOutput', 'partialFinalLine', 'signal', 'spawnErrorCode', 'stdoutBytes',
    'stdoutLimited', 'toolCalls',
  ]);
  assert.ok(!JSON.stringify(result.evidence).includes('agentDir'));
}

test('buildPiArguments returns the exact arguments for the extension arm', () => {
  assert.deepEqual(buildPiArguments(baseInput({ arm: 'extension' })), [
    '-ne', '-ns', '-np', '-nc', '--offline', '--no-session', '--mode', 'json',
    '--model', 'provider/model', '-e', '/ext/index.ts', '--tools', 'pi_context', '-p', 'question',
  ]);
});

test('buildPiArguments returns the exact arguments for the control arm', () => {
  assert.deepEqual(buildPiArguments(baseInput({ arm: 'control' })), [
    '-ne', '-ns', '-np', '-nc', '--offline', '--no-session', '--mode', 'json',
    '--model', 'provider/model', '--no-tools', '-p', 'question',
  ]);
});

test('parseSessionOutput reads answer, settled flag and successful record calls', () => {
  const output = jsonLines(
    { type: 'session', id: 's' },
    recordStart(),
    recordEnd({ details: { ok: true, action: 'record', data: {} } }, false),
    answerEvent('first'),
    answerEvent('final answer'),
    settled,
  );
  assert.deepEqual(parseSessionOutput(output), {
    valid: true,
    settled: true,
    answer: 'final answer',
    recordCalls: 1,
    toolCalls: [{
      toolCallId: 'c1',
      args: { action: 'record' },
      result: { details: { ok: true, action: 'record', data: {} } },
      isError: false,
      completed: true,
    }],
    malformedOutput: false,
    partialFinalLine: false,
  });
});

test('parseSessionOutput keeps the last non-empty assistant text and joins blocks with a line feed', () => {
  const output = jsonLines(
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    },
    answerEvent('   '),
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'user text' }] } },
    settled,
  );
  assert.equal(parseSessionOutput(output).answer, 'a\nb');
});

test('parseSessionOutput accepts CRLF line endings', () => {
  const output = jsonLines(answerEvent('crlf'), settled).replaceAll('\n', '\r\n');
  const parsed = parseSessionOutput(output);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.answer, 'crlf');
  assert.equal(parsed.malformedOutput, false);
  assert.equal(parsed.partialFinalLine, false);
});

test('parseSessionOutput rejects empty text, malformed lines, non-object lines and empty lines', () => {
  const invalid = {
    valid: false,
    settled: false,
    answer: '',
    recordCalls: 0,
    toolCalls: [],
    malformedOutput: true,
    partialFinalLine: false,
  };
  assert.deepEqual(parseSessionOutput(''), invalid);
  assert.deepEqual(parseSessionOutput('{not-json}\n'), invalid);
  assert.deepEqual(parseSessionOutput('[1]\n'), invalid);
  assert.deepEqual(parseSessionOutput(`${JSON.stringify(answerEvent('x'))}\n\n${JSON.stringify(settled)}\n`), {
    ...invalid,
    settled: true,
    answer: 'x',
    toolCalls: [],
  });
});

test('parseSessionOutput keeps valid tool evidence around malformed lines', () => {
  const parsed = parseSessionOutput(`${jsonLines(recordStart(), recordEnd({ text: 'kept' }, true), settled)}{bad}\n`);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.settled, true);
  assert.equal(parsed.answer, '');
  assert.equal(parsed.recordCalls, 0);
  assert.equal(parsed.malformedOutput, true);
  assert.deepEqual(parsed.toolCalls, [{
    toolCallId: 'c1',
    args: { action: 'record' },
    result: { text: 'kept' },
    isError: true,
    completed: true,
  }]);
});

test('parseSessionOutput preserves successful records and answers before malformed output', () => {
  const parsed = parseSessionOutput(`${jsonLines(recordStart(), recordEnd({ details: { ok: true, action: 'record' } }, false), answerEvent('Observed answer.'))}{bad}\n`);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.recordCalls, 1);
  assert.equal(parsed.answer, 'Observed answer.');
  assert.equal(countSuccessfulRecords(parsed.toolCalls), 1);
});

test('parseSessionOutput counts correlated record results once and excludes unmatched results', () => {
  const end = recordEnd({ details: { ok: true, action: 'record' } }, false);
  const parsed = parseSessionOutput(jsonLines(recordStart(), end, end, { ...end, toolCallId: 'orphan' }));
  assert.equal(parsed.recordCalls, 1);
});

test('parseSessionOutput correlates tool events and keeps unmatched starts and result-only events', () => {
  const parsed = parseSessionOutput(jsonLines(
    { type: 'tool_execution_start', toolName: 'other', toolCallId: 'ignored' },
    { type: 'tool_execution_start', toolName: 'pi_context', toolCallId: 'open', args: { action: 'search' } },
    { type: 'tool_execution_end', toolName: 'pi_context', toolCallId: 'result-only', result: { text: 'only result' } },
    settled,
  ));
  assert.deepEqual(parsed.toolCalls, [
    { toolCallId: 'open', args: { action: 'search' }, completed: false },
    { toolCallId: 'result-only', result: { text: 'only result' }, completed: true },
  ]);
});

test('parseSessionOutput records an unterminated final line', () => {
  const parsed = parseSessionOutput(jsonLines(answerEvent('partial'), settled).trimEnd());
  assert.equal(parsed.valid, true);
  assert.equal(parsed.answer, 'partial');
  assert.equal(parsed.partialFinalLine, true);
});

test('parseSessionOutput does not count a record call with details.ok false', () => {
  const output = jsonLines(
    recordStart(),
    recordEnd({ isError: true, details: { ok: false, action: 'record' } }, false),
    settled,
  );
  assert.equal(parseSessionOutput(output).recordCalls, 0);
});

test('parseSessionOutput does not count a record call with top-level isError true', () => {
  const output = jsonLines(
    recordStart(),
    recordEnd({ details: { ok: true, action: 'record' } }, true),
    settled,
  );
  assert.equal(parseSessionOutput(output).recordCalls, 0);
});

test('parseSessionOutput does not count a record call for another tool', () => {
  const output = jsonLines(
    recordStart('other_tool'),
    recordEnd({ details: { ok: true, action: 'record' } }, false),
    settled,
  );
  assert.equal(parseSessionOutput(output).recordCalls, 0);
});

test('parseSessionOutput reports settled false without agent_settled', () => {
  const parsed = parseSessionOutput(jsonLines(answerEvent('x')));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.settled, false);
});

test('runPi replaces the parent PI_CODING_AGENT_DIR and passes extension arguments', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = '/parent/agent/dir';
  try {
    await withFixture('fixture:ok', 'extension', async (input, cwd, agentDir) => {
      const result = await runPi(input);
      assertOutcome(result, 'ok', 'fixture answer', 0);
      assert.equal(result.evidence.exitCode, 0);
      assert.equal(result.evidence.stdoutLimited, false);
      assert.equal(result.evidence.malformedOutput, false);
      assert.ok(result.evidence.stdoutBytes > 0);
      const capture = await readCapture(cwd);
      assert.equal(capture.agentDir, agentDir);
      assert.ok(capture.args.includes('-e'));
      assert.ok(capture.args.includes('pi_context'));
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('runPi passes the control arm arguments', async () => {
  await withFixture('fixture:ok', 'control', async (input, cwd) => {
    assertOutcome(await runPi(input), 'ok', 'fixture answer', 0);
    const capture = await readCapture(cwd);
    assert.ok(capture.args.includes('--no-tools'));
    assert.ok(!capture.args.includes('-e'));
  });
});

test('runPi counts a successful record call and stores call evidence', async () => {
  await withFixture('fixture:record', 'extension', async (input) => {
    const result = await runPi(input);
    assertOutcome(result, 'ok', 'fixture answer', 1);
    assert.deepEqual(result.evidence.toolCalls, [{
      toolCallId: 'call-1',
      args: { action: 'record' },
      result: { details: { ok: true, action: 'record', data: {} } },
      isError: false,
      completed: true,
    }]);
  });
});

test('runPi preserves tool request, result, error flag, result-only event and excludes other tools', async () => {
  await withFixture('fixture:tool-evidence', 'extension', async (input) => {
    const result = await runPi(input);
    assertOutcome(result, 'ok', 'fixture answer', 0);
    assert.deepEqual(result.evidence.toolCalls, [
      {
        toolCallId: 'evidence-call',
        args: { action: 'search', query: 'fixture query' },
        result: { text: 'fixture result' },
        isError: true,
        completed: true,
      },
      { toolCallId: 'result-only', result: { text: 'result without request' }, completed: true },
    ]);
  });
});

test('runPi keeps an unmatched tool request', async () => {
  await withFixture('fixture:unmatched-tool-start', 'extension', async (input) => {
    const result = await runPi(input);
    assertOutcome(result, 'ok', 'fixture answer', 0);
    assert.deepEqual(result.evidence.toolCalls, [{
      toolCallId: 'evidence-call',
      args: { action: 'search', query: 'fixture query' },
      completed: false,
    }]);
  });
});

test('runPi does not count a refused record call', async () => {
  await withFixture('fixture:record-failure', 'extension', async (input) => {
    const result = await runPi(input);
    assertOutcome(result, 'ok', 'fixture answer', 0);
    assert.equal(result.evidence.toolCalls[0]?.isError, false);
    assert.equal(result.evidence.toolCalls[0]?.completed, true);
  });
});

test('runPi reports timeout and keeps captured request evidence', async () => {
  await withFixture('fixture:timeout', 'extension', async (input) => {
    const result = await runPi(input);
    assertOutcome(result, 'timeout', '', 0);
    assert.equal(result.evidence.signal, 'SIGKILL');
    assert.deepEqual(result.evidence.toolCalls, [{
      toolCallId: 'evidence-call',
      args: { action: 'search', query: 'fixture query' },
      completed: false,
    }]);
    assert.ok(result.evidence.stdoutBytes > 0);
  }, { timeoutMs: 300 });
});

for (const scenario of ['fixture:malformed', 'fixture:exit-error', 'fixture:unsettled']) {
  test(`runPi reports failed for ${scenario}`, async () => {
    await withFixture(scenario, 'extension', async (input) => {
      const result = await runPi(input);
      assertOutcome(result, 'failed', scenario === 'fixture:malformed' ? '' : 'fixture answer', 0);
      if (scenario === 'fixture:malformed') {
        assert.equal(result.evidence.malformedOutput, true);
        assert.equal(result.evidence.toolCalls[0]?.completed, false);
      }
      if (scenario === 'fixture:exit-error') assert.equal(result.evidence.exitCode, 1);
    });
  });
}

for (const scenario of ['fixture:record-timeout', 'fixture:record-exit-error', 'fixture:record-malformed']) {
  test(`runPi preserves record results and answers for ${scenario}`, async () => {
    await withFixture(scenario, 'extension', async input => {
      const result = await runPi(input);
      assertOutcome(result, scenario === 'fixture:record-timeout' ? 'timeout' : 'failed', 'fixture answer', 1);
      assert.equal(result.evidence.toolCalls[0]?.completed, true);
      if (scenario === 'fixture:record-timeout') {
        assert.equal(result.evidence.signal, 'SIGKILL');
        assert.equal(result.evidence.exitCode, null);
      }
    }, { timeoutMs: 1000 });
  });
}

test('runPi reports partial final-line evidence without changing the answer', async () => {
  await withFixture('fixture:partial-final-line', 'extension', async (input) => {
    const result = await runPi(input);
    assertOutcome(result, 'ok', 'fixture answer', 0);
    assert.equal(result.evidence.partialFinalLine, true);
    assert.equal(result.evidence.malformedOutput, false);
  });
});

test('runPi limits captured stdout to 16 MiB and records overflow', async () => {
  await withFixture('fixture:overflow', 'extension', async (input) => {
    const result = await runPi(input);
    assertOutcome(result, 'failed', '', 0);
    assert.equal(result.evidence.stdoutBytes, MAX_STDOUT_BYTES);
    assert.equal(result.evidence.stdoutLimited, true);
    assert.equal(result.evidence.signal, 'SIGKILL');
  });
});

test('runPi reports failed when the executable does not exist', async () => {
  await withFixture('fixture:ok', 'extension', async (input) => {
    const result = await runPi({ ...input, executable: '/nonexistent/pi-binary', executableArgs: [] });
    assertOutcome(result, 'failed', '', 0);
    assert.equal(result.evidence.spawnErrorCode, 'ENOENT');
  });
});

test('killLivePiProcesses does not throw when no process is running', () => {
  assert.doesNotThrow(() => killLivePiProcesses());
});
