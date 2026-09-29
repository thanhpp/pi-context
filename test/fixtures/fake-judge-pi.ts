import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonObject = Record<string, unknown>;

const [scenario = 'valid', ...args] = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

writeFileSync(join(process.cwd(), 'fake-judge-pi.capture.json'), JSON.stringify({
  args,
  cwd: process.cwd(),
  piCodingAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,
  openAiApiKeySet: typeof process.env.OPENAI_API_KEY === 'string',
}));

if (scenario === 'timeout') {
  setInterval(() => process.stdout.write('waiting\n'), 1_000);
} else if (scenario === 'auth-failure') {
  process.stderr.write('Authentication required: login is missing.\n');
  process.exitCode = 1;
} else if (scenario === 'model-failure') {
  process.stderr.write('The requested model is unavailable.\n');
  process.exitCode = 1;
} else if (scenario === 'process-failure') {
  process.stderr.write('Fake process failure.\n');
  process.exitCode = 1;
} else if (scenario === 'oversized-output') {
  process.stdout.write('x'.repeat(1024 * 1024 + 128));
} else if (scenario === 'malformed-jsonl') {
  process.stdout.write('{not-json}\n');
} else {
  const message: JsonObject = {
    role: 'assistant',
    provider: 'openai-codex',
    model: scenario === 'model-mismatch' ? 'wrong-model' : 'gpt-6-sol',
    responseModel: scenario === 'missing-response-model' ? '' : 'gpt-6-sol',
    stopReason: scenario === 'assistant-error' ? 'error' : 'stop',
    content: [{
      type: 'text',
      text: scenario === 'invalid-output'
        ? 'The judge did not return a binary decision.'
        : scenario === 'nonbinary-output'
          ? '{"label":2,"reason":"invalid"}'
          : scenario === 'unknown-answer'
            ? '{"label":1,"reason":"valid judgment"}'
            : '```json\n{"label":"1","reason":"valid judgment"}\n```',
    }],
  };
  const events: JsonObject[] = [{ type: 'session', id: 'fake-judge-session' }];
  events.push({ type: 'message_end', message });
  if (scenario === 'multiple-assistants') events.push({ type: 'message_end', message });
  if (scenario !== 'not-settled') events.push({ type: 'agent_settled' });
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}

const systemPrompt = valueAfter('--system-prompt');
const userPrompt = valueAfter('-p');
if (systemPrompt === undefined || userPrompt === undefined) {
  throw new Error('The fake judge requires system and user prompts.');
}
