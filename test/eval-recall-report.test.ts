import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CaseType } from '../scripts/eval-recall/corpus.ts';
import type { Arm, CallStatus } from '../scripts/eval-recall/pi.ts';
import { formatReport, type QuestionOutcome, type SeedOutcome } from '../scripts/eval-recall/report.ts';

const ALL_TYPES: CaseType[] = ['present', 'superseded', 'absent', 'adjacent'];

function outcomes(
  runIndex: number,
  arm: Arm,
  caseType: CaseType,
  hits: readonly boolean[],
  status: CallStatus = 'ok',
): QuestionOutcome[] {
  return hits.map((hit, index) => ({ runIndex, arm, caseId: `${caseType}-${index}`, caseType, hit, status }));
}

function seeds(kind: SeedOutcome['kind'], recorded: readonly boolean[], status: CallStatus = 'ok'): SeedOutcome[] {
  return recorded.map((flag, index) => ({ runIndex: 1, factId: `${kind}-${index}`, kind, recorded: flag, status }));
}

const rowOf = (report: string, name: string): string => {
  const row = report.split('\n').find((line) => line.startsWith(name));
  assert.ok(row, `row ${name} exists`);
  return row;
};

const cellsOf = (row: string): string[] => row.trim().split(/ {2,}/);

test('extension always hits and control never hits over 2 runs', () => {
  const questions = [1, 2].flatMap((runIndex) =>
    ALL_TYPES.flatMap((caseType) => [
      ...outcomes(runIndex, 'extension', caseType, Array(6).fill(true)),
      ...outcomes(runIndex, 'control', caseType, Array(6).fill(false)),
    ]));
  const report = formatReport({ model: 'm/x', runs: 2, questions, seeds: [] });
  assert.deepEqual(cellsOf(rowOf(report, 'present')), [
    'present', '12/12 (100%)', '0/12 (0%)', '+100 pp', '100%-100%', '0%-0%',
  ]);
  assert.deepEqual(cellsOf(rowOf(report, 'total')), [
    'total', '48/48 (100%)', '0/48 (0%)', '+100 pp', '100%-100%', '0%-0%',
  ]);
});

test('extension rate and range over runs with different rates', () => {
  const questions = [
    ...outcomes(1, 'extension', 'present', Array(6).fill(true)),
    ...outcomes(2, 'extension', 'present', [true, true, true, false, false, false]),
  ];
  const cells = cellsOf(rowOf(formatReport({ model: 'm/x', runs: 2, questions, seeds: [] }), 'present'));
  assert.equal(cells[1], '9/12 (75%)');
  assert.equal(cells[2], 'n/a');
  assert.equal(cells[3], 'n/a');
  assert.equal(cells[4], '50%-100%');
});

test('difference is negative when control is higher and zero when equal', () => {
  const lower = [
    ...outcomes(1, 'extension', 'absent', [true, false, false, false]),
    ...outcomes(1, 'control', 'absent', [true, true, false, false]),
  ];
  assert.equal(cellsOf(rowOf(formatReport({ model: 'm/x', runs: 1, questions: lower, seeds: [] }), 'absent'))[3], '-25 pp');
  const equal = [
    ...outcomes(1, 'extension', 'absent', [true, false]),
    ...outcomes(1, 'control', 'absent', [false, true]),
  ];
  assert.equal(cellsOf(rowOf(formatReport({ model: 'm/x', runs: 1, questions: equal, seeds: [] }), 'absent'))[3], '0 pp');
});

test('case type without outcomes shows n/a in every cell', () => {
  const questions = outcomes(1, 'extension', 'present', [true]);
  const report = formatReport({ model: 'm/x', runs: 1, questions, seeds: [] });
  assert.deepEqual(cellsOf(rowOf(report, 'adjacent')), ['adjacent', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a']);
});

test('seed record rate separates question facts from distractors', () => {
  const report = formatReport({
    model: 'm/x',
    runs: 1,
    questions: [],
    seeds: [...seeds('question', [true, true, false]), ...seeds('distractor', [true, false])],
  });
  assert.ok(report.split('\n').includes(
    'seed record rate: question facts 2/3 (67%), distractor facts 1/2 (50%)',
  ));
});

test('timeouts and failures are counted per arm and for seeds', () => {
  const questions = [
    ...outcomes(1, 'extension', 'present', [false], 'timeout'),
    ...outcomes(1, 'extension', 'absent', [false, false], 'failed'),
    ...outcomes(1, 'control', 'absent', [false], 'failed'),
  ];
  const report = formatReport({ model: 'm/x', runs: 1, questions, seeds: seeds('question', [false], 'timeout') });
  const lines = report.split('\n');
  assert.ok(lines.includes('extension answers: 1 timeouts, 2 failures; seed sessions: 1 timeouts, 0 failures'));
  assert.ok(lines.includes('control answers: 0 timeouts, 1 failures'));
});

test('report separates total outcomes, completed calls, and commits before timeouts', () => {
  const questions = [
    ...outcomes(1, 'extension', 'present', [true]),
    ...outcomes(1, 'extension', 'present', [false], 'timeout'),
    ...outcomes(1, 'control', 'present', [false]),
  ];
  const report = formatReport({ model: 'm/x', runs: 1, scoringVersion: 'answer-v2', questions,
    seeds: seeds('question', [true], 'timeout') });
  assert.match(report, /scoring: answer-v2/u);
  assert.ok(report.includes('seed commits before unsuccessful exit: 1'));
  assert.ok(report.includes('completed-call hit rate: extension 1/1 (100%), control 0/1 (0%)'));
  assert.equal(cellsOf(rowOf(report, 'present'))[1], '1/2 (50%)');
});

test('header lines, blank line and no trailing line feed', () => {
  const report = formatReport({ model: 'openai-codex/x', runs: 3, questions: [], seeds: [] });
  const lines = report.split('\n');
  assert.equal(lines[0], 'pi-context recall eval');
  assert.equal(lines[1], 'model: openai-codex/x');
  assert.equal(lines[2], 'runs: 3');
  assert.equal(lines[3], '');
  assert.deepEqual(cellsOf(lines[4]), [
    'case type', 'extension', 'control', 'difference', 'extension range', 'control range',
  ]);
  assert.equal(report.endsWith('\n'), false);
  for (const line of lines) assert.equal(line, line.trimEnd());
});
