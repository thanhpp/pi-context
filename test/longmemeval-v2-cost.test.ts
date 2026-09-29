import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateCost, estimatePreflight, type ModelRates } from '../scripts/longmemeval-v2/cost.ts';
import type { UsageTotals } from '../scripts/longmemeval-v2/pi.ts';

const knownRates: ModelRates = {
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 2,
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 1.5,
  judgeInputUsdPerMillionTokens: 3,
  judgeOutputUsdPerMillionTokens: 4,
};

function assertUsd(actual: number | null | undefined, expected: number): void {
  assert.ok(typeof actual === 'number');
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, received ${actual}`);
}

function usage(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    input: 1_000_000,
    output: 100_000,
    cacheRead: 200_000,
    cacheWrite: 50_000,
    totalTokens: 1_350_000,
    reportedUsd: 0.123,
    ...overrides,
  };
}

test('measured Pi rates and Pi-reported USD stay separate from unknown judge usage', () => {
  const result = estimateCost(usage(), knownRates);
  assertUsd(result.estimatedPiUsd, 1.375);
  assert.equal(result.reportedPiUsd, 0.123);
  assert.equal(result.usd, null);
  assert.match(result.reason ?? '', /judge token usage/u);
  assert.deepEqual(result.usage, {
    input: 1_000_000,
    output: 100_000,
    cacheRead: 200_000,
    cacheWrite: 50_000,
    totalTokens: 1_350_000,
  });
  assert.equal(result.judge.callCount, null);
  assert.equal(result.judge.inputTokens, null);
  assert.equal(result.judge.outputTokens, null);
  assert.equal(result.judge.usd, null);
  assert.match(result.judge.reason ?? '', /does not expose judge token usage/u);
  assert.equal(result.ingestion, null);
  assert.equal(result.question, null);
});

test('unknown rates and absent usage return null USD and preserve measured tokens', () => {
  const unpricedUsage = usage({ input: 25, output: 8, cacheRead: 4, cacheWrite: 0, totalTokens: 37 });
  const unpriced = estimateCost(unpricedUsage, null);
  assert.equal(unpriced.usd, null);
  assert.equal(unpriced.estimatedPiUsd, null);
  assert.equal(unpriced.reportedPiUsd, 0.123);
  assert.deepEqual(unpriced.usage, {
    input: 25,
    output: 8,
    cacheRead: 4,
    cacheWrite: 0,
    totalTokens: 37,
  });
  assert.match(unpriced.reason ?? '', /Model rates are unavailable/u);

  const noUsage = estimateCost(null, knownRates);
  assert.equal(noUsage.usd, null);
  assert.equal(noUsage.estimatedPiUsd, null);
  assert.equal(noUsage.usage, null);
  assert.equal(noUsage.reportedPiUsd, null);
  assert.match(noUsage.reason ?? '', /Pi usage is unavailable/u);
});

test('preflight reports ingestion, question, and semantic judge costs as separate lines', () => {
  const result = estimatePreflight({
    historyBytes: 400,
    questionCount: 2,
    sessionCount: 3,
    judgeCallCount: 1,
    rates: knownRates,
  });
  assert.equal(result.ingestion?.inputTokens, 1_124);
  assert.equal(result.ingestion?.outputTokens, 512);
  assertUsd(result.ingestion?.usd, 0.002148);
  assert.equal(result.question?.inputTokens, 2_048);
  assert.equal(result.question?.outputTokens, 1_024);
  assertUsd(result.question?.usd, 0.004096);
  assertUsd(result.estimatedPiUsd, 0.006244);
  assert.equal(result.judge.callCount, 1);
  assert.equal(result.judge.inputTokens, 1_024);
  assert.equal(result.judge.outputTokens, 256);
  assertUsd(result.judge.usd, 0.004096);
  assertUsd(result.usd, 0.01034);
  assert.equal(result.reason, null);
  assert.ok(result.assumptions.slice(0, 4).every(assumption => /Rough estimate/u.test(assumption)));
  assert.ok(result.assumptions.slice(0, 4).every(assumption => /not a firm maximum/u.test(assumption)));
  assert.ok(result.assumptions.some(assumption => /rough bookkeeping/u.test(assumption)));
  assert.ok(result.assumptions.some(assumption => /not a measured usage ledger/u.test(assumption)));
});

test('preflight leaves unknown judge prices and an unknown call count unpriced', () => {
  const ratesWithoutJudge: ModelRates = {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
    cacheReadUsdPerMillionTokens: null,
    cacheWriteUsdPerMillionTokens: null,
  };
  const result = estimatePreflight({
    historyBytes: 1_000,
    questionCount: 1,
    sessionCount: 2,
    rates: ratesWithoutJudge,
  });
  assertUsd(result.estimatedPiUsd, 0.004346);
  assert.equal(result.judge.callCount, null);
  assert.equal(result.judge.inputTokens, null);
  assert.equal(result.judge.outputTokens, null);
  assert.equal(result.judge.usd, null);
  assert.equal(result.usd, null);
  assert.match(result.judge.reason ?? '', /call count was not supplied/u);
  assert.match(result.reason ?? '', /unknown USD/u);

  const unpricedJudge = estimatePreflight({
    historyBytes: 1_000,
    questionCount: 1,
    sessionCount: 2,
    judgeCallCount: 1,
    rates: ratesWithoutJudge,
  });
  assert.equal(unpricedJudge.judge.callCount, 1);
  assert.equal(unpricedJudge.judge.inputTokens, 1_024);
  assert.equal(unpricedJudge.judge.outputTokens, 256);
  assert.equal(unpricedJudge.judge.usd, null);
  assert.equal(unpricedJudge.usd, null);
  assert.match(unpricedJudge.judge.reason ?? '', /Missing judge input and output rate/u);
});
