import { appendFileSync, existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CASES, allFacts } from '../../scripts/eval-recall/corpus.ts';

type JsonObject = Record<string, unknown>;

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex < 0 ? '' : (args[promptIndex + 1] ?? '');
const arm = args.includes('-e') ? 'extension' : 'control';
const agentDir = process.env.PI_CODING_AGENT_DIR ?? '';
const storePath = join(agentDir, 'fake-store.json');

const readStore = (): string[] =>
  existsSync(storePath) ? (JSON.parse(readFileSync(storePath, 'utf8')) as string[]) : [];

const isSeed = prompt.startsWith('Project update:');
const seedEntry = isSeed ? allFacts().find((entry) => prompt.includes(entry.fact.text)) : undefined;
const evalCase = isSeed ? undefined : CASES.find((candidate) => prompt.includes(candidate.question));

let authLinkTarget: string | null = null;
try {
  authLinkTarget = readlinkSync(join(agentDir, 'auth.json'));
} catch {
  authLinkTarget = null;
}
const callLine = `${JSON.stringify({
  kind: isSeed ? 'seed' : 'question',
  arm,
  id: isSeed ? (seedEntry?.fact.id ?? null) : (evalCase?.id ?? null),
  agentDir,
  cwd: process.cwd(),
  authLinkTarget,
})}\n`;
appendFileSync(join(agentDir, 'fake-calls.jsonl'), callLine);
if (process.env.FAKE_CALLS_DIR !== undefined) {
  appendFileSync(join(process.env.FAKE_CALLS_DIR, 'fake-calls.jsonl'), callLine);
}

const events: JsonObject[] = [{ type: 'session', id: 'fake-session' }];

if (isSeed && process.env.FAKE_HANG_FACT_ID !== undefined && seedEntry?.fact.id === process.env.FAKE_HANG_FACT_ID) {
  events.push({
    type: 'tool_execution_start',
    toolCallId: 'hang-call',
    toolName: 'pi_context',
    args: { action: 'search', query: 'fixture hang' },
  });
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  setInterval(() => {}, 1000);
} else {
  let answer = "I don't know.";
  if (isSeed) {
    answer = 'Noted.';
    const skipped = (process.env.FAKE_RECORD_SKIP_FACT_IDS ?? '').split(',');
    if (arm === 'extension' && seedEntry !== undefined && !skipped.includes(seedEntry.fact.id)) {
      writeFileSync(storePath, JSON.stringify([...readStore(), seedEntry.fact.id]));
      events.push(
        { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'pi_context', args: { action: 'record' } },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'pi_context',
          result: { details: { ok: true, action: 'record', data: {} } },
          isError: false,
        },
      );
    }
  } else {
    if (arm === 'extension' && evalCase !== undefined) {
      events.push({
        type: 'tool_execution_start',
        toolCallId: `question-${evalCase.id}`,
        toolName: 'pi_context',
        args: { action: 'search', query: evalCase.question },
      });
    }
    if (arm === 'extension' && evalCase !== undefined && (evalCase.type === 'present' || evalCase.type === 'superseded')) {
      const stored = readStore();
      const storedFacts = evalCase.facts.filter((fact) => stored.includes(fact.id));
      if (storedFacts.length > 0) answer = storedFacts[storedFacts.length - 1].text;
    }
    if (arm === 'extension' && evalCase !== undefined) {
      events.push({
        type: 'tool_execution_end',
        toolCallId: `question-${evalCase.id}`,
        toolName: 'pi_context',
        result: { details: { ok: true, action: 'search', data: { query: evalCase.question } } },
        isError: false,
      });
    }
  }

  if (!isSeed && prompt.includes('Return only a JSON object')) {
    const context = evalCase?.facts.filter(fact => fact.stage === 'base').map(fact => fact.text).join(' ') ?? '';
    answer = JSON.stringify({ answer: answer === "I don't know." ? null : answer, context });
  }
  if (isSeed && seedEntry?.fact.id === process.env.FAKE_RECORD_HANG_FACT_ID) {
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
    setInterval(() => {}, 1000);
  } else {
    events.push(
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } },
      { type: 'agent_settled' },
    );
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}
