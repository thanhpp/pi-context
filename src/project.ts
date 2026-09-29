import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ContextError } from './errors.ts';
import type { ContextConfig, ProjectConfigEntry, ProjectPolicy } from './config.ts';

const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 64 * 1024;

export interface ProjectIdentity {
  id: string;
  identityKey: string;
  kind: 'git' | 'configured';
  root: string;
  worktreeRoot: string;
  memoryDir: string;
}

export type ProjectResolution =
  | { enabled: true; project: ProjectIdentity; policy: ProjectPolicy }
  | { enabled: false; reason: 'not_configured' | 'disabled' };

type GitFailureKind = 'executable' | 'timeout' | 'output-limit' | 'spawn' | 'exit';

class GitFailure extends Error {
  readonly kind: GitFailureKind;
  readonly exitCode?: number;
  readonly stderr: string;

  constructor(kind: GitFailureKind, exitCode?: number, stderr = '') {
    super(kind);
    this.name = 'GitFailure';
    this.kind = kind;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function projectError(cause: string): ContextError {
  return new ContextError(
    'PROJECT_RESOLUTION_FAILED',
    'Could not resolve the active project safely.',
    { cause },
  );
}

function configError(message: string): ContextError {
  return new ContextError('CONFIG_INVALID', message);
}

function sanitizeGitFailure(error: GitFailure): string {
  switch (error.kind) {
    case 'executable': return 'git-executable-unavailable';
    case 'timeout': return 'git-command-timeout';
    case 'output-limit': return 'git-output-limit';
    case 'spawn': return 'git-command-failed-to-start';
    case 'exit': return `git-exit-${error.exitCode ?? 'unknown'}`;
  }
}

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  env.LC_ALL = 'C';
  return env;
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, {
        env: inheritedEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new GitFailure('spawn'));
      return;
    }

    if (!child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      reject(new GitFailure('spawn'));
      return;
    }
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: GitFailure | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      failure = new GitFailure('timeout');
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);

    const finishError = (error: GitFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (settled || failure) return;
      outputBytes += chunk.length;
      if (outputBytes > GIT_OUTPUT_LIMIT) {
        failure = new GitFailure('output-limit');
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };

    stdoutStream.on('data', (chunk: Buffer) => collect(stdout, chunk));
    stderrStream.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', error => {
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      finishError(new GitFailure(code === 'ENOENT' ? 'executable' : 'spawn'));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (failure) {
        reject(failure);
        return;
      }
      const output = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        reject(new GitFailure('exit', code ?? undefined, Buffer.concat(stderr).toString('utf8')));
        return;
      }
      resolve(output);
    });
  });
}

function stripFinalLineEnding(output: string): string {
  if (output.endsWith('\r\n')) return output.slice(0, -2);
  if (output.endsWith('\n')) return output.slice(0, -1);
  return output;
}

function isNotRepository(error: GitFailure): boolean {
  return error.kind === 'exit' && /^fatal: not a git repository(?:\s|\()/mu.test(error.stderr);
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('not-absolute');
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error('not-directory');
  return canonical;
}

async function discoverCommonDirectory(cwd: string): Promise<string | undefined> {
  try {
    const output = await runGit([
      '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]);
    const commonDir = stripFinalLineEnding(output);
    if (!commonDir) throw projectError('git-common-directory-invalid');
    return await canonicalDirectory(commonDir);
  } catch (error) {
    if (error instanceof GitFailure && isNotRepository(error)) return undefined;
    if (error instanceof ContextError) throw error;
    if (error instanceof GitFailure) throw projectError(sanitizeGitFailure(error));
    throw projectError('git-common-directory-unavailable');
  }
}

async function discoverWorktreeRoot(cwd: string): Promise<string> {
  try {
    const output = await runGit([
      '-C', cwd, 'rev-parse', '--show-toplevel',
    ]);
    const topLevel = stripFinalLineEnding(output);
    if (!topLevel) throw projectError('git-worktree-root-invalid');
    return await canonicalDirectory(topLevel);
  } catch (error) {
    if (error instanceof ContextError) throw error;
    if (error instanceof GitFailure) throw projectError(sanitizeGitFailure(error));
    throw projectError('git-worktree-root-unavailable');
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function pathDepth(path: string): number {
  return path.split(sep).filter(part => part.length > 0).length;
}

function effectivePolicy(config: ContextConfig, entry?: ProjectConfigEntry): ProjectPolicy {
  return {
    maxBytes: entry?.maxBytes ?? config.defaults.maxBytes,
    cleanupMode: entry?.cleanupMode ?? config.defaults.cleanupMode,
  };
}

function entryEnabled(entry?: ProjectConfigEntry): boolean {
  return entry?.enabled !== false;
}

function sameResolutionPolicy(
  config: ContextConfig,
  left: ProjectConfigEntry,
  right: ProjectConfigEntry,
): boolean {
  return entryEnabled(left) === entryEnabled(right) &&
    effectivePolicy(config, left).maxBytes === effectivePolicy(config, right).maxBytes &&
    effectivePolicy(config, left).cleanupMode === effectivePolicy(config, right).cleanupMode;
}

async function chooseGitEntry(
  commonDir: string,
  config: ContextConfig,
): Promise<ProjectConfigEntry | undefined> {
  const matches: ProjectConfigEntry[] = [];
  for (const entry of config.projects) {
    const entryCommonDir = await discoverCommonDirectory(entry.root);
    if (entryCommonDir === commonDir) matches.push(entry);
  }
  const first = matches[0];
  if (!first) return undefined;
  for (const match of matches.slice(1)) {
    if (!sameResolutionPolicy(config, first, match)) {
      throw configError('Worktree entries for one repository have conflicting policies.');
    }
  }
  return first;
}

function chooseConfiguredEntry(cwd: string, config: ContextConfig): ProjectConfigEntry | undefined {
  let selected: ProjectConfigEntry | undefined;
  let selectedDepth = -1;
  for (const entry of config.projects) {
    if (!containsPath(entry.root, cwd)) continue;
    const depth = pathDepth(entry.root);
    if (depth > selectedDepth) {
      selected = entry;
      selectedDepth = depth;
    }
  }
  return selected;
}

async function canonicalCwd(cwd: string): Promise<string> {
  try {
    return await canonicalDirectory(cwd);
  } catch {
    throw projectError('working-directory-unavailable');
  }
}

async function canonicalAgentDir(agentDir: string): Promise<string> {
  try {
    return await canonicalDirectory(agentDir);
  } catch {
    throw projectError('agent-directory-unavailable');
  }
}

async function entryForProject(
  cwd: string,
  commonDir: string | undefined,
  config: ContextConfig,
): Promise<ProjectConfigEntry | undefined> {
  if (commonDir !== undefined) return chooseGitEntry(commonDir, config);
  return chooseConfiguredEntry(cwd, config);
}

function projectId(identityKey: string): string {
  return createHash('sha256').update(identityKey, 'utf8').digest('hex');
}

async function pathState(path: string): Promise<{ exists: boolean; isDirectory: boolean; isSymlink: boolean }> {
  try {
    const info = await lstat(path);
    return {
      exists: true,
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { exists: false, isDirectory: false, isSymlink: false };
    }
    throw projectError('memory-path-unavailable');
  }
}

async function validateMemoryPaths(agentDir: string, memoryDir: string): Promise<void> {
  const memoryRoot = join(agentDir, 'memory');
  const rootState = await pathState(memoryRoot);
  if (rootState.isSymlink) throw projectError('memory-root-symlink');
  if (rootState.exists && !rootState.isDirectory) throw projectError('memory-root-not-directory');
  const projectState = await pathState(memoryDir);
  if (projectState.isSymlink) throw projectError('project-memory-symlink');
  if (projectState.exists && !projectState.isDirectory) {
    throw projectError('project-memory-not-directory');
  }

  const canonicalAgent = await canonicalAgentDir(agentDir);
  if (!containsPath(canonicalAgent, memoryRoot) || !containsPath(canonicalAgent, memoryDir)) {
    throw projectError('memory-path-outside-agent-directory');
  }
  if (rootState.exists) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(memoryRoot);
    } catch {
      throw projectError('memory-root-unavailable');
    }
    if (!containsPath(canonicalAgent, canonicalRoot)) {
      throw projectError('memory-root-outside-agent-directory');
    }
  }
  if (projectState.exists) {
    let canonicalProject: string;
    try {
      canonicalProject = await realpath(memoryDir);
    } catch {
      throw projectError('project-memory-unavailable');
    }
    if (!containsPath(canonicalAgent, canonicalProject)) {
      throw projectError('project-memory-outside-agent-directory');
    }
  }
}

export async function resolveProject(
  cwd: string,
  agentDir: string,
  config: ContextConfig,
): Promise<ProjectResolution> {
  const canonicalWorkdir = await canonicalCwd(cwd);
  const commonDir = await discoverCommonDirectory(canonicalWorkdir);
  const worktreeRoot = commonDir === undefined
    ? undefined
    : await discoverWorktreeRoot(canonicalWorkdir);
  const entry = await entryForProject(canonicalWorkdir, commonDir, config);
  if (commonDir === undefined && entry === undefined) {
    return { enabled: false, reason: 'not_configured' };
  }
  if (entry && !entryEnabled(entry)) return { enabled: false, reason: 'disabled' };

  const kind = commonDir === undefined ? 'configured' : 'git';
  const root = commonDir ?? entry?.root;
  const identityPath = commonDir ?? entry?.root;
  if (!root || !identityPath) throw projectError('project-identity-unavailable');
  const identityKey = `${kind}\0${identityPath}`;
  const id = projectId(identityKey);
  const canonicalAgent = await canonicalAgentDir(agentDir);
  const memoryDir = join(canonicalAgent, 'memory', id);
  await validateMemoryPaths(canonicalAgent, memoryDir);

  return {
    enabled: true,
    project: {
      id,
      identityKey,
      kind,
      root,
      worktreeRoot: worktreeRoot ?? root,
      memoryDir,
    },
    policy: effectivePolicy(config, entry),
  };
}
