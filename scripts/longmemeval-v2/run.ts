import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  DATASET_REVISION,
  MAX_RENDERED_CHUNK_BYTES,
  PINNED_SOURCE_HASHES,
  loadDataset,
  renderTrajectory,
  selectCases,
  type BenchmarkDataset,
  type BenchmarkDomain,
  type DatasetSourceHashes,
  type QuestionCase,
} from './dataset.ts';
import { loadPilotManifest } from './select-pilot.ts';
import {
  estimateCost,
  estimatePreflight,
  type CostEstimate,
  type ModelRates,
} from './cost.ts';
import {
  PiSessionError,
  runPiSession,
  type PiSessionInput,
  type PiSessionResult,
  type UsageTotals,
} from './pi.ts';
import { judgeSemanticCase } from './judge.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRIVATE_OUTPUT_ROOT = join(PACKAGE_ROOT, '.benchmarks');
const PINNED_UPSTREAM_REVISION = '2cc8c540bdb87fe6761629b585e727e1c4704520';
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_PROJECT_QUOTA_BYTES = 10_485_760;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 1024 * 1024;
const MODEL_PATTERN = /^openai-codex\/[A-Za-z0-9][A-Za-z0-9._-]*(?:luna|sol)$/iu;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PYTHON_CANDIDATES = [
  process.env.LME_PYTHON,
  join(homedir(), 'benchmarks', 'lme-venv', 'bin', 'python'),
  'python3.11',
].filter((value): value is string => typeof value === 'string' && value.length > 0);

export interface RunOptions {
  dataRoot: string;
  upstreamRoot: string;
  set: 'pilot' | 'full';
  model: string;
  thinking: string;
  outputRoot: string;
  ratesPath?: string;
  execute: boolean;
  resumeDir?: string;
  /** Test-only process overrides. The CLI does not expose these fields. */
  testOnly?: {
    piExecutablePath?: string;
    piExecutableArgs?: readonly string[];
    graderExecutablePath?: string;
    graderExecutableArgs?: readonly string[];
    expectedHashes?: DatasetSourceHashes;
    datasetRevision?: string;
    upstreamRevision?: string;
    availableBytes?: number;
    authAvailable?: boolean;
    authPath?: string;
    skipPilotManifest?: boolean;
  };
}

export type RunStatus = 'preflight' | 'complete' | 'incomplete';

export interface RunReport {
  status: RunStatus;
  reportPath: string;
  runName: string;
  runDirectory: string | null;
  dataRevision: string | null;
  sourceHashes: DatasetSourceHashes | null;
  pluginFingerprint: string | null;
  pluginGitRevision: string | null;
  runnerFingerprint: string | null;
  pluginSource: string | null;
  actualModelIdentity: string | null;
  model: string;
  thinking: string;
  projectId: string | null;
  eligibleCount: number;
  excludedCount: number;
  excludedIds: string[];
  historyChunkCount: number;
  answerSessionCount: number;
  plannedJudgeCallCount: number;
  modelVisible: boolean | null;
  authAvailable: boolean | null;
  storageAvailableBytes: number | null;
  warnings: string[];
  failureCode: string | null;
  measuredUsage: UsageTotals;
  ingestionCost: CostEstimate | null;
  pluginAnswerCost: CostEstimate | null;
  controlCost: CostEstimate | null;
  judgeCost: CostEstimate | null;
  judgeCallCount: number;
  cases: Array<{
    id: string;
    domain: BenchmarkDomain;
    questionType: string;
    status: 'pending' | 'incomplete' | 'scored';
    pluginScore: boolean | null;
    controlScore: boolean | null;
  }>;
}

interface RawQuestion extends Record<string, unknown> {
  id: string;
  domain: BenchmarkDomain;
  question_type: string;
  question: string;
  answer: string;
  eval_function: string;
  image: string | null;
}

interface UsageCount {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reportedUsd: number | null;
}

interface StageCheckpoint {
  status: 'complete' | 'failed' | 'ambiguous';
  key: string;
  kind: 'history' | 'answer' | 'grade';
  caseId?: string;
  mode?: 'memory' | 'control';
  domain?: BenchmarkDomain;
  stdout: string;
  stderr: string;
  session: string | null;
  usage: UsageCount;
  actualModel: { provider: string; model: string; responseModel: string | null } | null;
  answer?: string;
  score?: ScoreResult;
  semanticJudge?: boolean;
  errorCode?: string;
}

interface ScoreResult {
  id: string;
  score: boolean;
  evalName: string;
  parsedAnswer: string;
  isUnknown: boolean;
  semanticJudge: boolean;
  judgeUsage: unknown;
}

interface Checkpoint {
  version: 1;
  status: 'running' | 'complete' | 'incomplete';
  identity: {
    dataRevision: string | null;
    sourceHashes: DatasetSourceHashes;
    set: 'pilot' | 'full';
    tier: 'small';
    pilotIds: string[];
    model: string;
    thinking: string;
    pluginFingerprint: string;
    runnerFingerprint: string;
    ratesFingerprint: string;
    quotaAssumptionBytes: number;
    upstreamRevision: string;
  };
  runName: string;
  stages: Record<string, StageCheckpoint>;
  projectIds: Record<string, string>;
  failure: { code: string; stage: string } | null;
  updatedAt: string;
}

interface PreflightData {
  dataset: BenchmarkDataset;
  selected: QuestionCase[];
  rawQuestions: Map<string, RawQuestion>;
  rates: ModelRates | null;
  ratesFingerprint: string;
  pluginFingerprint: string;
  pluginGitRevision: string | null;
  runnerFingerprint: string;
  upstreamRevision: string;
  history: Map<BenchmarkDomain, string[]>;
  historyBytes: Map<BenchmarkDomain, number>;
  historyChunkCount: number;
  semanticCaseIds: Set<string>;
  judgeModelVisible: boolean;
  pluginEstimate: CostEstimate;
  controlEstimate: CostEstimate;
  modelVisible: boolean;
  authAvailable: boolean;
  graderAvailable: boolean;
  storageAvailableBytes: number | null;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)) return error.code;
  if (error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)) return error.message;
  return 'RUN_FAILED';
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'RUN_FAILED';
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (
    pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent)
  );
}

function resolveOutputRoot(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new Error('PATH_MUST_BE_ABSOLUTE_OUTPUT_ROOT');
  if (isAbsolute(path)) return resolve(path);
  const segments = path.split(/[\\/]+/u);
  if ((path !== '.benchmarks' && !path.startsWith('.benchmarks/')) || segments.includes('..')) {
    throw new Error('PATH_MUST_BE_ABSOLUTE_OUTPUT_ROOT');
  }
  return resolve(PACKAGE_ROOT, path);
}

function assertProjectOutputRootIsPrivate(path: string): void {
  if (!isWithin(PRIVATE_OUTPUT_ROOT, path)) throw new Error('OUTPUT_ROOT_MUST_BE_OUTSIDE_PROJECT');

  let current = PACKAGE_ROOT;
  for (const segment of relative(PACKAGE_ROOT, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error('OUTPUT_ROOT_SYMLINK');
      if (!info.isDirectory()) throw new Error('OUTPUT_ROOT_NOT_DIRECTORY');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') break;
      throw error;
    }
  }

  const relativePath = relative(PACKAGE_ROOT, path);
  const ignored = spawnSync('git', ['-C', PACKAGE_ROOT, 'check-ignore', '-q', '--no-index', '--', relativePath], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true, env: gitEnvironment(),
  });
  if (ignored.error || ignored.status !== 0) throw new Error('OUTPUT_ROOT_NOT_IGNORED');

  const tracked = spawnSync('git', ['-C', PACKAGE_ROOT, 'ls-files', '--cached', '--', relativePath], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true, env: gitEnvironment(),
  });
  if (tracked.error || tracked.status !== 0) throw new Error('OUTPUT_ROOT_TRACKED_CHECK_FAILED');
  if (tracked.stdout.trim().length > 0) throw new Error('OUTPUT_ROOT_TRACKED');
}

function assertOutputRootAllowed(path: string): void {
  if (isWithin(PACKAGE_ROOT, path)) {
    assertProjectOutputRootIsPrivate(path);
  }
}

function validateOptions(options: RunOptions): void {
  for (const [name, value] of Object.entries({
    'data-root': options.dataRoot,
    'upstream-root': options.upstreamRoot,
  })) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`PATH_MUST_BE_ABSOLUTE_${name.replaceAll('-', '_').toUpperCase()}`);
  }
  options.outputRoot = resolveOutputRoot(options.outputRoot);
  assertOutputRootAllowed(options.outputRoot);
  if (options.ratesPath !== undefined && !isAbsolute(options.ratesPath)) throw new Error('RATES_PATH_MUST_BE_ABSOLUTE');
  if (options.resumeDir !== undefined && !isAbsolute(options.resumeDir)) throw new Error('RESUME_PATH_MUST_BE_ABSOLUTE');
  if (options.set !== 'pilot' && options.set !== 'full') throw new Error('SET_INVALID');
  if (typeof options.model !== 'string' || !MODEL_PATTERN.test(options.model)) throw new Error('MODEL_UNSUPPORTED');
  if (!THINKING_LEVELS.has(options.thinking)) throw new Error('THINKING_UNSUPPORTED');
  if (typeof options.execute !== 'boolean') throw new Error('EXECUTE_FLAG_INVALID');
  if (options.resumeDir && !options.execute) throw new Error('RESUME_REQUIRES_EXECUTE');
  const outputRoot = resolve(options.outputRoot);
  for (const inputRoot of [resolve(options.dataRoot), resolve(options.upstreamRoot)]) {
    if (isWithin(inputRoot, outputRoot) || isWithin(outputRoot, inputRoot)) {
      throw new Error('OUTPUT_ROOT_OVERLAPS_INPUTS');
    }
  }
}

function outputRootIsInGit(path: string): boolean {
  let existingPath = resolve(path);
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) return false;
    existingPath = parent;
  }
  const result = spawnSync('git', ['-C', existingPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true, env: gitEnvironment(),
  });
  return result.status === 0 && !result.error;
}

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function filesBelow(root: string, entries: readonly string[], includeHead: boolean): Promise<{ fingerprint: string; head: string | null }> {
  const files: Array<{ relative: string; bytes: Buffer }> = [];
  for (const entry of entries) {
    const absolute = join(root, entry);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) {
      files.push({ relative: entry, bytes: await readFile(absolute) });
      continue;
    }
    if (!info.isDirectory()) continue;
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const names = (await readdir(directory)).sort(compareText);
      for (const name of names) {
        if (name === '__pycache__' || name.endsWith('.pyc')) continue;
        const path = join(directory, name);
        const childInfo = await lstat(path);
        if (childInfo.isSymbolicLink()) continue;
        const childRelative = join(relativeDirectory, name);
        if (childInfo.isDirectory()) await walk(path, childRelative);
        else if (childInfo.isFile()) files.push({ relative: childRelative, bytes: await readFile(path) });
      }
    };
    await walk(absolute, entry);
  }
  files.sort((left, right) => compareText(left.relative, right.relative));
  const digest = createHash('sha256');
  for (const file of files) digest.update(file.relative).update('\0').update(file.bytes).update('\0');
  const head = includeHead ? gitHead(root) : null;
  if (head) digest.update('git-head\0').update(head);
  return { fingerprint: digest.digest('hex'), head };
}

function gitHead(root: string): string | null {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: gitEnvironment(),
  });
  if (result.status !== 0 || result.error) return null;
  const head = result.stdout.trim();
  return /^[a-f0-9]{40,64}$/u.test(head) ? head : null;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
  env.LC_ALL = 'C';
  return env;
}

async function fingerprintPlugin(): Promise<{ fingerprint: string; head: string | null }> {
  return filesBelow(PACKAGE_ROOT, [
    'src', 'vendor', 'skills/pi-context', 'package.json', 'package-lock.json', 'tsconfig.json',
  ], true);
}

async function fingerprintRunner(): Promise<string> {
  return (await filesBelow(PACKAGE_ROOT, ['scripts/longmemeval-v2.ts', 'scripts/longmemeval-v2'], false)).fingerprint;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

async function readRates(path: string | undefined): Promise<ModelRates | null> {
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new Error('RATES_JSON_INVALID');
  }
  if (!isRecord(parsed)) throw new Error('RATES_JSON_INVALID');
  const keys = new Set([
    'inputUsdPerMillionTokens', 'outputUsdPerMillionTokens', 'cacheReadUsdPerMillionTokens',
    'cacheWriteUsdPerMillionTokens', 'judgeInputUsdPerMillionTokens', 'judgeOutputUsdPerMillionTokens',
  ]);
  if (Object.keys(parsed).some(key => !keys.has(key))) throw new Error('RATES_JSON_INVALID');
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`RATES_JSON_INVALID_${key.toUpperCase()}`);
    }
  }
  return parsed as unknown as ModelRates;
}

async function readRawQuestions(root: string): Promise<Map<string, RawQuestion>> {
  const text = await readFile(join(root, 'questions.jsonl'), 'utf8');
  const result = new Map<string, RawQuestion>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`QUESTION_JSONL_INVALID_${index + 1}`);
    }
    if (!isRecord(value) || typeof value.id !== 'string') throw new Error(`QUESTION_INVALID_${index + 1}`);
    if (result.has(value.id)) throw new Error('DUPLICATE_QUESTION_ID');
    if (typeof value.domain !== 'string' || (value.domain !== 'web' && value.domain !== 'enterprise') ||
        typeof value.question_type !== 'string' || typeof value.question !== 'string' ||
        typeof value.answer !== 'string' || typeof value.eval_function !== 'string') {
      throw new Error(`QUESTION_INVALID_${index + 1}`);
    }
    result.set(value.id, value as RawQuestion);
  }
  return result;
}

function makeHistory(dataset: BenchmarkDataset, selected: QuestionCase[]): {
  history: Map<BenchmarkDomain, string[]>;
  historyBytes: Map<BenchmarkDomain, number>;
  chunkCount: number;
} {
  const history = new Map<BenchmarkDomain, string[]>();
  const historyBytes = new Map<BenchmarkDomain, number>();
  let chunkCount = 0;
  const domains = [...new Set(selected.map(question => question.domain))].sort(compareText) as BenchmarkDomain[];
  for (const domain of domains) {
    const first = selected.find(question => question.domain === domain);
    if (!first) continue;
    const trajectoryIds = dataset.haystacks.get(first.id);
    if (!trajectoryIds) throw new Error(`MISSING_HAYSTACK_${first.id}`);
    for (const question of selected.filter(row => row.domain === domain)) {
      const ids = dataset.haystacks.get(question.id);
      if (!ids || canonicalJson(ids) !== canonicalJson(trajectoryIds)) throw new Error('DOMAIN_HAYSTACK_MISMATCH');
    }
    const packed: string[] = [];
    let current = '';
    for (const trajectoryId of trajectoryIds) {
      const trajectory = dataset.trajectories.get(trajectoryId);
      if (!trajectory || trajectory.domain !== domain) throw new Error(`TRAJECTORY_INVALID_${trajectoryId}`);
      const observations = [`Trajectory ${trajectoryId}:`, ...renderTrajectory(trajectory)];
      for (const observation of observations) {
        if (Buffer.byteLength(observation, 'utf8') > MAX_RENDERED_CHUNK_BYTES) throw new Error('HISTORY_CHUNK_LIMIT_EXCEEDED');
        const combined = current.length === 0 ? observation : `${current}\n\n${observation}`;
        if (Buffer.byteLength(combined, 'utf8') > MAX_RENDERED_CHUNK_BYTES) {
          packed.push(current);
          current = observation;
        } else {
          current = combined;
        }
      }
    }
    if (current.length > 0) packed.push(current);
    if (packed.some(chunk => Buffer.byteLength(chunk, 'utf8') > MAX_RENDERED_CHUNK_BYTES)) {
      throw new Error('HISTORY_CHUNK_LIMIT_EXCEEDED');
    }
    history.set(domain, packed);
    historyBytes.set(domain, packed.reduce((sum, chunk) => sum + Buffer.byteLength(chunk, 'utf8'), 0));
    chunkCount += packed.length;
  }
  return { history, historyBytes, chunkCount };
}

function semanticEvaluator(raw: RawQuestion): 'llm_abstention_checker' | 'llm_gotchas_checker' | null {
  const match = /llm_(?:abstention|gotchas)_checker/u.exec(raw.eval_function);
  return match?.[0] === 'llm_abstention_checker' || match?.[0] === 'llm_gotchas_checker'
    ? match[0]
    : null;
}

function isSemantic(raw: RawQuestion): boolean {
  return semanticEvaluator(raw) !== null;
}

function ratesForDomain(preflight: PreflightData, domain: BenchmarkDomain): CostEstimate {
  const historyBytes = preflight.historyBytes.get(domain) ?? 0;
  const domainCases = preflight.selected.filter(question => question.domain === domain);
  const semanticCount = domainCases.filter(question => preflight.semanticCaseIds.has(question.id)).length;
  return estimatePreflight({
    historyBytes,
    questionCount: domainCases.length,
    sessionCount: (preflight.history.get(domain)?.length ?? 0) + domainCases.length,
    judgeCallCount: semanticCount,
    rates: preflight.rates,
  });
}

function addWarnings(warnings: string[], values: readonly (string | null)[]): void {
  for (const value of values) if (value && !warnings.includes(value)) warnings.push(value);
}

function modelIsListed(output: string, model: string): boolean {
  const [provider, modelName] = model.split('/', 2);
  return output.split(/\r?\n/u).some(line => {
    const columns = line.trim().split(/\s+/u);
    return columns.includes(model) || (columns[0] === provider && columns[1] === modelName);
  });
}

function runListModels(options: RunOptions, model = options.model): boolean {
  const executable = options.testOnly?.piExecutablePath ?? 'pi';
  const args = [...(options.testOnly?.piExecutableArgs ?? []), '--list-models'];
  let result;
  try {
    result = spawnSync(executable, args, {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: OUTPUT_LIMIT_BYTES,
    });
  } catch {
    return false;
  }
  if (result.error || result.status !== 0) return false;
  return modelIsListed(result.stdout, model);
}

function findPythonExecutable(): string | null {
  for (const executable of PYTHON_CANDIDATES) {
    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024,
    });
    if (result.status === 0 && !result.error && /Python 3\.11\./u.test(`${result.stdout}\n${result.stderr}`)) return executable;
  }
  return null;
}

function graderAvailable(options: RunOptions): boolean {
  return options.testOnly?.graderExecutablePath ? true : findPythonExecutable() !== null;
}

function sourceAuthPath(options: RunOptions): string {
  return options.testOnly?.authPath ?? join(getAgentDir(), 'auth.json');
}

async function modelAuthAvailable(options: RunOptions): Promise<boolean> {
  if (options.testOnly?.authAvailable !== undefined) return options.testOnly.authAvailable;
  const authPath = sourceAuthPath(options);
  try {
    const info = await lstat(authPath);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function freeBytes(path: string, testValue?: number): Promise<number | null> {
  if (testValue !== undefined) return testValue;
  let existingPath = resolve(path);
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) return null;
    existingPath = parent;
  }
  try {
    const info = await statfs(existingPath);
    const available = Number(info.bavail) * Number(info.bsize);
    return Number.isSafeInteger(available) && available >= 0 ? available : null;
  } catch {
    return null;
  }
}

async function requirePinnedUpstream(root: string, testRevision?: string): Promise<string> {
  try {
    if (!(await stat(join(root, 'evaluation', 'qa_eval_metrics.py'))).isFile()) throw new Error('UPSTREAM_EVALUATOR_MISSING');
  } catch {
    throw new Error('UPSTREAM_EVALUATOR_MISSING');
  }
  const revision = testRevision ?? gitHead(root);
  if (!revision) throw new Error('UPSTREAM_REVISION_UNAVAILABLE');
  if (revision !== PINNED_UPSTREAM_REVISION) throw new Error('UPSTREAM_REVISION_MISMATCH');
  if (testRevision === undefined) {
    const clean = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true, env: gitEnvironment(),
    });
    if (clean.status !== 0 || clean.error) throw new Error('UPSTREAM_REVISION_UNAVAILABLE');
    if (clean.stdout.trim().length > 0) throw new Error('UPSTREAM_WORKTREE_DIRTY');
  }
  return revision;
}

async function makePreflight(options: RunOptions): Promise<PreflightData> {
  assertOutputRootAllowed(options.outputRoot);
  if (!isWithin(PACKAGE_ROOT, options.outputRoot) && outputRootIsInGit(options.outputRoot)) {
    throw new Error('OUTPUT_ROOT_MUST_BE_OUTSIDE_GIT');
  }
  const expectedHashes = options.testOnly?.expectedHashes;
  const dataset = await loadDataset(options.dataRoot, {
    ...(expectedHashes === undefined ? {} : { expectedHashes }),
    ...(options.testOnly?.datasetRevision === undefined ? {} : { revision: options.testOnly.datasetRevision }),
  });
  const expectedDatasetRevision = options.testOnly?.datasetRevision ?? DATASET_REVISION;
  if (dataset.datasetRevision !== expectedDatasetRevision) throw new Error('DATASET_REVISION_MISMATCH');
  const upstreamRevision = await requirePinnedUpstream(options.upstreamRoot, options.testOnly?.upstreamRevision);
  const manifestPath = join(PACKAGE_ROOT, 'scripts', 'longmemeval-v2', 'pilot.json');
  const manifest = options.testOnly?.skipPilotManifest ? null : await loadPilotManifest(manifestPath, dataset);
  if (manifest && new Set(manifest.cases.map(row => row.id)).size !== manifest.cases.length) throw new Error('DUPLICATE_PILOT_ID');
  if (options.set === 'pilot' && !manifest) throw new Error('TEST_PILOT_MANIFEST_REQUIRED');
  const pilotIds = options.set === 'pilot' ? manifest!.cases.map(row => row.id) : [];
  const selected = selectCases(dataset, options.set, pilotIds);
  if (new Set(selected.map(question => question.id)).size !== selected.length) throw new Error('DUPLICATE_SELECTED_ID');
  const rawQuestions = await readRawQuestions(options.dataRoot);
  for (const question of selected) if (!rawQuestions.has(question.id)) throw new Error(`RAW_QUESTION_MISSING_${question.id}`);
  const rates = await readRates(options.ratesPath);
  const ratesFingerprint = hashJson(rates);
  const { history, historyBytes, chunkCount } = makeHistory(dataset, selected);
  const semanticCaseIds = new Set(selected.filter(question => {
    const raw = rawQuestions.get(question.id);
    return raw !== undefined && isSemantic(raw);
  }).map(question => question.id));
  const plugin = await fingerprintPlugin();
  const runnerFingerprint = await fingerprintRunner();
  const pluginCases = selected.length;
  const semanticCalls = semanticCaseIds.size * 2;
  const totalHistoryBytes = [...historyBytes.values()].reduce((sum, value) => sum + value, 0);
  const pluginEstimate = estimatePreflight({
    historyBytes: totalHistoryBytes,
    questionCount: pluginCases,
    sessionCount: chunkCount + pluginCases,
    judgeCallCount: semanticCaseIds.size,
    rates,
  });
  const controlEstimate = estimatePreflight({
    historyBytes: 0,
    questionCount: pluginCases,
    sessionCount: pluginCases,
    judgeCallCount: semanticCaseIds.size,
    rates,
  });
  const modelVisible = runListModels(options);
  const judgeModelVisible = runListModels(options, 'openai-codex/gpt-6-sol');
  const hasAuth = await modelAuthAvailable(options);
  const hasGrader = graderAvailable(options);
  const storageAvailableBytes = await freeBytes(options.outputRoot, options.testOnly?.availableBytes);
  const warnings: string[] = [];
  if (!modelVisible) warnings.push('Selected model is not visible to the local Pi CLI.');
  if (!judgeModelVisible) warnings.push('Judge model openai-codex/gpt-6-sol is not visible to the local Pi CLI.');
  if (!hasAuth) warnings.push('The local Pi auth file is missing; paid model execution is not available.');
  if (!hasGrader) warnings.push('The pinned Python 3.11 grader environment is not available.');
  if (storageAvailableBytes === null) warnings.push('Available output storage could not be measured.');
  else if (storageAvailableBytes < MIN_FREE_BYTES) warnings.push('Output storage has less than 1 GiB available.');
  warnings.push(`The private run config sets each project quota to ${DEFAULT_PROJECT_QUOTA_BYTES} bytes; user project settings do not apply.`);
  if (totalHistoryBytes > DEFAULT_PROJECT_QUOTA_BYTES) {
    warnings.push('Rendered history exceeds the default project quota; model-selected records can still exceed quota earlier.');
  }
  if (!plugin.head) warnings.push('The plugin checkout has no Git HEAD; its source fingerprint identifies the plugin version.');
  if (dataset.excludedImageQuestionIds.length > 0) {
    warnings.push('Image questions are excluded; this is an adapted text-only result, not a 451-question score.');
  }
  if (selected.length === 0) throw new Error('NO_ELIGIBLE_CASES');
  if (semanticCalls < 0) throw new Error('PREFLIGHT_COUNT_INVALID');
  return {
    dataset,
    selected,
    rawQuestions,
    rates,
    ratesFingerprint,
    pluginFingerprint: plugin.fingerprint,
    pluginGitRevision: plugin.head,
    runnerFingerprint,
    upstreamRevision,
    history,
    historyBytes,
    historyChunkCount: chunkCount,
    semanticCaseIds,
    judgeModelVisible,
    pluginEstimate,
    controlEstimate,
    modelVisible,
    authAvailable: hasAuth,
    graderAvailable: hasGrader,
    storageAvailableBytes,
    warnings,
  };
}

function initialUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedUsd: null };
}

function usageFromCount(value: UsageCount): UsageTotals {
  return { ...value };
}

function combineUsage(sources: UsageTotals[]): UsageTotals {
  const total = initialUsage();
  for (const source of sources) {
    total.input += source.input;
    total.output += source.output;
    total.cacheRead += source.cacheRead;
    total.cacheWrite += source.cacheWrite;
    total.totalTokens += source.totalTokens;
  }
  if (sources.length > 0 && sources.every(source => source.reportedUsd !== null)) {
    total.reportedUsd = sources.reduce<number>((sum, source) => sum + (source.reportedUsd ?? 0), 0);
  }
  return total;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function usageFromEvents(events: Record<string, unknown>[]): UsageTotals {
  const total = initialUsage();
  let hasUsage = false;
  let reportedComplete = true;
  let reported = 0;
  const seenMessages = new Set<string>();
  const seenTools = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant' && isRecord(event.message.usage)) {
      const id = typeof event.message.id === 'string' ? event.message.id : null;
      if (id && seenMessages.has(id)) continue;
      if (id) seenMessages.add(id);
      records.push(event.message.usage);
    }
    if (event.type === 'tool_execution_end') {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : null;
      if (id && seenTools.has(id)) continue;
      if (id) seenTools.add(id);
      const nested = firstUsage(event.result);
      if (nested) records.push(nested);
    }
  }
  for (const record of records) {
    const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
    const recordCounts: Record<typeof fields[number], number> = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    };
    for (const field of fields) {
      const value = record[field] ?? 0;
      if (!isSafeCount(value)) throw new Error('USAGE_INVALID');
      recordCounts[field] = value;
      total[field] += value;
    }
    const tokens = record.totalTokens ?? (recordCounts.input + recordCounts.output + recordCounts.cacheRead + recordCounts.cacheWrite);
    if (!isSafeCount(tokens)) throw new Error('USAGE_INVALID');
    total.totalTokens += tokens;
    hasUsage = true;
    const cost = typeof record.cost === 'number' ? record.cost : isRecord(record.cost) ? record.cost.total : undefined;
    if (cost === undefined) reportedComplete = false;
    else if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Error('USAGE_INVALID');
    else reported += cost;
  }
  if (hasUsage && reportedComplete) total.reportedUsd = reported;
  return total;
}

function firstUsage(value: unknown, seen = new Set<object>()): Record<string, unknown> | null {
  if (!isRecord(value) || seen.has(value)) return null;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'usage' && isRecord(child)) return child;
    const nested = firstUsage(child, seen);
    if (nested) return nested;
  }
  return null;
}

function parseJsonl(text: string): { events: Record<string, unknown>[]; valid: boolean } {
  if (!text.endsWith('\n')) return { events: [], valid: false };
  const lines = text.slice(0, -1).split('\n');
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line) return { events, valid: false };
    try {
      const value: unknown = JSON.parse(line) as unknown;
      if (!isRecord(value)) return { events, valid: false };
      events.push(value);
    } catch {
      return { events, valid: false };
    }
  }
  return { events, valid: events.length > 0 };
}

function finalAssistant(events: Record<string, unknown>[]): { answer: string; message: Record<string, unknown> | null } {
  const messages = events.flatMap(event => {
    if (event.type !== 'message_end' || !isRecord(event.message) || event.message.role !== 'assistant') return [];
    const message = event.message;
    const content = message.content;
    if (!Array.isArray(content)) return [];
    const text = content.flatMap((block: unknown) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim();
    return text ? [{ answer: text, message }] : [];
  });
  return messages.at(-1) ?? { answer: '', message: null };
}

function eventModel(message: Record<string, unknown> | null): StageCheckpoint['actualModel'] {
  if (!message || typeof message.provider !== 'string' || typeof message.model !== 'string') return null;
  return {
    provider: message.provider,
    model: message.model,
    responseModel: typeof message.responseModel === 'string' ? message.responseModel : null,
  };
}

function modelMatches(model: StageCheckpoint['actualModel'], configured: string): boolean {
  return model !== null && model.provider === 'openai-codex' && model.model === configured.slice('openai-codex/'.length);
}

function validPiLog(text: string, model: string, requireRecord: boolean): {
  valid: boolean;
  events: Record<string, unknown>[];
  answer: string;
  actualModel: StageCheckpoint['actualModel'];
  usage: UsageTotals;
  session: string | null;
  projectId: string | null;
} {
  const parsed = parseJsonl(text);
  if (!parsed.valid) return { valid: false, events: parsed.events, answer: '', actualModel: null, usage: initialUsage(), session: null, projectId: null };
  const events = parsed.events;
  const result = finalAssistant(events);
  const assistantError = result.message?.stopReason === 'error' || result.message?.stopReason === 'aborted';
  const settled = events.some(event => event.type === 'agent_settled');
  const modelInfo = eventModel(result.message);
  const badAction = toolErrors(events);
  let projectId: string | null = null;
  if (requireRecord) {
    const actions = toolActions(events);
    const record = actions.find(action => action.action === 'record' && action.valid);
    if (record && typeof record.details?.projectId === 'string') projectId = record.details.projectId;
    if (!record) return { valid: false, events, answer: result.answer, actualModel: modelInfo, usage: safeUsage(events), session: eventSession(events), projectId };
  }
  return {
    valid: settled && !assistantError && result.answer.length > 0 && modelMatches(modelInfo, model) && !badAction,
    events,
    answer: result.answer,
    actualModel: modelInfo,
    usage: safeUsage(events),
    session: eventSession(events),
    projectId,
  };
}

function safeUsage(events: Record<string, unknown>[]): UsageTotals {
  try { return usageFromEvents(events); } catch { return initialUsage(); }
}

function eventSession(events: Record<string, unknown>[]): string | null {
  const session = events.find(event => event.type === 'session' && typeof event.id === 'string');
  return session && typeof session.id === 'string' ? session.id : null;
}

function toolActions(events: Record<string, unknown>[]): Array<{ action: string; valid: boolean; details?: Record<string, unknown> }> {
  const starts = new Map<string, string>();
  const actions: Array<{ action: string; valid: boolean; details?: Record<string, unknown> }> = [];
  for (const event of events) {
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && isRecord(event.args)) {
      starts.set(event.toolCallId, typeof event.args.action === 'string' ? event.args.action : '');
    }
    if (event.type !== 'tool_execution_end' || typeof event.toolCallId !== 'string' || !isRecord(event.result)) continue;
    const action = starts.get(event.toolCallId);
    if (action === undefined || event.toolName !== 'pi_context') continue;
    const details = isRecord(event.result.details) ? event.result.details : undefined;
    actions.push({ action, valid: event.result.isError === false && details?.ok === true, ...(details ? { details } : {}) });
  }
  return actions;
}

function toolErrors(events: Record<string, unknown>[]): boolean {
  for (const event of events) {
    if (event.type === 'tool_execution_end' && isRecord(event.result)) {
      if (event.result.isError === true) return true;
      const details = isRecord(event.result.details) ? event.result.details : undefined;
      if (details && details.ok === false) return true;
    }
    if (event.type === 'extension_status' && (typeof event.errorCode === 'string' || typeof event.guidanceErrorCode === 'string')) return true;
  }
  return false;
}

async function readJsonl(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function stagePaths(runDirectory: string, key: string): { stdout: string; stderr: string; session: string } {
  const safe = key.replace(/[^A-Za-z0-9_-]/gu, '-');
  const directory = join(runDirectory, 'sessions');
  return {
    stdout: join(directory, `${safe}.stdout.jsonl`),
    stderr: join(directory, `${safe}.stderr.log`),
    session: join(directory, `${safe}.session.jsonl`),
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PRIVATE_DIRECTORY_INVALID');
  await chmod(path, 0o700);
}

async function atomicCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function createGitFixture(path: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  await ensurePrivateDirectory(path);
  const gitDirectory = join(path, '.git');
  try {
    await lstat(gitDirectory);
    throw new Error('FIXTURE_REPOSITORY_EXISTS');
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
  const result = spawnSync('git', ['init', '-q', path], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env: gitEnvironment(),
  });
  if (result.status !== 0 || result.error) throw new Error('GIT_FIXTURE_INIT_FAILED');
}

async function ensureFixtures(runDirectory: string, domains: Iterable<BenchmarkDomain>, isNew: boolean): Promise<void> {
  for (const domain of domains) {
    const path = join(runDirectory, 'fixtures', domain);
    if (isNew) await createGitFixture(path);
    else {
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('RESUME_FIXTURE_MISSING');
      const git = await lstat(join(path, '.git')).catch(() => null);
      if (!git?.isDirectory()) throw new Error('RESUME_FIXTURE_REPOSITORY_MISSING');
      await chmod(path, 0o700);
    }
  }
}

async function fixtureProjectId(root: string): Promise<string> {
  const commonDirectory = await realpath(join(root, '.git')).catch(() => null);
  if (!commonDirectory) throw new Error('FIXTURE_GIT_COMMON_DIR_UNAVAILABLE');
  return createHash('sha256').update(`git\0${commonDirectory}`, 'utf8').digest('hex');
}

async function recordFixtureProjectIds(
  checkpoint: Checkpoint,
  runDirectory: string,
  domains: readonly BenchmarkDomain[],
  checkpointPath: string,
): Promise<void> {
  for (const domain of domains) {
    const id = await fixtureProjectId(join(runDirectory, 'fixtures', domain));
    const previous = checkpoint.projectIds[domain];
    if (previous && previous !== id) throw new Error('FIXTURE_PROJECT_CHANGED');
    checkpoint.projectIds[domain] = id;
  }
  await atomicCheckpoint(checkpointPath, checkpoint);
}

async function ensureRunAgentDirectory(
  options: RunOptions,
  runDirectory: string,
  domains: readonly BenchmarkDomain[],
): Promise<string> {
  const agentDirectory = join(runDirectory, 'agent');
  await ensurePrivateDirectory(agentDirectory);
  const projects = domains.map(domain => ({
    root: join(runDirectory, 'fixtures', domain),
    maxBytes: DEFAULT_PROJECT_QUOTA_BYTES,
    cleanupMode: 'auto',
    enabled: true,
  }));
  const configText = `${JSON.stringify({
    version: 1,
    defaults: { maxBytes: DEFAULT_PROJECT_QUOTA_BYTES, cleanupMode: 'auto' },
    projects,
  }, null, 2)}\n`;
  const configPath = join(agentDirectory, 'pi-context.json');
  const existingConfig = await readFile(configPath, 'utf8').catch(() => null);
  if (existingConfig === null) await writeFile(configPath, configText, { flag: 'wx', mode: 0o600 });
  else if (existingConfig !== configText) throw new Error('RUN_AGENT_CONFIG_CHANGED');
  await chmod(configPath, 0o600);

  const authPath = sourceAuthPath(options);
  const linkPath = join(agentDirectory, 'auth.json');
  const authOverrideIsFake = options.testOnly?.authAvailable === true && options.testOnly.authPath === undefined;
  const existingLink = await lstat(linkPath).catch(() => null);
  if (authOverrideIsFake) {
    if (existingLink) throw new Error('UNEXPECTED_RUN_AUTH_FILE');
    return agentDirectory;
  }
  if (existingLink === null) {
    const sourceInfo = await lstat(authPath).catch(() => null);
    if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isSymbolicLink())) throw new Error('MODEL_AUTH_NOT_AVAILABLE');
    await symlink(authPath, linkPath);
  } else {
    if (!existingLink.isSymbolicLink() || resolve(await readlink(linkPath)) !== resolve(authPath)) {
      throw new Error('RUN_AUTH_LINK_CHANGED');
    }
  }
  return agentDirectory;
}

function makeRunName(set: 'pilot' | 'full'): string {
  return `${set}-${randomUUID().slice(0, 8)}`;
}

function currentTime(): string {
  return new Date().toISOString();
}

function reportFilename(runName: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/gu, '-');
  return `${timestamp}-${runName}.md`;
}

function markdownEscape(value: string): string {
  return value.replace(/[|\r\n]/gu, ' ');
}

function usd(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(6)}`;
}

function costText(cost: CostEstimate | null, piOnly = false): string {
  if (!cost) return 'unknown';
  const amount = piOnly ? cost.estimatedPiUsd : cost.usd;
  const reason = piOnly && amount !== null ? null : cost.reason;
  return `${usd(amount)}${reason ? ` (${markdownEscape(reason)})` : ''}`;
}

function accuracyLines(report: RunReport): string[] {
  if (report.status !== 'complete') return [];
  const groups = new Map<string, { count: number; pluginCorrect: number; controlCorrect: number }>();
  for (const row of report.cases) {
    if (row.pluginScore === null || row.controlScore === null) throw new Error('AGGREGATE_WITH_UNSCORED_CASE');
    for (const key of [`domain:${row.domain}`, `type:${row.questionType}`]) {
      const group = groups.get(key) ?? { count: 0, pluginCorrect: 0, controlCorrect: 0 };
      group.count += 1;
      if (row.pluginScore) group.pluginCorrect += 1;
      if (row.controlScore) group.controlCorrect += 1;
      groups.set(key, group);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => compareText(left, right)).map(([name, group]) => {
    const plugin = (group.pluginCorrect / group.count * 100).toFixed(1);
    const control = (group.controlCorrect / group.count * 100).toFixed(1);
    return `- ${name}: plugin ${group.pluginCorrect}/${group.count} (${plugin}%), control ${group.controlCorrect}/${group.count} (${control}%)`;
  });
}

function reportMarkdown(report: RunReport): string {
  const cases = report.cases.length === 0
    ? '| none | - | - | - | - | - |\n'
    : report.cases.map(row => `| ${markdownEscape(row.id)} | ${row.domain} | ${markdownEscape(row.questionType)} | ${row.status} | ${row.pluginScore === null ? 'pending' : row.pluginScore ? 'correct' : 'incorrect'} | ${row.controlScore === null ? 'pending' : row.controlScore ? 'correct' : 'incorrect'} |\n`).join('');
  const measured = report.measuredUsage;
  return [
    '# LongMemEval-V2 adapted benchmark result',
    '',
    `- Status: **${report.status}**`,
    `- Run: ${markdownEscape(report.runName)}`,
    `- Dataset revision: ${report.dataRevision ?? 'unknown'}`,
    `- Dataset source hashes: ${report.sourceHashes ? Object.entries(report.sourceHashes).map(([path, hash]) => `${path}=${hash}`).join('; ') : 'unknown'}`,
    `- Eligible cases: ${report.eligibleCount}`,
    `- Excluded image cases: ${report.excludedCount}`,
    `- Model: ${markdownEscape(report.model)}`,
    `- Thinking: ${markdownEscape(report.thinking)}`,
    `- Plugin source: ${report.pluginSource ?? 'unknown'}`,
    `- Plugin fingerprint: ${report.pluginFingerprint ?? 'unknown'}`,
    `- Runner fingerprint: ${report.runnerFingerprint ?? 'unknown'}`,
    `- Actual provider/model: ${report.actualModelIdentity ? markdownEscape(report.actualModelIdentity) : 'unknown'}`,
    `- Project ID: ${report.projectId ? markdownEscape(report.projectId) : 'unknown'}`,
    `- Planned history chunks: ${report.historyChunkCount}`,
    `- Planned answer sessions: ${report.answerSessionCount}`,
    `- Planned Pi calls: ${report.historyChunkCount + report.answerSessionCount}`,
    `- Planned semantic judge calls: ${report.plannedJudgeCallCount}`,
    `- Actual semantic grade calls: ${report.judgeCallCount}`,
    `- Measured tokens: ${measured.totalTokens} total (${measured.input} input, ${measured.output} output, ${measured.cacheRead} cache read, ${measured.cacheWrite} cache write)`,
    `- Measured tokens by stage: ${report.ingestionCost?.usage?.totalTokens ?? 'not run'} ingestion, ${report.pluginAnswerCost?.usage?.totalTokens ?? 'not run'} plugin answers, ${report.controlCost?.usage?.totalTokens ?? 'not run'} control answers`,
    `- Pi-reported USD: ${usd(measured.reportedUsd)}`,
    `- Rough preflight tokens: ${report.ingestionCost?.ingestion?.totalTokens ?? 0} ingestion, ${report.pluginAnswerCost?.question?.totalTokens ?? 0} plugin answers, ${report.controlCost?.question?.totalTokens ?? 0} control answers, ${report.judgeCost?.judge.inputTokens ?? 'unknown'} judge input, ${report.judgeCost?.judge.outputTokens ?? 'unknown'} judge output`,
    `- Ingestion cost: ${costText(report.ingestionCost, true)}`,
    `- Plugin answer cost: ${costText(report.pluginAnswerCost, true)}`,
    `- Control cost: ${costText(report.controlCost, true)}`,
    `- Semantic judge API-rate comparison (not a subscription charge): ${costText(report.judgeCost)}`,
    `- Model visible: ${report.modelVisible === null ? 'unknown' : report.modelVisible ? 'yes' : 'no'}`,
    `- Pi auth file present: ${report.authAvailable === null ? 'unknown' : report.authAvailable ? 'yes' : 'no'}`,
    `- Available output storage: ${report.storageAvailableBytes === null ? 'unknown' : `${report.storageAvailableBytes} bytes`}`,
    `- Excluded image case IDs: ${report.excludedIds.length ? report.excludedIds.join(', ') : 'none'}`,
    `- Failure code: ${report.failureCode ?? 'none'}`,
    '',
    'This is an adapted, non-official text-only result. It is not a 451-question score. The reader model and memory interface differ from the official benchmark. The selected `-abs` case uses semantic grading. Pi-context stores model-selected facts, not full transcripts. The private run config sets a 10 MiB quota for each domain project. Model-selected records can still exceed quota. Rough estimates use UTF-8 history bytes divided by four, 1,024 input and 512 output tokens per Pi session, and 1,024 input and 256 output tokens per judge call. These values are not maximums.',
    '',
    'This report contains no prompts, gold answers, evaluator specifications, credentials, raw logs, or filesystem paths.',
    '',
    ...(report.status === 'complete' ? ['## Accuracy by domain and question type', '', ...accuracyLines(report), ''] : []),
    '## Cases',
    '',
    '| Case ID | Domain | Type | Status | Plugin | Control |',
    '|---|---|---|---|---|---|',
    cases.trimEnd(),
    '',
    ...(report.warnings.length ? ['## Warnings', '', ...report.warnings.map(warning => `- ${markdownEscape(warning)}`), ''] : []),
  ].join('\n');
}

async function writeReport(report: Omit<RunReport, 'reportPath'>): Promise<string> {
  const directory = join(PACKAGE_ROOT, 'docs', 'benchmarks');
  await mkdir(directory, { recursive: true });
  const path = join(directory, reportFilename(report.runName));
  const text = reportMarkdown({ ...report, reportPath: path });
  await writeFile(path, `${text}\n`, { flag: 'wx', mode: 0o644 });
  await chmod(path, 0o644);
  return path;
}

export async function writeInvocationFailureReport(runName: string, failureCode: string, model = 'unknown', thinking = 'unknown'): Promise<string> {
  const base: Omit<RunReport, 'reportPath'> = {
    status: 'incomplete', runName, runDirectory: null, dataRevision: null, sourceHashes: null,
    pluginFingerprint: null, pluginGitRevision: null, runnerFingerprint: null, pluginSource: null,
    actualModelIdentity: null, model, thinking, projectId: null, eligibleCount: 0, excludedCount: 0, excludedIds: [],
    historyChunkCount: 0, answerSessionCount: 0, plannedJudgeCallCount: 0, modelVisible: null, authAvailable: null,
    storageAvailableBytes: null, warnings: [], failureCode, measuredUsage: initialUsage(),
    ingestionCost: null, pluginAnswerCost: null, controlCost: null, judgeCost: null, judgeCallCount: 0, cases: [],
  };
  return writeReport(base);
}

function emptyCaseRows(selected: QuestionCase[]): RunReport['cases'] {
  return selected.map(question => ({
    id: question.id,
    domain: question.domain,
    questionType: question.questionType,
    status: 'pending',
    pluginScore: null,
    controlScore: null,
  }));
}

function baseReport(
  options: RunOptions,
  runName: string,
  selected: QuestionCase[] = [],
  dataset?: BenchmarkDataset,
  preflight?: PreflightData,
  runDirectory: string | null = null,
): Omit<RunReport, 'reportPath'> {
  return {
    status: 'preflight',
    runName,
    runDirectory,
    dataRevision: dataset?.datasetRevision ?? null,
    sourceHashes: dataset?.sourceHashes ?? null,
    pluginFingerprint: preflight?.pluginFingerprint ?? null,
    pluginGitRevision: preflight?.pluginGitRevision ?? null,
    runnerFingerprint: preflight?.runnerFingerprint ?? null,
    pluginSource: preflight ? (preflight.pluginGitRevision ?? `source-fingerprint:${preflight.pluginFingerprint}`) : null,
    actualModelIdentity: null,
    model: options.model,
    thinking: options.thinking,
    projectId: null,
    eligibleCount: selected.length,
    excludedCount: dataset?.excludedImageQuestionIds.length ?? 0,
    excludedIds: dataset?.excludedImageQuestionIds ?? [],
    historyChunkCount: preflight?.historyChunkCount ?? 0,
    answerSessionCount: selected.length * 2,
    plannedJudgeCallCount: preflight ? preflight.semanticCaseIds.size * 2 : 0,
    modelVisible: preflight?.modelVisible ?? null,
    authAvailable: preflight?.authAvailable ?? null,
    storageAvailableBytes: preflight?.storageAvailableBytes ?? null,
    warnings: preflight?.warnings ?? [],
    failureCode: null,
    measuredUsage: initialUsage(),
    ingestionCost: preflight ? estimatePreflight({
      historyBytes: [...preflight.historyBytes.values()].reduce((sum, value) => sum + value, 0),
      questionCount: 0,
      sessionCount: preflight.historyChunkCount,
      judgeCallCount: 0,
      rates: preflight.rates,
    }) : null,
    pluginAnswerCost: preflight ? estimatePreflight({
      historyBytes: 0, questionCount: selected.length, sessionCount: selected.length,
      judgeCallCount: 0, rates: preflight.rates,
    }) : null,
    controlCost: preflight ? estimatePreflight({
      historyBytes: 0, questionCount: selected.length, sessionCount: selected.length,
      judgeCallCount: 0, rates: preflight.rates,
    }) : null,
    judgeCost: preflight ? estimatePreflight({
      historyBytes: 0, questionCount: 0, sessionCount: 0,
      judgeCallCount: preflight.semanticCaseIds.size * 2, rates: preflight.rates,
    }) : null,
    judgeCallCount: 0,
    cases: emptyCaseRows(selected),
  };
}

function makeIdentity(options: RunOptions, preflight: PreflightData, selected: QuestionCase[]): Checkpoint['identity'] {
  return {
    dataRevision: preflight.dataset.datasetRevision,
    sourceHashes: preflight.dataset.sourceHashes,
    set: options.set,
    tier: 'small',
    pilotIds: options.set === 'pilot' ? selected.map(question => question.id) : [],
    model: options.model,
    thinking: options.thinking,
    pluginFingerprint: preflight.pluginFingerprint,
    runnerFingerprint: preflight.runnerFingerprint,
    ratesFingerprint: preflight.ratesFingerprint,
    quotaAssumptionBytes: DEFAULT_PROJECT_QUOTA_BYTES,
    upstreamRevision: preflight.upstreamRevision,
  };
}

function identitiesMatch(left: Checkpoint['identity'], right: Checkpoint['identity']): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function readCheckpoint(path: string): Promise<Checkpoint> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; } catch { throw new Error('CHECKPOINT_INVALID'); }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.identity) || !isRecord(parsed.stages) ||
      (parsed.status !== 'running' && parsed.status !== 'complete' && parsed.status !== 'incomplete') ||
      typeof parsed.runName !== 'string' || typeof parsed.updatedAt !== 'string') {
    throw new Error('CHECKPOINT_INVALID');
  }
  return parsed as unknown as Checkpoint;
}

function initialCheckpoint(runName: string, identity: Checkpoint['identity']): Checkpoint {
  return {
    version: 1,
    status: 'running',
    identity,
    runName,
    stages: {},
    projectIds: {},
    failure: null,
    updatedAt: currentTime(),
  };
}

function setStage(checkpoint: Checkpoint, stage: StageCheckpoint): void {
  checkpoint.stages[stage.key] = stage;
  checkpoint.updatedAt = currentTime();
}

function stageCompleted(checkpoint: Checkpoint, key: string): StageCheckpoint | null {
  const stage = checkpoint.stages[key];
  return stage?.status === 'complete' ? stage : null;
}

async function reusablePiStage(
  runDirectory: string,
  checkpoint: Checkpoint,
  checkpointPath: string,
  key: string,
  model: string,
): Promise<boolean> {
  const stage = stageCompleted(checkpoint, key);
  if (!stage) return false;
  const paths = stagePaths(runDirectory, key);
  const text = await readJsonl(paths.stdout);
  const requireRecord = stage.kind === 'history';
  const recovered = text === null ? null : validPiLog(text, model, requireRecord);
  if (recovered?.valid && stage.actualModel?.provider === recovered.actualModel?.provider &&
      stage.actualModel?.model === recovered.actualModel?.model &&
      stage.actualModel?.responseModel === recovered.actualModel?.responseModel &&
      (stage.kind !== 'answer' || stage.answer === recovered.answer)) return true;
  if (stage.kind === 'answer' && stage.mode === 'control') {
    delete checkpoint.stages[key];
    await Promise.all([
      rm(paths.stdout, { force: true }), rm(paths.stderr, { force: true }), rm(paths.session, { force: true }),
    ]);
    await atomicCheckpoint(checkpointPath, checkpoint);
    return false;
  }
  const ambiguous: StageCheckpoint = {
    ...stage,
    status: 'ambiguous',
    errorCode: 'STAGE_LOG_AMBIGUOUS',
  };
  setStage(checkpoint, ambiguous);
  recordCheckpointFailure(checkpoint, 'STAGE_LOG_AMBIGUOUS', key);
  await atomicCheckpoint(checkpointPath, checkpoint);
  throw new Error('STAGE_LOG_AMBIGUOUS');
}

async function prepareCheckpoint(
  options: RunOptions,
  preflight: PreflightData,
  selected: QuestionCase[],
  runName: string,
  runDirectory: string,
): Promise<{ checkpoint: Checkpoint; isNew: boolean }> {
  const checkpointPath = join(runDirectory, 'checkpoint.json');
  const identity = makeIdentity(options, preflight, selected);
  if (options.resumeDir) {
    if (resolve(options.resumeDir) !== resolve(runDirectory)) throw new Error('RESUME_DIRECTORY_MISMATCH');
    const info = await lstat(runDirectory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('RESUME_DIRECTORY_INVALID');
    const checkpoint = await readCheckpoint(checkpointPath);
    if (!identitiesMatch(checkpoint.identity, identity)) throw new Error('STALE_RESUME_INPUTS');
    if (checkpoint.status === 'complete') throw new Error('RUN_ALREADY_COMPLETE');
    await chmod(runDirectory, 0o700);
    return { checkpoint, isNew: false };
  }
  await ensurePrivateDirectory(runDirectory);
  await ensurePrivateDirectory(join(runDirectory, 'sessions'));
  const checkpoint = initialCheckpoint(runName, identity);
  await atomicCheckpoint(checkpointPath, checkpoint);
  return { checkpoint, isNew: true };
}

async function makeOutputRunDirectory(outputRoot: string, runName: string): Promise<string> {
  const resolvedOutputRoot = resolve(outputRoot);
  assertOutputRootAllowed(resolvedOutputRoot);
  if (isWithin(PRIVATE_OUTPUT_ROOT, resolvedOutputRoot)) await ensurePrivateDirectory(PRIVATE_OUTPUT_ROOT);
  await ensurePrivateDirectory(resolvedOutputRoot);
  const parent = join(resolvedOutputRoot, 'longmemeval-v2');
  await ensurePrivateDirectory(parent);
  const directory = join(parent, runName);
  await ensurePrivateDirectory(directory);
  await ensurePrivateDirectory(join(directory, 'sessions'));
  return directory;
}

async function runGitInitForDomains(runDirectory: string, selected: QuestionCase[], isNew: boolean): Promise<void> {
  const domains = [...new Set(selected.map(question => question.domain))].sort(compareText) as BenchmarkDomain[];
  await ensureFixtures(runDirectory, domains, isNew);
}

function sumStageUsage(checkpoint: Checkpoint, kinds: readonly StageCheckpoint['kind'][]): UsageTotals {
  const stages = Object.values(checkpoint.stages).filter(stage => kinds.includes(stage.kind));
  return combineUsage(stages.map(stage => usageFromCount(stage.usage)));
}

function countGradeCalls(checkpoint: Checkpoint): number {
  return Object.values(checkpoint.stages).filter(stage =>
    stage.kind === 'grade' && stage.semanticJudge === true && stage.errorCode !== 'MODEL_AUTH_NOT_AVAILABLE',
  ).length;
}

function recordCheckpointFailure(checkpoint: Checkpoint, code: string, stage: string): void {
  checkpoint.status = 'incomplete';
  checkpoint.failure = { code, stage };
  checkpoint.updatedAt = currentTime();
}

async function createMissingAuthGrades(
  runDirectory: string,
  checkpoint: Checkpoint,
  checkpointPath: string,
  selected: QuestionCase[],
  rawQuestions: Map<string, RawQuestion>,
): Promise<void> {
  await ensurePrivateDirectory(join(runDirectory, 'sessions'));
  for (const question of selected) {
    const raw = rawQuestions.get(question.id);
    if (!raw) throw new Error(`RAW_QUESTION_MISSING_${question.id}`);
    const evaluator = semanticEvaluator(raw);
    for (const mode of ['memory', 'control'] as const) {
      const key = `grade-${question.id}-${mode}`;
      if (checkpoint.stages[key]) continue;
      const paths = stagePaths(runDirectory, key);
      const stdoutExists = await lstat(paths.stdout).then(() => true, () => false);
      const stderrExists = await lstat(paths.stderr).then(() => true, () => false);
      if (stdoutExists || stderrExists) continue;
      const score: ScoreResult = {
        id: question.id,
        score: false,
        evalName: evaluator ?? raw.eval_function,
        parsedAnswer: '',
        isUnknown: false,
        semanticJudge: evaluator !== null,
        judgeUsage: evaluator ? null : { callCount: 0 },
      };
      await writeFile(paths.stdout, `${JSON.stringify(score)}\n`, { flag: 'wx', mode: 0o600 });
      await writeFile(paths.stderr, 'MODEL_AUTH_NOT_AVAILABLE\n', { flag: 'wx', mode: 0o600 });
      await chmod(paths.stdout, 0o600);
      await chmod(paths.stderr, 0o600);
      setStage(checkpoint, {
        status: 'failed', key, kind: 'grade', caseId: question.id, mode,
        stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
        session: null, usage: initialUsage(), actualModel: null, score,
        semanticJudge: false, errorCode: 'MODEL_AUTH_NOT_AVAILABLE',
      });
      await atomicCheckpoint(checkpointPath, checkpoint);
    }
  }
}

async function restoreSyntheticAuthGrades(
  runDirectory: string,
  checkpoint: Checkpoint,
  checkpointPath: string,
): Promise<void> {
  let changed = false;
  for (const [key, stage] of Object.entries(checkpoint.stages)) {
    if (stage.kind !== 'grade' || stage.errorCode !== 'MODEL_AUTH_NOT_AVAILABLE') continue;
    const paths = stagePaths(runDirectory, key);
    await Promise.all([
      rm(paths.stdout, { force: true }),
      rm(paths.stderr, { force: true }),
      rm(paths.session, { force: true }),
    ]);
    delete checkpoint.stages[key];
    changed = true;
  }
  if (!changed) return;
  if (checkpoint.failure?.code === 'MODEL_AUTH_NOT_AVAILABLE') checkpoint.failure = null;
  checkpoint.status = 'running';
  checkpoint.updatedAt = currentTime();
  await atomicCheckpoint(checkpointPath, checkpoint);
}

function errorEvidence(error: unknown): { usage: UsageTotals; actualModel: StageCheckpoint['actualModel']; session: string | null } {
  if (error instanceof PiSessionError && error.evidence) {
    return {
      usage: error.evidence.usage,
      actualModel: error.evidence.actualModel,
      session: error.evidence.session.sessionId,
    };
  }
  return { usage: initialUsage(), actualModel: null, session: null };
}

async function runPiStage(
  options: RunOptions,
  runDirectory: string,
  checkpoint: Checkpoint,
  preflight: PreflightData,
  input: {
    key: string;
    kind: 'history' | 'answer';
    cwd: string;
    mode: 'memory' | 'control';
    prompt: string;
    caseId?: string;
    domain?: BenchmarkDomain;
    requireRecord?: boolean;
  },
  checkpointPath: string,
): Promise<StageCheckpoint> {
  const paths = stagePaths(runDirectory, input.key);
  const existingText = await readJsonl(paths.stdout);
  if (existingText !== null) {
    const recovered = validPiLog(existingText, options.model, input.requireRecord === true);
    if (!recovered.valid) {
      const stage: StageCheckpoint = {
        status: 'ambiguous', key: input.key, kind: input.kind,
        ...(input.caseId ? { caseId: input.caseId } : {}), mode: input.mode,
        ...(input.domain ? { domain: input.domain } : {}),
        stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
        session: recovered.session, usage: recovered.usage, actualModel: recovered.actualModel,
        errorCode: 'STAGE_LOG_AMBIGUOUS',
      };
      setStage(checkpoint, stage);
      recordCheckpointFailure(checkpoint, 'STAGE_LOG_AMBIGUOUS', input.key);
      await atomicCheckpoint(checkpointPath, checkpoint);
      throw new Error('STAGE_LOG_AMBIGUOUS');
    }
    const stage: StageCheckpoint = {
      status: 'complete', key: input.key, kind: input.kind,
      ...(input.caseId ? { caseId: input.caseId } : {}), mode: input.mode,
      ...(input.domain ? { domain: input.domain } : {}),
      stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
      session: recovered.session, usage: recovered.usage, actualModel: recovered.actualModel,
      ...(input.kind === 'answer' ? { answer: recovered.answer } : {}),
    };
    setStage(checkpoint, stage);
    if (recovered.projectId && input.domain) checkpoint.projectIds[input.domain] = recovered.projectId;
    await atomicCheckpoint(checkpointPath, checkpoint);
    return stage;
  }

  const piInput: PiSessionInput = {
    cwd: input.cwd,
    sessionFile: paths.session,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
    prompt: input.prompt,
    model: options.model,
    thinking: options.thinking,
    mode: input.mode,
    extensionPath: PACKAGE_ROOT,
    timeoutMs: 5 * 60 * 1_000,
    maxStdoutBytes: OUTPUT_LIMIT_BYTES,
    ...(options.testOnly?.piExecutablePath ? { testOnlyExecutablePath: options.testOnly.piExecutablePath } : {}),
    ...(options.testOnly?.piExecutableArgs ? { testOnlyExecutableArgs: options.testOnly.piExecutableArgs } : {}),
    ...(input.mode === 'memory' ? { env: { PI_CODING_AGENT_DIR: join(runDirectory, 'agent') } } : {}),
  };
  try {
    const result = await runPiSession(piInput);
    await chmod(paths.session, 0o600).catch(() => undefined);
    if (input.requireRecord && !result.toolActions.some(action => action.action === 'record' && action.valid)) {
      throw new Error('HISTORY_RECORD_MISSING');
    }
    if (!modelMatches(result.actualModel, options.model)) throw new Error('MODEL_MISMATCH');
    const actualIdentity = result.actualModel;
    const previousModels = Object.values(checkpoint.stages)
      .filter(stage => stage.status === 'complete' && stage.actualModel)
      .map(stage => stage.actualModel as NonNullable<StageCheckpoint['actualModel']>);
    if (previousModels.some(previous => previous.provider !== actualIdentity?.provider || previous.model !== actualIdentity?.model || previous.responseModel !== actualIdentity?.responseModel)) {
      throw new Error('MODEL_IDENTITY_CHANGED');
    }
    const projectId = result.toolActions.find(action => action.details && typeof action.details.projectId === 'string')?.details?.projectId;
    if (typeof projectId === 'string' && input.domain) {
      const previousProjectId = checkpoint.projectIds[input.domain];
      if (previousProjectId && previousProjectId !== projectId) throw new Error('PROJECT_ID_CHANGED');
      checkpoint.projectIds[input.domain] = projectId;
    }
    const stage: StageCheckpoint = {
      status: 'complete', key: input.key, kind: input.kind,
      ...(input.caseId ? { caseId: input.caseId } : {}), mode: input.mode,
      ...(input.domain ? { domain: input.domain } : {}),
      stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
      session: result.session.sessionId, usage: result.usage, actualModel: actualIdentity,
      ...(input.kind === 'answer' ? { answer: result.answer } : {}),
    };
    setStage(checkpoint, stage);
    await atomicCheckpoint(checkpointPath, checkpoint);
    return stage;
  } catch (error) {
    await chmod(paths.session, 0o600).catch(() => undefined);
    const evidence = errorEvidence(error);
    let usage = evidence.usage;
    const logged = await readJsonl(paths.stdout);
    if (logged !== null) {
      const parsed = parseJsonl(logged);
      if (parsed.events.length > 0) usage = safeUsage(parsed.events);
    }
    const code = safeCode(error);
    const stage: StageCheckpoint = {
      status: 'failed', key: input.key, kind: input.kind,
      ...(input.caseId ? { caseId: input.caseId } : {}), mode: input.mode,
      ...(input.domain ? { domain: input.domain } : {}),
      stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
      session: evidence.session, usage, actualModel: evidence.actualModel, errorCode: code,
    };
    setStage(checkpoint, stage);
    recordCheckpointFailure(checkpoint, code, input.key);
    await atomicCheckpoint(checkpointPath, checkpoint);
    throw error;
  }
}

async function runScorer(
  options: RunOptions,
  runDirectory: string,
  checkpoint: Checkpoint,
  checkpointPath: string,
  input: { key: string; question: RawQuestion; answer: string; caseId: string; mode: 'memory' | 'control'; execute: boolean },
): Promise<ScoreResult> {
  const paths = stagePaths(runDirectory, input.key);
  const existing = await readJsonl(paths.stdout);
  if (existing !== null) {
    const recovered = parseScoreOutput(existing, input.caseId);
    if (!recovered) {
      const stage: StageCheckpoint = {
        status: 'ambiguous', key: input.key, kind: 'grade', caseId: input.caseId, mode: input.mode,
        stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
        session: null, usage: initialUsage(), actualModel: null, semanticJudge: input.execute, errorCode: 'GRADE_LOG_AMBIGUOUS',
      };
      setStage(checkpoint, stage);
      recordCheckpointFailure(checkpoint, 'GRADE_LOG_AMBIGUOUS', input.key);
      await atomicCheckpoint(checkpointPath, checkpoint);
      throw new Error('GRADE_LOG_AMBIGUOUS');
    }
    const stage: StageCheckpoint = {
      status: 'complete', key: input.key, kind: 'grade', caseId: input.caseId, mode: input.mode,
      stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
      session: null, usage: initialUsage(), actualModel: null, score: recovered, semanticJudge: recovered.semanticJudge,
    };
    setStage(checkpoint, stage);
    await atomicCheckpoint(checkpointPath, checkpoint);
    return recovered;
  }
  await ensurePrivateDirectory(dirname(paths.stdout));
  const python = options.testOnly?.graderExecutablePath ?? findPythonExecutable();
  if (!python) throw new Error('PYTHON_311_NOT_CONFIGURED');
  const pythonArgs = [
    ...(options.testOnly?.graderExecutableArgs ?? []),
    ...(options.testOnly?.graderExecutablePath ? [] : [join(PACKAGE_ROOT, 'scripts', 'longmemeval-v2', 'score.py')]),
    ...(input.execute ? ['--prepare-semantic'] : []),
  ];
  const payload = JSON.stringify({ question: input.question, responseRaw: input.answer });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(python, pythonArgs, {
      cwd: options.upstreamRoot,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LME_UPSTREAM: options.upstreamRoot, PYTHONDONTWRITEBYTECODE: '1' },
    });
  } catch {
    throw new Error('GRADER_SPAWN_FAILED');
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= OUTPUT_LIMIT_BYTES) stdout.push(chunk);
    else child.kill('SIGKILL');
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    const remain = STDERR_LIMIT_BYTES - stderrBytes;
    if (remain > 0) stderr.push(chunk.subarray(0, remain));
    stderrBytes += Math.min(chunk.length, Math.max(remain, 0));
  });
  const stdoutFile = await open(paths.stdout, 'wx', 0o600);
  const stderrFile = await open(paths.stderr, 'wx', 0o600);
  await stdoutFile.close();
  await stderrFile.close();
  await chmod(paths.stdout, 0o600);
  await chmod(paths.stderr, 0o600);
  child.stdin!.end(payload);
  let exitCode: number | null;
  try {
    exitCode = await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5 * 60 * 1_000);
      timer.unref();
      child.once('error', () => {
        clearTimeout(timer);
        rejectExit(new Error('GRADER_SPAWN_FAILED'));
      });
      child.once('close', code => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
  } catch {
    throw new Error('GRADER_SPAWN_FAILED');
  }
  const outText = Buffer.concat(stdout).toString('utf8');
  const errText = Buffer.concat(stderr).toString('utf8');
  await writeFile(paths.stdout, outText, { mode: 0o600 });
  await writeFile(paths.stderr, errText, { mode: 0o600 });
  if (exitCode !== 0 || stdoutBytes > OUTPUT_LIMIT_BYTES) {
    const code = /SCORE_ERROR\s+case_id=[A-Za-z0-9_-]+\s+code=([A-Z0-9_]+)/u.exec(errText)?.[1] ?? 'GRADER_FAILED';
    const failed: StageCheckpoint = {
      status: 'failed', key: input.key, kind: 'grade', caseId: input.caseId, mode: input.mode,
      stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
      session: null, usage: initialUsage(), actualModel: null, semanticJudge: false, errorCode: code,
    };
    setStage(checkpoint, failed);
    recordCheckpointFailure(checkpoint, code, input.key);
    await atomicCheckpoint(checkpointPath, checkpoint);
    throw new Error(code);
  }
  if (input.execute) {
    const expectedEvaluator = semanticEvaluator(input.question);
    const prepared = expectedEvaluator
      ? parseSemanticPreparationOutput(outText, input.caseId, expectedEvaluator)
      : null;
    if (!prepared) {
      const failed: StageCheckpoint = {
        status: 'failed', key: input.key, kind: 'grade', caseId: input.caseId, mode: input.mode,
        stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
        session: null, usage: initialUsage(), actualModel: null, semanticJudge: false,
        errorCode: 'SEMANTIC_METADATA_INVALID',
      };
      setStage(checkpoint, failed);
      recordCheckpointFailure(checkpoint, 'SEMANTIC_METADATA_INVALID', input.key);
      await atomicCheckpoint(checkpointPath, checkpoint);
      throw new Error('SEMANTIC_METADATA_INVALID');
    }
    const judged = await judgeSemanticCase({
      question: input.question.question,
      answer: input.question.answer,
      responseRaw: input.answer,
      parsedAnswer: prepared.parsedAnswer,
      evaluator: prepared.evalName,
      cwd: runDirectory,
      authDirectory: join(runDirectory, 'agent'),
      ...(options.testOnly?.piExecutablePath ? { testOnlyExecutablePath: options.testOnly.piExecutablePath } : {}),
      ...(options.testOnly?.piExecutableArgs ? { testOnlyExecutableArgs: options.testOnly.piExecutableArgs } : {}),
    });
    const score: ScoreResult = {
      id: prepared.id,
      score: !prepared.isUnknown && judged.score,
      evalName: prepared.evalName,
      parsedAnswer: prepared.parsedAnswer,
      isUnknown: prepared.isUnknown,
      semanticJudge: true,
      judgeUsage: null,
    };
    const errorCode = judged.errorCode && /^[A-Z0-9_]+$/u.test(judged.errorCode) ? judged.errorCode : null;
    await writeFile(paths.stdout, `${JSON.stringify(score)}\n`, { mode: 0o600 });
    await writeFile(paths.stderr, errorCode ? `${errorCode}\n` : '', { mode: 0o600 });
    await chmod(paths.stdout, 0o600);
    await chmod(paths.stderr, 0o600);
    const stage: StageCheckpoint = {
      status: 'complete', key: input.key, kind: 'grade', caseId: input.caseId, mode: input.mode,
      stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
      session: null, usage: initialUsage(), actualModel: null, score, semanticJudge: true,
      ...(errorCode ? { errorCode } : {}),
    };
    setStage(checkpoint, stage);
    await atomicCheckpoint(checkpointPath, checkpoint);
    return score;
  }
  const score = parseScoreOutput(outText, input.caseId);
  if (!score) {
    const failed: StageCheckpoint = {
      status: 'failed', key: input.key, kind: 'grade', caseId: input.caseId, mode: input.mode,
      stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
      session: null, usage: initialUsage(), actualModel: null, semanticJudge: input.execute, errorCode: 'GRADE_OUTPUT_INVALID',
    };
    setStage(checkpoint, failed);
    recordCheckpointFailure(checkpoint, 'GRADE_OUTPUT_INVALID', input.key);
    await atomicCheckpoint(checkpointPath, checkpoint);
    throw new Error('GRADE_OUTPUT_INVALID');
  }
  const stage: StageCheckpoint = {
    status: 'complete', key: input.key, kind: 'grade', caseId: input.caseId, mode: input.mode,
    stdout: relative(runDirectory, paths.stdout), stderr: relative(runDirectory, paths.stderr),
    session: null, usage: initialUsage(), actualModel: null, score, semanticJudge: score.semanticJudge,
  };
  setStage(checkpoint, stage);
  await atomicCheckpoint(checkpointPath, checkpoint);
  return score;
}

function parseScoreOutput(text: string, expectedId: string): ScoreResult | null {
  const line = text.trim();
  if (!line || line.includes('\n')) return null;
  try {
    const value: unknown = JSON.parse(line) as unknown;
    if (!isRecord(value) || value.id !== expectedId || typeof value.score !== 'boolean' ||
        typeof value.evalName !== 'string' || typeof value.parsedAnswer !== 'string' ||
        typeof value.isUnknown !== 'boolean' || typeof value.semanticJudge !== 'boolean') return null;
    return {
      id: value.id,
      score: value.score,
      evalName: value.evalName,
      parsedAnswer: value.parsedAnswer,
      isUnknown: value.isUnknown,
      semanticJudge: value.semanticJudge,
      judgeUsage: value.judgeUsage,
    };
  } catch {
    return null;
  }
}

type SemanticPreparation = {
  id: string;
  evalName: 'llm_abstention_checker' | 'llm_gotchas_checker';
  parsedAnswer: string;
  isUnknown: boolean;
};

function parseSemanticPreparationOutput(
  text: string,
  expectedId: string,
  expectedEvaluator: SemanticPreparation['evalName'],
): SemanticPreparation | null {
  const line = text.trim();
  if (!line || line.includes('\n')) return null;
  try {
    const value: unknown = JSON.parse(line) as unknown;
    if (!isRecord(value) || value.id !== expectedId || value.evalName !== expectedEvaluator ||
        typeof value.parsedAnswer !== 'string' || typeof value.isUnknown !== 'boolean') return null;
    return {
      id: expectedId,
      evalName: expectedEvaluator,
      parsedAnswer: value.parsedAnswer,
      isUnknown: value.isUnknown,
    };
  } catch {
    return null;
  }
}

function refreshCaseResults(report: Omit<RunReport, 'reportPath'>, checkpoint: Checkpoint): void {
  report.cases = report.cases.map(row => {
    const pluginStage = checkpoint.stages[`grade-${row.id}-memory`];
    const controlStage = checkpoint.stages[`grade-${row.id}-control`];
    const syntheticFailure = (stage: StageCheckpoint | undefined): boolean =>
      stage?.status === 'failed' && stage.errorCode === 'MODEL_AUTH_NOT_AVAILABLE';
    const pluginScore = pluginStage?.status === 'complete' || syntheticFailure(pluginStage)
      ? pluginStage?.score?.score ?? null
      : null;
    const controlScore = controlStage?.status === 'complete' || syntheticFailure(controlStage)
      ? controlStage?.score?.score ?? null
      : null;
    const bothGradesComplete = pluginStage?.status === 'complete' && controlStage?.status === 'complete';
    return {
      ...row,
      status: bothGradesComplete ? 'scored' : 'incomplete',
      pluginScore,
      controlScore,
    };
  });
}

function finalizeCosts(report: Omit<RunReport, 'reportPath'>, checkpoint: Checkpoint, rates: ModelRates | null): void {
  report.measuredUsage = sumStageUsage(checkpoint, ['history', 'answer']);
  const firstModelStage = Object.values(checkpoint.stages).find(stage => stage.status === 'complete' && stage.actualModel);
  if (firstModelStage?.actualModel) {
    const identity = firstModelStage.actualModel;
    report.actualModelIdentity = [identity.provider, identity.model, identity.responseModel].filter(Boolean).join('/');
  }
  const ingestion = sumStageUsage(checkpoint, ['history']);
  const answerStages = Object.values(checkpoint.stages).filter(stage => stage.kind === 'answer');
  const pluginAnswers = combineUsage(answerStages.filter(stage => stage.mode === 'memory').map(stage => usageFromCount(stage.usage)));
  const controls = combineUsage(answerStages.filter(stage => stage.mode === 'control').map(stage => usageFromCount(stage.usage)));
  report.ingestionCost = estimateCost(ingestion, rates);
  report.pluginAnswerCost = estimateCost(pluginAnswers, rates);
  report.controlCost = estimateCost(controls, rates);
  report.judgeCallCount = countGradeCalls(checkpoint);
  report.judgeCost = estimatePreflight({
    historyBytes: 0, questionCount: 0, sessionCount: 0,
    judgeCallCount: report.judgeCallCount, rates,
  });
  const projectIds = Object.entries(checkpoint.projectIds).sort(([left], [right]) => compareText(left, right));
  report.projectId = projectIds.length > 0 ? projectIds.map(([domain, id]) => `${domain}:${id}`).join('; ') : null;
}

function incompleteReport(
  report: Omit<RunReport, 'reportPath'>,
  checkpoint: Checkpoint | null,
  rates: ModelRates | null,
  code: string,
): Omit<RunReport, 'reportPath'> {
  report.status = 'incomplete';
  report.failureCode = code;
  if (checkpoint) {
    checkpoint.status = 'incomplete';
    if (!checkpoint.failure) checkpoint.failure = { code, stage: 'run' };
    finalizeCosts(report, checkpoint, rates);
    refreshCaseResults(report, checkpoint);
  }
  return report;
}

async function executeBenchmark(
  options: RunOptions,
  runName: string,
  preflight: PreflightData,
  report: Omit<RunReport, 'reportPath'>,
): Promise<Omit<RunReport, 'reportPath'>> {
  if (!options.execute) {
    report.status = 'preflight';
    return report;
  }
  if (options.resumeDir && !options.execute) throw new Error('RESUME_REQUIRES_EXECUTE');
  const runDirectory = options.resumeDir
    ? resolve(options.resumeDir)
    : await makeOutputRunDirectory(options.outputRoot, runName);
  report.runDirectory = runDirectory;
  const { checkpoint, isNew } = await prepareCheckpoint(options, preflight, preflight.selected, runName, runDirectory);
  const checkpointPath = join(runDirectory, 'checkpoint.json');
  try {
    if (!preflight.modelVisible) throw new Error('MODEL_NOT_VISIBLE');
    if (preflight.storageAvailableBytes === null || preflight.storageAvailableBytes < MIN_FREE_BYTES) {
      throw new Error('OUTPUT_STORAGE_INSUFFICIENT');
    }
    if (!preflight.authAvailable) {
      const priorAnswerFailure = Object.values(checkpoint.stages).find(stage =>
        (stage.kind === 'answer' || stage.kind === 'history') && stage.status !== 'complete' &&
        stage.errorCode !== undefined && stage.errorCode !== 'MODEL_AUTH_NOT_AVAILABLE',
      );
      if (priorAnswerFailure) throw new Error(checkpoint.failure?.code ?? priorAnswerFailure.errorCode);
      await runGitInitForDomains(runDirectory, preflight.selected, isNew);
      await createMissingAuthGrades(runDirectory, checkpoint, checkpointPath, preflight.selected, preflight.rawQuestions);
      throw new Error('MODEL_AUTH_NOT_AVAILABLE');
    }
    await restoreSyntheticAuthGrades(runDirectory, checkpoint, checkpointPath);
    if (!preflight.graderAvailable) throw new Error('PYTHON_311_NOT_CONFIGURED');
    await ensurePrivateDirectory(join(runDirectory, 'sessions'));
    await runGitInitForDomains(runDirectory, preflight.selected, isNew);
    const domains = [...new Set(preflight.selected.map(question => question.domain))].sort(compareText) as BenchmarkDomain[];
    await recordFixtureProjectIds(checkpoint, runDirectory, domains, checkpointPath);
    await ensureRunAgentDirectory(options, runDirectory, domains);
    for (const domain of domains) {
      const chunks = preflight.history.get(domain) ?? [];
      for (const [index, chunk] of chunks.entries()) {
        const key = `history-${domain}-${String(index + 1).padStart(4, '0')}`;
        if (await reusablePiStage(runDirectory, checkpoint, checkpointPath, key, options.model)) continue;
        const prompt = [
          'Store this ordered history observation in project memory for later question answering.',
          'Use the project memory record tool. Do not add facts that are not in the observation.',
          'Return a short confirmation after the record operation succeeds.',
          '',
          chunk,
        ].join('\n');
        await runPiStage(options, runDirectory, checkpoint, preflight, {
          key, kind: 'history', cwd: join(runDirectory, 'fixtures', domain), mode: 'memory', prompt,
          domain, requireRecord: true,
        }, checkpointPath);
      }
    }

    for (const question of preflight.selected) {
      const workspace = join(runDirectory, 'fixtures', question.domain);
      const rawQuestion = preflight.rawQuestions.get(question.id);
      if (!rawQuestion) throw new Error(`RAW_QUESTION_MISSING_${question.id}`);
      const answerStages = new Map<'memory' | 'control', StageCheckpoint>();
      for (const mode of ['memory', 'control'] as const) {
        const key = `answer-${question.id}-${mode}`;
        let stage = stageCompleted(checkpoint, key);
        if (stage && !(await reusablePiStage(runDirectory, checkpoint, checkpointPath, key, options.model))) stage = null;
        if (!stage) {
          const modeText = mode === 'memory' ? 'Use project memory when useful.' : 'Do not use tools or stored memory.';
          const prompt = [
            'Answer this question using only information that is available in this session.',
            modeText,
            'Give your final answer in the form \\boxed{answer}. If you cannot answer, use \\boxed{UNKNOWN}.',
            '',
            question.question,
          ].join('\n');
          stage = await runPiStage(options, runDirectory, checkpoint, preflight, {
            key, kind: 'answer', cwd: workspace, mode, prompt, caseId: question.id,
          }, checkpointPath);
        }
        answerStages.set(mode, stage);
      }
      for (const mode of ['memory', 'control'] as const) {
        const key = `grade-${question.id}-${mode}`;
        if (stageCompleted(checkpoint, key)) continue;
        const answer = answerStages.get(mode)?.answer;
        if (!answer) throw new Error(`ANSWER_STAGE_MISSING_${question.id}_${mode}`);
        const score = await runScorer(options, runDirectory, checkpoint, checkpointPath, {
          key,
          question: rawQuestion,
          answer,
          caseId: question.id,
          mode,
          execute: preflight.semanticCaseIds.has(question.id),
        });
        if (score.semanticJudge) report.judgeCallCount += 1;
      }
      refreshCaseResults(report, checkpoint);
    }
    const allScored = report.cases.length === preflight.selected.length && report.cases.every(row => {
      const plugin = checkpoint.stages[`grade-${row.id}-memory`];
      const control = checkpoint.stages[`grade-${row.id}-control`];
      return plugin?.status === 'complete' && control?.status === 'complete';
    });
    if (!allScored) throw new Error('PAIRED_CASES_INCOMPLETE');
    checkpoint.status = 'complete';
    checkpoint.failure = null;
    checkpoint.updatedAt = currentTime();
    await atomicCheckpoint(checkpointPath, checkpoint);
    report.status = 'complete';
    report.failureCode = null;
    refreshCaseResults(report, checkpoint);
    finalizeCosts(report, checkpoint, preflight.rates);
    return report;
  } catch (error) {
    const code = checkpoint.failure?.code ?? safeCode(error);
    recordCheckpointFailure(checkpoint, code, checkpoint.failure?.stage ?? 'run');
    await atomicCheckpoint(checkpointPath, checkpoint);
    return incompleteReport(report, checkpoint, preflight.rates, code);
  }
}

export async function runBenchmark(options: RunOptions): Promise<RunReport> {
  const runName = options && (options.set === 'pilot' || options.set === 'full') ? makeRunName(options.set) : makeRunName('full');
  let report = baseReport(options, runName);
  let checkpoint: Checkpoint | null = null;
  let rates: ModelRates | null = null;
  let optionsValidated = false;
  try {
    validateOptions(options);
    optionsValidated = true;
    if (options.resumeDir) {
      const resumeParent = resolve(options.resumeDir);
      const outputParent = join(resolve(options.outputRoot), 'longmemeval-v2');
      if (!isWithin(outputParent, resumeParent)) throw new Error('RESUME_DIRECTORY_OUTSIDE_OUTPUT_ROOT');
      report.runName = relative(outputParent, resumeParent).split(sep).at(-1) ?? runName;
    }
    const preflight = await makePreflight(options);
    rates = preflight.rates;
    report = baseReport(options, report.runName, preflight.selected, preflight.dataset, preflight);
    if (options.resumeDir) {
      const path = join(resolve(options.resumeDir), 'checkpoint.json');
      checkpoint = await readCheckpoint(path);
      report.runDirectory = resolve(options.resumeDir);
    }
    if (!options.execute) {
      report.status = 'preflight';
      if (options.resumeDir) throw new Error('RESUME_REQUIRES_EXECUTE');
      const reportPath = await writeReport(report);
      return { ...report, reportPath };
    }
    const result = await executeBenchmark(options, report.runName, preflight, report);
    if (options.resumeDir) {
      const path = join(resolve(options.resumeDir), 'checkpoint.json');
      checkpoint = await readCheckpoint(path).catch(() => checkpoint);
    }
    const finalReport = result.status === 'incomplete'
      ? incompleteReport(result, checkpoint, rates, result.failureCode ?? 'RUN_INCOMPLETE')
      : result;
    const reportPath = await writeReport(finalReport);
    return { ...finalReport, reportPath };
  } catch (error) {
    const code = safeCode(error);
    report.status = 'incomplete';
    report.failureCode = code;
    report.warnings = [...report.warnings, `Run stopped with code ${code}.`];
    if (checkpoint) incompleteReport(report, checkpoint, rates, code);
    if (optionsValidated && options.execute && !options.resumeDir && report.runDirectory === null &&
        (isWithin(PACKAGE_ROOT, options.outputRoot) || !outputRootIsInGit(options.outputRoot))) {
      try {
        const runDirectory = await makeOutputRunDirectory(options.outputRoot, report.runName);
        const identity: Checkpoint['identity'] = {
          dataRevision: null,
          sourceHashes: options.testOnly?.expectedHashes ?? PINNED_SOURCE_HASHES,
          set: options.set,
          tier: 'small',
          pilotIds: [],
          model: options.model,
          thinking: options.thinking,
          pluginFingerprint: 'unavailable',
          runnerFingerprint: 'unavailable',
          ratesFingerprint: 'unavailable',
          quotaAssumptionBytes: DEFAULT_PROJECT_QUOTA_BYTES,
          upstreamRevision: 'unavailable',
        };
        const failedCheckpoint = initialCheckpoint(report.runName, identity);
        recordCheckpointFailure(failedCheckpoint, code, 'preflight');
        await atomicCheckpoint(join(runDirectory, 'checkpoint.json'), failedCheckpoint);
        report.runDirectory = runDirectory;
      } catch {
        report.warnings = [...report.warnings, 'A preflight checkpoint could not be written.'];
      }
    }
    const reportPath = await writeReport(report);
    return { ...report, reportPath };
  }
}

export async function runCli(args: readonly string[]): Promise<RunReport> {
  const options = parseRunArguments(args);
  return runBenchmark(options);
}

export function parseRunArguments(args: readonly string[]): RunOptions {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const recognized = new Set([
    '--data-root', '--upstream-root', '--set', '--model', '--thinking', '--output-root', '--rates-json', '--resume', '--execute',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag || !recognized.has(flag)) throw new Error(`UNKNOWN_FLAG_${(flag ?? '').replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase()}`);
    if (flag === '--execute') {
      if (booleans.has(flag) || values.has(flag)) throw new Error('DUPLICATE_FLAG_EXECUTE');
      booleans.add(flag);
      continue;
    }
    if (values.has(flag)) throw new Error(`DUPLICATE_FLAG_${flag.slice(2).replaceAll('-', '_').toUpperCase()}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`MISSING_FLAG_VALUE_${flag.slice(2).replaceAll('-', '_').toUpperCase()}`);
    values.set(flag, value);
    index += 1;
  }
  const required = ['--data-root', '--upstream-root', '--set', '--model', '--thinking', '--output-root'] as const;
  for (const flag of required) if (!values.has(flag)) throw new Error(`REQUIRED_FLAG_MISSING_${flag.slice(2).replaceAll('-', '_').toUpperCase()}`);
  const setValue = values.get('--set');
  if (setValue !== 'pilot' && setValue !== 'full') throw new Error('SET_INVALID');
  const options: RunOptions = {
    dataRoot: values.get('--data-root')!,
    upstreamRoot: values.get('--upstream-root')!,
    set: setValue,
    model: values.get('--model')!,
    thinking: values.get('--thinking')!,
    outputRoot: values.get('--output-root')!,
    execute: booleans.has('--execute'),
    ...(values.has('--rates-json') ? { ratesPath: values.get('--rates-json')! } : {}),
    ...(values.has('--resume') ? { resumeDir: values.get('--resume')! } : {}),
  };
  validateOptions(options);
  return options;
}

export async function cliMain(args: readonly string[]): Promise<number> {
  try {
    const options = parseRunArguments(args);
    const report = await runBenchmark(options);
    process.stdout.write(`${JSON.stringify({ status: report.status, reportPath: report.reportPath, eligible: report.eligibleCount, excluded: report.excludedCount, failureCode: report.failureCode })}\n`);
    return report.status === 'incomplete' ? 1 : 0;
  } catch (error) {
    const failureCode = safeCode(error);
    const modelCandidate = (() => { const index = args.indexOf('--model'); return index >= 0 ? args[index + 1] ?? '' : ''; })();
    const thinkingCandidate = (() => { const index = args.indexOf('--thinking'); return index >= 0 ? args[index + 1] ?? '' : ''; })();
    const model = MODEL_PATTERN.test(modelCandidate) ? modelCandidate : 'unknown';
    const thinking = THINKING_LEVELS.has(thinkingCandidate) ? thinkingCandidate : 'unknown';
    const runName = makeRunName('full');
    const reportPath = await writeInvocationFailureReport(runName, failureCode, model, thinking);
    process.stderr.write(`${JSON.stringify({ status: 'incomplete', reportPath, failureCode })}\n`);
    return 1;
  }
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (executedPath === import.meta.url) {
  cliMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}
