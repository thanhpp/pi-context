import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

type Event = Record<string, unknown>;

const args = process.argv.slice(2);
const valueAfter = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const sessionFile = valueAfter('--session');
const prompt = valueAfter('-p') ?? '';
const model = valueAfter('--model') ?? 'gpt-6-luna';
if (!sessionFile) throw new Error('The fake Pi process needs --session.');

writeFileSync(`${sessionFile}.argv.json`, JSON.stringify({ args, cwd: process.cwd() }));
writeFileSync(sessionFile, `${basename(sessionFile)}\n`);

if (prompt === 'fixture:timeout') {
  setInterval(() => process.stdout.write('waiting\n'), 1_000);
} else if (prompt === 'fixture:overflow') {
  for (let index = 0; index < 128; index += 1) process.stdout.write('x'.repeat(16 * 1024));
} else if (prompt === 'fixture:malformed') {
  process.stdout.write('{not-json}\n');
} else {
  const events: Event[] = [
    { type: 'session', id: basename(sessionFile) },
  ];
  if (prompt === 'fixture:cumulative-usage') {
    events.push({
      type: 'message_update',
      message: { role: 'assistant', usage: { input: 900, output: 900, totalTokens: 1800, cost: { total: 50 } } },
    });
  }
  if (prompt === 'fixture:project-not-configured') {
    events.push({ type: 'extension_status', errorCode: 'PROJECT_NOT_CONFIGURED' });
  }
  if (prompt === 'fixture:guidance-conflict') {
    events.push({ type: 'extension_status', guidanceErrorCode: 'GUIDANCE_CONFLICT' });
  }
  if (prompt === 'fixture:control-call' || args.includes('--tools')) {
    const failure = prompt === 'fixture:tool-error';
    const details: Record<string, unknown> = failure
      ? { ok: false, action: 'search', code: 'QUOTA_EXCEEDED' }
      : {
        ok: true,
        action: 'search',
        data: { results: [] },
        usage: {
          input: 2,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { total: 0.004 },
        },
      };
    events.push(
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'pi_context', args: { action: 'search' } },
      {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'pi_context',
        result: { isError: failure, details },
      },
    );
  }
  const errorResult = prompt === 'fixture:exit-zero-error';
  const missingUsage = prompt === 'fixture:no-usage';
  const mismatch = prompt === 'fixture:model-mismatch';
  const message: Record<string, unknown> = {
    id: 'assistant-1',
    role: 'assistant',
    provider: mismatch ? 'other-provider' : 'openai-codex',
    model: mismatch ? 'wrong-model' : model,
    responseModel: mismatch ? 'wrong-model' : model,
    stopReason: errorResult ? 'error' : 'stop',
    content: [{ type: 'text', text: 'The answer from the fake Pi process.' }],
  };
  if (prompt === 'fixture:tool-description-codes') {
    message.sections = { pi_context: 'Possible tool errors: QUOTA_EXCEEDED, PROJECT_NOT_CONFIGURED, GUIDANCE_CONFLICT.' };
  }
  if (!missingUsage) {
    message.usage = {
      input: 5,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { total: 0.1 },
    };
  }
  events.push({ type: 'message_end', message }, { type: 'agent_settled' });
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}
