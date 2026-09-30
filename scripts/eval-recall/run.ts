import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CASES, allFacts } from './corpus.ts';
import { createArtifactWriter, type ArtifactWriter, type CallEntry } from './artifacts.ts';
import { runPi, type Arm } from './pi.ts';
import type { QuestionOutcome, SeedOutcome } from './report.ts';
import { ABSTENTION_PHRASES, DEFAULT_SCORING_VERSION, SCORING_VERSIONS, scoreResponse, type ScoringVersion } from './score.ts';

export interface EvalOptions {
  runs: number;
  model: string;
  timeoutMs: number;
  packageRoot: string;
  realAgentDir: string;
  tmpRoot: string;
  executable: string;
  executableArgs: readonly string[];
  artifactRoot: string;
  scoringVersion: ScoringVersion;
}
export type ReadOptionsResult = { ok: true; options: EvalOptions } | { ok: false; message: string };
export interface Isolation { root: string; agentDir: string; workspace: string }
export interface EvalResult {
  questions: QuestionOutcome[];
  seeds: SeedOutcome[];
  artifactDirectory: string | null;
}

const activeRoots = new Set<string>();

export function buildSeedPrompt(factText: string): string {
  return `Project update: ${factText} Confirm in one short sentence.`;
}

export function buildAnswerPrompt(question: string, version: ScoringVersion = DEFAULT_SCORING_VERSION): string {
  if (version === 'strict-v1') {
    return `Answer from what you know about this project. If you do not know, say "I don't know".\n\nQuestion: ${question}`;
  }
  return `Answer from what you know about this project. Return only a JSON object with exactly two fields: "answer" and "context". Put only the current answer for the requested subject and environment in "answer". If you do not know, set "answer" to null. Put any historical information, information about another subject or environment, and qualifications in "context", as a string. Do not put alternatives or guesses in "answer".\n\nQuestion: ${question}`;
}

export function readOptions(
  env: NodeJS.ProcessEnv,
  defaults: { packageRoot: string; realAgentDir: string },
): ReadOptionsResult {
  if (env.PI_CONTEXT_EVAL !== '1') {
    return { ok: false, message: 'PI_CONTEXT_EVAL=1 is required because this script makes paid model calls.' };
  }
  const model = env.PI_EVAL_MODEL;
  if (model === undefined || !/^[^/\s]+\/\S+$/.test(model)) {
    return { ok: false, message: 'PI_EVAL_MODEL is required in provider/id form, for example openai-codex/<model id>.' };
  }
  const runsText = env.EVAL_RUNS;
  const runsGiven = runsText !== undefined && runsText !== '';
  if (runsGiven && !/^[1-9][0-9]*$/.test(runsText)) {
    return { ok: false, message: 'EVAL_RUNS must be a positive integer.' };
  }
  const executable = env.PI_EVAL_EXECUTABLE;
  if (executable !== undefined && !isAbsolute(executable)) {
    return { ok: false, message: 'PI_EVAL_EXECUTABLE must be an absolute path to the pi executable.' };
  }
  const scoringVersion = env.PI_EVAL_SCORING ?? DEFAULT_SCORING_VERSION;
  if (!SCORING_VERSIONS.includes(scoringVersion as ScoringVersion)) {
    return { ok: false, message: 'PI_EVAL_SCORING must be strict-v1 or answer-v2.' };
  }
  const artifactRoot = env.PI_EVAL_ARTIFACT_ROOT;
  if (artifactRoot !== undefined && (artifactRoot === '' || !isAbsolute(artifactRoot))) {
    return { ok: false, message: 'PI_EVAL_ARTIFACT_ROOT must be a non-empty absolute path.' };
  }
  return {
    ok: true,
    options: {
      runs: runsGiven ? Number(runsText) : 3,
      model,
      timeoutMs: 120000,
      packageRoot: defaults.packageRoot,
      realAgentDir: defaults.realAgentDir,
      tmpRoot: tmpdir(),
      executable: executable ?? 'pi',
      executableArgs: [],
      artifactRoot: artifactRoot ?? resolve(defaults.packageRoot, '.benchmarks', 'recall'),
      scoringVersion: scoringVersion as ScoringVersion,
    },
  };
}

export async function prepareIsolation(options: Pick<EvalOptions, 'tmpRoot' | 'realAgentDir'>): Promise<Isolation> {
  const root = await mkdtemp(join(options.tmpRoot, 'pi-context-eval-'));
  const agentDir = join(root, 'agent');
  const workspace = join(root, 'workspace');
  await mkdir(agentDir);
  await mkdir(workspace);
  await symlink(resolve(options.realAgentDir, 'auth.json'), join(agentDir, 'auth.json'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, env, timeout: 10000 });
  if (git.error !== undefined || git.status !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error('GIT_INIT_FAILED');
  }
  activeRoots.add(root);
  return { root, agentDir, workspace };
}

export async function removeIsolation(isolation: Isolation): Promise<void> {
  await rm(isolation.root, { recursive: true, force: true });
  activeRoots.delete(isolation.root);
}

export function cleanupActiveIsolations(): void {
  for (const root of activeRoots) rmSync(root, { recursive: true, force: true });
  activeRoots.clear();
}

export async function runEval(options: EvalOptions, log: (line: string) => void = () => {}): Promise<EvalResult> {
  const questions: QuestionOutcome[] = [];
  const seeds: SeedOutcome[] = [];
  const facts = allFacts();
  const expectedCalls = options.runs * (facts.length + CASES.length * 2);
  let writer: ArtifactWriter | null = null;
  try {
    writer = await createArtifactWriter(options.artifactRoot, {
      model: options.model,
      runs: options.runs,
      expectedCalls,
      scoringVersion: options.scoringVersion,
      recordAccountingVersion: 2,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`Artifact writer could not be created: ${detail}`);
  }

  const artifactDirectory = writer?.directory ?? null;
  const appendCall = async (entry: CallEntry): Promise<void> => {
    if (writer === null) return;
    try {
      const result = await writer.appendCall(entry);
      if (result.warning !== undefined) log(result.warning);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Artifact call append failed: ${detail}`);
    }
  };

  let evaluationFailed = false;
  let evaluationError: unknown;
  try {
    for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
      const isolation = await prepareIsolation(options);
      try {
        const call = (arm: Arm, prompt: string) => runPi({
          cwd: isolation.workspace,
          agentDir: isolation.agentDir,
          prompt,
          model: options.model,
          arm,
          extensionPath: options.packageRoot,
          timeoutMs: options.timeoutMs,
          executable: options.executable,
          executableArgs: options.executableArgs,
        });

        log(`run ${runIndex}: seed, ${facts.length} calls`);
        for (const entry of facts) {
          const result = await call('extension', buildSeedPrompt(entry.fact.text));
          const recorded = result.recordCalls >= 1;
          await appendCall({
            metadata: {
              kind: 'seed',
              runIndex,
              factId: entry.fact.id,
              factStage: entry.fact.stage,
              factText: entry.fact.text,
              factKind: entry.kind,
              status: result.status,
              recordCalls: result.recordCalls,
              recorded,
            },
            evidence: { answer: result.answer, process: result.evidence },
          });
          seeds.push({
            runIndex,
            factId: entry.fact.id,
            kind: entry.kind,
            recorded,
            status: result.status,
          });
        }

        for (const arm of ['extension', 'control'] as const) {
          log(`run ${runIndex}: ${arm} questions, ${CASES.length} calls`);
          for (const evalCase of CASES) {
            const result = await call(arm, buildAnswerPrompt(evalCase.question, options.scoringVersion));
            const score = scoreResponse(evalCase, result.answer, options.scoringVersion);
            const hit = result.status === 'ok' && score.hit;
            await appendCall({
              metadata: {
                kind: 'question',
                runIndex,
                arm,
                caseId: evalCase.id,
                caseType: evalCase.type,
                question: evalCase.question,
                status: result.status,
                score: hit,
                scoringVersion: options.scoringVersion,
                scoreReason: result.status === 'ok' ? score.reason : 'call_not_ok',
                scoringInputs: {
                  expectedKeywords: evalCase.expectedKeywords,
                  forbiddenKeywords: evalCase.forbiddenKeywords,
                  abstentionPhrases: ABSTENTION_PHRASES,
                },
              },
              evidence: { answer: result.answer, process: result.evidence },
            });
            questions.push({
              runIndex,
              arm,
              caseId: evalCase.id,
              caseType: evalCase.type,
              hit,
              status: result.status,
            });
          }
        }
      } finally {
        await removeIsolation(isolation);
      }
    }
  } catch (error) {
    evaluationFailed = true;
    evaluationError = error;
  }

  if (writer !== null) {
    try {
      await writer.finish(evaluationFailed ? 'incomplete' : 'complete');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Artifact manifest write failed: ${detail}`);
    }
  }
  if (evaluationFailed) throw evaluationError;
  return { questions, seeds, artifactDirectory };
}
