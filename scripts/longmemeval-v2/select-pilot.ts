import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DATASET_REVISION,
  PINNED_SOURCE_HASHES,
  loadDataset,
  type BenchmarkDataset,
  type BenchmarkDomain,
  type DatasetSourceHashes,
  type QuestionCase,
} from './dataset.ts';

export interface PilotManifestCase {
  id: string;
  domain: BenchmarkDomain;
  questionType: string;
}

export interface PilotManifest {
  datasetRevision: string;
  sourceHashes: DatasetSourceHashes;
  cases: PilotManifestCase[];
}

interface PilotGroup {
  name: string;
  matches: (question: QuestionCase) => boolean;
  preferredDomain: BenchmarkDomain;
}

const PILOT_GROUPS: readonly PilotGroup[] = [
  {
    name: 'static-environment',
    matches: question => question.questionType === 'static-environment',
    preferredDomain: 'web',
  },
  {
    name: 'dynamic-environment',
    matches: question => question.questionType === 'dynamic-environment',
    preferredDomain: 'enterprise',
  },
  {
    name: 'procedure',
    matches: question => question.questionType === 'procedure',
    preferredDomain: 'web',
  },
  {
    name: 'union-of-abs-types',
    matches: question => question.questionType.endsWith('-abs'),
    preferredDomain: 'web',
  },
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectPilotCases(dataset: BenchmarkDataset): PilotManifestCase[] {
  const selected: PilotManifestCase[] = [];
  for (const group of PILOT_GROUPS) {
    const matching = dataset.questions.filter(group.matches);
    const preferred = matching
      .filter(question => question.domain === group.preferredDomain)
      .sort((left, right) => compareText(left.id, right.id));
    const fallback = matching
      .filter(question => question.domain !== group.preferredDomain)
      .sort((left, right) => compareText(left.id, right.id));
    const choice = preferred[0] ?? fallback[0];
    if (!choice) throw new Error(`EMPTY_PILOT_GROUP: ${group.name}`);
    selected.push({ id: choice.id, domain: choice.domain, questionType: choice.questionType });
  }

  const domains = new Set(selected.map(question => question.domain));
  if (domains.size < 2) throw new Error('PILOT_MUST_INCLUDE_BOTH_DOMAINS');
  return selected;
}

export function createPilotManifest(dataset: BenchmarkDataset): PilotManifest {
  if (dataset.datasetRevision !== DATASET_REVISION) throw new Error('UNPINNED_DATASET_REVISION');
  if (!sameHashes(dataset.sourceHashes, PINNED_SOURCE_HASHES)) throw new Error('UNPINNED_DATASET_HASHES');
  return {
    datasetRevision: DATASET_REVISION,
    sourceHashes: dataset.sourceHashes,
    cases: selectPilotCases(dataset),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameHashes(left: unknown, right: DatasetSourceHashes): boolean {
  if (!isRecord(left)) return false;
  return left['questions.jsonl'] === right['questions.jsonl'] &&
    left['trajectories.jsonl'] === right['trajectories.jsonl'] &&
    left['haystacks/lme_v2_small.json'] === right['haystacks/lme_v2_small.json'];
}

function sameCases(left: unknown, right: readonly PilotManifestCase[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((value, index) => {
    const expected = right[index];
    return isRecord(value) && expected !== undefined &&
      value.id === expected.id &&
      value.domain === expected.domain &&
      value.questionType === expected.questionType;
  });
}

export async function loadPilotManifest(path: string, dataset: BenchmarkDataset): Promise<PilotManifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') throw new Error('PILOT_MANIFEST_MISSING');
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('PILOT_MANIFEST_INVALID_JSON');
  }
  if (!isRecord(value)) throw new Error('PILOT_MANIFEST_INVALID');
  const expected = createPilotManifest(dataset);
  if (value.datasetRevision !== expected.datasetRevision) throw new Error('PILOT_MANIFEST_REVISION_MISMATCH');
  if (!sameHashes(value.sourceHashes, expected.sourceHashes)) throw new Error('PILOT_MANIFEST_HASH_MISMATCH');
  if (!sameCases(value.cases, expected.cases)) throw new Error('PILOT_MANIFEST_CASES_MISMATCH');
  return expected;
}

function parseArguments(args: readonly string[]): { dataRoot: string; output: string } {
  let dataRoot: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument !== '--data-root' && argument !== '--output') {
      throw new Error(`UNKNOWN_ARGUMENT: ${argument}`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT_VALUE: ${argument}`);
    if (argument === '--data-root') {
      if (dataRoot !== undefined) throw new Error('DUPLICATE_ARGUMENT: --data-root');
      dataRoot = value;
    } else {
      if (output !== undefined) throw new Error('DUPLICATE_ARGUMENT: --output');
      output = value;
    }
    index += 1;
  }
  if (!dataRoot || !isAbsolute(dataRoot)) throw new Error('--data-root must be an absolute path');
  if (!output) throw new Error('--output is required');
  return { dataRoot, output: resolve(output) };
}

async function outputExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function runSelector(dataRoot: string, outputPath: string): Promise<PilotManifest> {
  const dataset = await loadDataset(dataRoot);
  const output = resolve(outputPath);
  const manifest = createPilotManifest(dataset);
  if (await outputExists(output)) {
    return loadPilotManifest(output, dataset);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

async function main(): Promise<void> {
  const { dataRoot, output } = parseArguments(process.argv.slice(2));
  const manifest = await runSelector(dataRoot, output);
  console.log(JSON.stringify(manifest, null, 2));
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (executedPath === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'PILOT_SELECTION_FAILED');
    process.exitCode = 1;
  });
}
