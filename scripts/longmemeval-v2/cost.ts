import type { UsageTotals } from './pi.ts';

const PREFLIGHT_ASSUMPTIONS = [
  'Rough estimate: rendered UTF-8 history bytes divided by four gives input tokens; this is not a firm maximum.',
  'Rough estimate: each Pi session uses 1,024 input overhead tokens and 512 output tokens; this is not a firm maximum.',
  'Rough estimate: each supplied semantic judge call uses 1,024 input tokens and 256 output tokens; this is not a firm maximum.',
  'Rough estimate: preflight treats Pi input as uncached input; this is not a firm maximum.',
  'One Pi session per question is assigned to question cost; remaining sessions are assigned to ingestion cost.',
  'Session allocation is a rough bookkeeping split, not a measured usage ledger.',
] as const;

export interface ModelRates {
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  cacheReadUsdPerMillionTokens: number | null;
  cacheWriteUsdPerMillionTokens: number | null;
  judgeInputUsdPerMillionTokens?: number | null;
  judgeOutputUsdPerMillionTokens?: number | null;
}

export interface CostLine {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  usd: number | null;
  reason: string | null;
}

export interface JudgeCostLine {
  callCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usd: number | null;
  reason: string | null;
}

export interface CostEstimate {
  /** Total USD estimate. It is null when any included cost is unknown. */
  usd: number | null;
  reason: string | null;
  /** Rate-based estimate for measured or preflight Pi usage. */
  estimatedPiUsd: number | null;
  /** Pi-reported USD. This value is never used as a rate-based estimate. */
  reportedPiUsd: number | null;
  /** Measured usage is present for estimateCost and null for preflight estimates. */
  usage: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens'> | null;
  /** Null means UsageTotals did not identify ingestion and question usage separately. */
  ingestion: CostLine | null;
  /** Null means UsageTotals did not identify ingestion and question usage separately. */
  question: CostLine | null;
  /** The semantic judge does not expose a complete billable usage ledger. */
  judge: JudgeCostLine;
  assumptions: string[];
}

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

type ModelRateField = keyof Pick<
  ModelRates,
  'inputUsdPerMillionTokens' | 'outputUsdPerMillionTokens' |
  'cacheReadUsdPerMillionTokens' | 'cacheWriteUsdPerMillionTokens'
>;

function requireCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`INVALID_${name.toUpperCase()}`);
}

function validateRates(rates: ModelRates | null): void {
  if (rates === null) return;
  const fields: Array<keyof ModelRates> = [
    'inputUsdPerMillionTokens',
    'outputUsdPerMillionTokens',
    'cacheReadUsdPerMillionTokens',
    'cacheWriteUsdPerMillionTokens',
    'judgeInputUsdPerMillionTokens',
    'judgeOutputUsdPerMillionTokens',
  ];
  for (const field of fields) {
    const value = rates[field];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new RangeError(`INVALID_RATE: ${field}`);
    }
  }
}

function lineFromTokens(tokens: TokenCounts): CostLine {
  requireCount(tokens.inputTokens, 'input_tokens');
  requireCount(tokens.outputTokens, 'output_tokens');
  requireCount(tokens.cacheReadTokens, 'cache_read_tokens');
  requireCount(tokens.cacheWriteTokens, 'cache_write_tokens');
  const totalTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  requireCount(totalTokens, 'total_tokens');
  return { ...tokens, totalTokens, usd: null, reason: null };
}

function rateCost(
  counts: Record<string, number | null>,
  rates: ModelRates | null,
  fields: Record<string, ModelRateField>,
  label: string,
): { usd: number | null; reason: string | null } {
  const missing: string[] = [];
  let usd = 0;
  for (const [countName, rateName] of Object.entries(fields)) {
    const tokens = counts[countName] ?? 0;
    if (tokens === 0) continue;
    const rate = rates?.[rateName];
    if (rate === undefined || rate === null) {
      missing.push(countName.replace(/Tokens$/u, ''));
      continue;
    }
    usd += tokens * rate / 1_000_000;
  }
  if (missing.length > 0) {
    const reason = rates === null
      ? `${label} rates are unavailable for measured token usage.`
      : `Missing ${label} rate(s) for ${missing.join(', ')} token usage.`;
    return { usd: null, reason };
  }
  return { usd, reason: null };
}

const PI_RATE_FIELDS: Record<string, ModelRateField> = {
  inputTokens: 'inputUsdPerMillionTokens',
  outputTokens: 'outputUsdPerMillionTokens',
  cacheReadTokens: 'cacheReadUsdPerMillionTokens',
  cacheWriteTokens: 'cacheWriteUsdPerMillionTokens',
};

function priceLine(line: CostLine, rates: ModelRates | null): CostLine {
  const priced = rateCost({
    inputTokens: line.inputTokens,
    outputTokens: line.outputTokens,
    cacheReadTokens: line.cacheReadTokens,
    cacheWriteTokens: line.cacheWriteTokens,
  }, rates, PI_RATE_FIELDS, 'Model');
  return { ...line, usd: priced.usd, reason: priced.reason };
}

function combineUsd(values: Array<number | null>, subject: string): { usd: number | null; reason: string | null } {
  if (values.some(value => value === null)) return { usd: null, reason: `${subject} includes cost components with unknown USD.` };
  return { usd: values.reduce<number>((sum, value) => sum + (value ?? 0), 0), reason: null };
}

function emptyJudge(reason: string): JudgeCostLine {
  return { callCount: null, inputTokens: null, outputTokens: null, usd: null, reason };
}

function priceJudge(
  callCount: number | null,
  rates: ModelRates | null,
  modeledUsage: boolean,
): JudgeCostLine {
  if (callCount === null) {
    return emptyJudge(
      modeledUsage
        ? 'The semantic judge call count was not supplied.'
        : 'The upstream semantic checker does not expose judge token usage.',
    );
  }
  requireCount(callCount, 'judge_call_count');
  if (callCount === 0) return { callCount, inputTokens: 0, outputTokens: 0, usd: 0, reason: null };

  const inputTokens = callCount * 1_024;
  const outputTokens = callCount * 256;
  requireCount(inputTokens, 'judge_input_tokens');
  requireCount(outputTokens, 'judge_output_tokens');
  const missing: string[] = [];
  let usd = 0;
  const inputRate = rates?.judgeInputUsdPerMillionTokens;
  const outputRate = rates?.judgeOutputUsdPerMillionTokens;
  if (inputRate === undefined || inputRate === null) missing.push('input');
  else usd += inputTokens * inputRate / 1_000_000;
  if (outputRate === undefined || outputRate === null) missing.push('output');
  else usd += outputTokens * outputRate / 1_000_000;
  if (missing.length > 0) {
    const reason = rates === null
      ? 'Judge rates are unavailable for the estimated judge token usage.'
      : `Missing judge ${missing.join(' and ')} rate(s).`;
    return { callCount, inputTokens, outputTokens, usd: null, reason };
  }
  return { callCount, inputTokens, outputTokens, usd, reason: null };
}

function validateUsage(usage: UsageTotals): Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens'> {
  requireCount(usage.input, 'input_tokens');
  requireCount(usage.output, 'output_tokens');
  requireCount(usage.cacheRead, 'cache_read_tokens');
  requireCount(usage.cacheWrite, 'cache_write_tokens');
  requireCount(usage.totalTokens, 'total_tokens');
  if (usage.reportedUsd !== null && (!Number.isFinite(usage.reportedUsd) || usage.reportedUsd < 0)) {
    throw new RangeError('INVALID_REPORTED_PI_USD');
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

export function estimateCost(usage: UsageTotals | null, rates: ModelRates | null): CostEstimate {
  validateRates(rates);
  const judge = emptyJudge('The upstream semantic checker does not expose judge token usage.');
  if (usage === null) {
    return {
      usd: null,
      reason: 'Pi usage is unavailable; usage-based USD cannot be estimated.',
      estimatedPiUsd: null,
      reportedPiUsd: null,
      usage: null,
      ingestion: null,
      question: null,
      judge,
      assumptions: [],
    };
  }

  const measured = validateUsage(usage);
  const line = priceLine(lineFromTokens({
    inputTokens: measured.input,
    outputTokens: measured.output,
    cacheReadTokens: measured.cacheRead,
    cacheWriteTokens: measured.cacheWrite,
  }), rates);
  const judgeTotal = combineUsd([line.usd, judge.usd], 'Total estimate');
  const reasons = [line.reason, judge.reason, judgeTotal.reason]
    .filter((reason): reason is string => reason !== null);
  return {
    usd: judgeTotal.usd,
    reason: reasons.length > 0 ? [...new Set(reasons)].join(' ') : null,
    estimatedPiUsd: line.usd,
    reportedPiUsd: usage.reportedUsd,
    usage: measured,
    ingestion: null,
    question: null,
    judge,
    assumptions: [],
  };
}

export function estimatePreflight(input: {
  historyBytes: number;
  questionCount: number;
  sessionCount: number;
  rates: ModelRates | null;
  judgeCallCount?: number | null;
}): CostEstimate {
  requireCount(input.historyBytes, 'history_bytes');
  requireCount(input.questionCount, 'question_count');
  requireCount(input.sessionCount, 'session_count');
  validateRates(input.rates);

  const questionSessions = Math.min(input.questionCount, input.sessionCount);
  const ingestionSessions = input.sessionCount - questionSessions;
  const ingestion = priceLine(lineFromTokens({
    inputTokens: Math.ceil(input.historyBytes / 4) + ingestionSessions * 1_024,
    outputTokens: ingestionSessions * 512,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }), input.rates);
  const question = priceLine(lineFromTokens({
    inputTokens: questionSessions * 1_024,
    outputTokens: questionSessions * 512,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }), input.rates);
  const estimatedPi = combineUsd([ingestion.usd, question.usd], 'Pi estimate');
  const judge = priceJudge(input.judgeCallCount ?? null, input.rates, true);
  const total = combineUsd([estimatedPi.usd, judge.usd], 'Total estimate');
  const reasons = [ingestion.reason, question.reason, judge.reason, total.reason]
    .filter((reason): reason is string => reason !== null);

  return {
    usd: total.usd,
    reason: reasons.length > 0 ? [...new Set(reasons)].join(' ') : null,
    estimatedPiUsd: estimatedPi.usd,
    reportedPiUsd: null,
    usage: null,
    ingestion,
    question,
    judge,
    assumptions: [...PREFLIGHT_ASSUMPTIONS],
  };
}
