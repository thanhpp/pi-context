import type { CaseType } from './corpus.ts';
import type { Arm, CallStatus } from './pi.ts';
import type { ScoringVersion } from './score.ts';

export interface QuestionOutcome {
  runIndex: number;
  arm: Arm;
  caseId: string;
  caseType: CaseType;
  hit: boolean;
  status: CallStatus;
}
export interface SeedOutcome {
  runIndex: number;
  factId: string;
  kind: 'question' | 'distractor';
  recorded: boolean;
  status: CallStatus;
}
export interface ReportInput {
  model: string;
  runs: number;
  questions: readonly QuestionOutcome[];
  seeds: readonly SeedOutcome[];
  scoringVersion?: ScoringVersion;
}

const CASE_TYPE_ROWS: readonly CaseType[] = ['present', 'superseded', 'absent', 'adjacent'];
const HEADER = ['case type', 'extension', 'control', 'difference', 'extension range', 'control range'];

const percent = (hits: number, total: number): number => Math.round((100 * hits) / total);
const rateText = (hits: number, total: number): string =>
  total === 0 ? 'n/a' : `${hits}/${total} (${percent(hits, total)}%)`;

function differenceText(extension: readonly QuestionOutcome[], control: readonly QuestionOutcome[]): string {
  if (extension.length === 0 || control.length === 0) return 'n/a';
  const hits = (outcomes: readonly QuestionOutcome[]): number => outcomes.filter((outcome) => outcome.hit).length;
  const difference = percent(hits(extension), extension.length) - percent(hits(control), control.length);
  if (difference > 0) return `+${difference} pp`;
  if (difference < 0) return `-${-difference} pp`;
  return '0 pp';
}

function rangeText(outcomes: readonly QuestionOutcome[]): string {
  const perRun = new Map<number, { hits: number; total: number }>();
  for (const outcome of outcomes) {
    const counts = perRun.get(outcome.runIndex) ?? { hits: 0, total: 0 };
    counts.total += 1;
    if (outcome.hit) counts.hits += 1;
    perRun.set(outcome.runIndex, counts);
  }
  if (perRun.size === 0) return 'n/a';
  const percents = [...perRun.values()].map((counts) => percent(counts.hits, counts.total));
  return `${Math.min(...percents)}%-${Math.max(...percents)}%`;
}

function tableRow(name: string, questions: readonly QuestionOutcome[]): string[] {
  const extension = questions.filter((outcome) => outcome.arm === 'extension');
  const control = questions.filter((outcome) => outcome.arm === 'control');
  const hits = (outcomes: readonly QuestionOutcome[]): number => outcomes.filter((outcome) => outcome.hit).length;
  return [
    name,
    rateText(hits(extension), extension.length),
    rateText(hits(control), control.length),
    differenceText(extension, control),
    rangeText(extension),
    rangeText(control),
  ];
}

function formatTable(rows: readonly string[][]): string[] {
  const widths = HEADER.map((_, column) => Math.max(...rows.map((row) => row[column].length)) + 2);
  return rows.map((row) =>
    row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join('').trimEnd());
}

function seedRateText(seeds: readonly SeedOutcome[], kind: SeedOutcome['kind']): string {
  const ofKind = seeds.filter((seed) => seed.kind === kind);
  const recorded = ofKind.filter((seed) => seed.recorded).length;
  return ofKind.length === 0 ? '0/0 (n/a)' : rateText(recorded, ofKind.length);
}

const countStatus = (items: readonly { status: CallStatus }[], status: CallStatus): number =>
  items.filter((item) => item.status === status).length;

export function formatReport(input: ReportInput): string {
  const rows = [
    HEADER,
    ...CASE_TYPE_ROWS.map((caseType) => tableRow(caseType, input.questions.filter((outcome) => outcome.caseType === caseType))),
    tableRow('total', input.questions),
  ];
  const extensionQuestions = input.questions.filter((outcome) => outcome.arm === 'extension');
  const controlQuestions = input.questions.filter((outcome) => outcome.arm === 'control');
  return [
    'pi-context recall eval',
    `model: ${input.model}`,
    `runs: ${input.runs}`,
    ...(input.scoringVersion === undefined ? [] : [`scoring: ${input.scoringVersion}`]),
    '',
    ...formatTable(rows),
    '',
    `seed record rate: question facts ${seedRateText(input.seeds, 'question')}, distractor facts ${seedRateText(input.seeds, 'distractor')}`,
    `extension answers: ${countStatus(extensionQuestions, 'timeout')} timeouts, ${countStatus(extensionQuestions, 'failed')} failures; seed sessions: ${countStatus(input.seeds, 'timeout')} timeouts, ${countStatus(input.seeds, 'failed')} failures`,
    `control answers: ${countStatus(controlQuestions, 'timeout')} timeouts, ${countStatus(controlQuestions, 'failed')} failures`,
    `seed commits before unsuccessful exit: ${input.seeds.filter(seed => seed.recorded && seed.status !== 'ok').length}`,
    `completed-call hit rate: extension ${rateText(extensionQuestions.filter(outcome => outcome.status === 'ok' && outcome.hit).length, countStatus(extensionQuestions, 'ok'))}, control ${rateText(controlQuestions.filter(outcome => outcome.status === 'ok' && outcome.hit).length, countStatus(controlQuestions, 'ok'))}`,
  ].join('\n');
}
