import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonObject = Record<string, unknown>;

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex < 0 ? '' : (args[promptIndex + 1] ?? '');

writeFileSync(join(process.cwd(), 'fake-pi.capture.json'), JSON.stringify({
  args,
  agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
}));

const print = (events: JsonObject[]): void => {
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
};

const sessionEvent: JsonObject = { type: 'session', id: 'fake-session' };
const answerEvent: JsonObject = {
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }] },
};
const settledEvent: JsonObject = { type: 'agent_settled' };
const okEvents = [sessionEvent, answerEvent, settledEvent];

const recordStart: JsonObject = {
  type: 'tool_execution_start',
  toolCallId: 'call-1',
  toolName: 'pi_context',
  args: { action: 'record' },
};
const recordEnd = (result: JsonObject): JsonObject => ({
  type: 'tool_execution_end',
  toolCallId: 'call-1',
  toolName: 'pi_context',
  result,
  isError: false,
});
const evidenceStart: JsonObject = {
  type: 'tool_execution_start',
  toolCallId: 'evidence-call',
  toolName: 'pi_context',
  args: { action: 'search', query: 'fixture query' },
};
const evidenceEnd: JsonObject = {
  type: 'tool_execution_end',
  toolCallId: 'evidence-call',
  toolName: 'pi_context',
  result: { text: 'fixture result' },
  isError: true,
};

if (prompt === 'fixture:ok') {
  print(okEvents);
} else if (prompt === 'fixture:record') {
  print([recordStart, recordEnd({ details: { ok: true, action: 'record', data: {} } }), ...okEvents]);
} else if (prompt === 'fixture:record-timeout') {
  print([recordStart, recordEnd({ details: { ok: true, action: 'record', data: {} } }), answerEvent]);
  setInterval(() => {}, 1000);
} else if (prompt === 'fixture:record-exit-error') {
  print([recordStart, recordEnd({ details: { ok: true, action: 'record', data: {} } }), answerEvent]);
  process.exitCode = 1;
} else if (prompt === 'fixture:record-malformed') {
  print([recordStart, recordEnd({ details: { ok: true, action: 'record', data: {} } }), answerEvent]);
  process.stdout.write('{bad}\n');
} else if (prompt === 'fixture:record-failure') {
  print([recordStart, recordEnd({ isError: true, details: { ok: false, action: 'record' } }), ...okEvents]);
} else if (prompt === 'fixture:tool-evidence') {
  print([evidenceStart, { type: 'tool_execution_start', toolCallId: 'other', toolName: 'other_tool' }, evidenceEnd, {
    type: 'tool_execution_end',
    toolCallId: 'result-only',
    toolName: 'pi_context',
    result: { text: 'result without request' },
  }, ...okEvents]);
} else if (prompt === 'fixture:unmatched-tool-start') {
  print([evidenceStart, ...okEvents]);
} else if (prompt === 'fixture:timeout') {
  print([evidenceStart]);
  setInterval(() => {}, 1000);
} else if (prompt === 'fixture:malformed') {
  print([evidenceStart]);
  process.stdout.write('{not-json}\n');
} else if (prompt === 'fixture:exit-error') {
  print(okEvents);
  process.exitCode = 1;
} else if (prompt === 'fixture:unsettled') {
  print([sessionEvent, answerEvent]);
} else if (prompt === 'fixture:partial-final-line') {
  process.stdout.write([...okEvents].map((event) => JSON.stringify(event)).join('\n'));
} else if (prompt === 'fixture:overflow') {
  process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));
  setInterval(() => {}, 1000);
} else {
  throw new Error(`Unknown fixture prompt: ${prompt}`);
}
