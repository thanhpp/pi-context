import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ContextConfig, ProjectConfigEntry } from '../src/config.ts';
import { resolveProject } from '../src/project.ts';

function withTemp(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-context-project-'));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  env.LC_ALL = 'C';
  return env;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo(directory: string, name = 'repo'): string {
  const repo = join(directory, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '--quiet', repo]);
  git(['-C', repo, 'config', 'user.name', 'pi-context test']);
  git(['-C', repo, 'config', 'user.email', 'pi-context@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(['-C', repo, 'add', 'README.md']);
  git(['-C', repo, 'commit', '--quiet', '-m', 'fixture']);
  return repo;
}

function makeAgent(directory: string): string {
  const agentDir = join(directory, 'agent');
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

function makeConfig(projects: ProjectConfigEntry[] = []): ContextConfig {
  return {
    version: 1,
    defaults: { maxBytes: 10_485_760, cleanupMode: 'auto' },
    projects,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code)
    : undefined;
}

function expectErrorCode(code: string): (error: unknown) => boolean {
  return error => errorCode(error) === code;
}

test('Git worktrees and subdirectories share identity; local clones stay separate', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const seed = createRepo(directory, 'seed');
    const cloneOne = join(directory, 'clone-one');
    const cloneTwo = join(directory, 'clone-two');
    git(['clone', '--quiet', seed, cloneOne]);
    git(['clone', '--quiet', seed, cloneTwo]);
    const linked = join(directory, 'linked-worktree');
    git(['-C', cloneOne, 'worktree', 'add', '--quiet', '-b', 'linked', linked]);
    mkdirSync(join(cloneOne, 'src'));
    mkdirSync(join(linked, 'src'));

    const config = makeConfig();
    const main = await resolveProject(cloneOne, agentDir, config);
    const subdirectory = await resolveProject(join(cloneOne, 'src'), agentDir, config);
    const linkedProject = await resolveProject(join(linked, 'src'), agentDir, config);
    const otherClone = await resolveProject(cloneTwo, agentDir, config);
    assert.equal(main.enabled, true);
    assert.equal(subdirectory.enabled, true);
    assert.equal(linkedProject.enabled, true);
    assert.equal(otherClone.enabled, true);
    if (!main.enabled || !subdirectory.enabled || !linkedProject.enabled || !otherClone.enabled) return;

    assert.equal(main.project.id, subdirectory.project.id);
    assert.equal(main.project.id, linkedProject.project.id);
    assert.notEqual(main.project.id, otherClone.project.id);
    assert.equal(main.project.identityKey, `git\0${realpathSync(join(cloneOne, '.git'))}`);
    assert.equal(main.project.worktreeRoot, realpathSync(cloneOne));
    assert.equal(linkedProject.project.worktreeRoot, realpathSync(linked));
    assert.equal(git(['-C', cloneOne, 'remote', 'get-url', 'origin']), git(['-C', cloneTwo, 'remote', 'get-url', 'origin']));
    assert.match(main.project.id, /^[0-9a-f]{64}$/u);
    assert.equal(existsSync(main.project.memoryDir), false);
    assert.equal(existsSync(join(agentDir, 'memory')), false);
  });
});

test('nested repositories have separate identities', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const outer = createRepo(directory, 'outer');
    const nested = join(outer, 'nested');
    mkdirSync(nested);
    git(['init', '--quiet', nested]);
    const config = makeConfig();
    const outerProject = await resolveProject(outer, agentDir, config);
    const nestedProject = await resolveProject(nested, agentDir, config);
    assert.equal(outerProject.enabled, true);
    assert.equal(nestedProject.enabled, true);
    if (!outerProject.enabled || !nestedProject.enabled) return;
    assert.notEqual(outerProject.project.id, nestedProject.project.id);
    assert.notEqual(outerProject.project.root, nestedProject.project.root);
  });
});

test('canonical working-directory aliases share identity and moving a repository changes its ID', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const repo = createRepo(directory, 'before-move');
    const alias = join(directory, 'repo-alias');
    symlinkSync(repo, alias, 'dir');
    const config = makeConfig();
    const realProject = await resolveProject(repo, agentDir, config);
    const aliasProject = await resolveProject(alias, agentDir, config);
    assert.equal(realProject.enabled, true);
    assert.equal(aliasProject.enabled, true);
    if (!realProject.enabled || !aliasProject.enabled) return;
    assert.equal(realProject.project.id, aliasProject.project.id);

    const moved = join(directory, 'after-move');
    renameSync(repo, moved);
    const movedProject = await resolveProject(moved, agentDir, config);
    assert.equal(movedProject.enabled, true);
    if (!movedProject.enabled) return;
    assert.notEqual(realProject.project.id, movedProject.project.id);
  });
});

test('Git configuration matches another worktree and rejects conflicting worktree policies', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const repo = createRepo(directory, 'repo');
    const linked = join(directory, 'linked');
    git(['-C', repo, 'worktree', 'add', '--quiet', '-b', 'linked', linked]);
    const config = makeConfig([{ root: realpathSync(linked), maxBytes: 2048, cleanupMode: 'ask' }]);
    const resolved = await resolveProject(repo, agentDir, config);
    assert.equal(resolved.enabled, true);
    if (!resolved.enabled) return;
    assert.deepEqual(resolved.policy, { maxBytes: 2048, cleanupMode: 'ask' });
    assert.equal(resolved.project.root, realpathSync(join(repo, '.git')));

    const conflicting = makeConfig([
      { root: realpathSync(repo), cleanupMode: 'auto' },
      { root: realpathSync(linked), cleanupMode: 'ask' },
    ]);
    await assert.rejects(
      resolveProject(repo, agentDir, conflicting),
      expectErrorCode('CONFIG_INVALID'),
    );
  });
});

test('configured roots use component boundaries and the deepest matching root', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const app = join(directory, 'work', 'app');
    const nested = join(app, 'nested');
    const sibling = join(directory, 'work', 'app-two');
    mkdirSync(join(app, 'src'), { recursive: true });
    mkdirSync(join(nested, 'src'), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const config = makeConfig([
      { root: realpathSync(app), maxBytes: 100 },
      { root: realpathSync(nested), maxBytes: 200, cleanupMode: 'ask' },
    ]);

    const appProject = await resolveProject(join(app, 'src'), agentDir, config);
    const nestedProject = await resolveProject(join(nested, 'src'), agentDir, config);
    const siblingProject = await resolveProject(sibling, agentDir, config);
    assert.equal(appProject.enabled, true);
    assert.equal(nestedProject.enabled, true);
    assert.deepEqual(siblingProject, { enabled: false, reason: 'not_configured' });
    if (!appProject.enabled || !nestedProject.enabled) return;
    assert.equal(appProject.project.root, realpathSync(app));
    assert.equal(appProject.project.worktreeRoot, realpathSync(app));
    assert.deepEqual(appProject.policy, { maxBytes: 100, cleanupMode: 'auto' });
    assert.equal(nestedProject.project.root, realpathSync(nested));
    assert.deepEqual(nestedProject.policy, { maxBytes: 200, cleanupMode: 'ask' });
    assert.equal(existsSync(join(agentDir, 'memory')), false);
  });
});

test('unconfigured non-Git projects create no memory files and disabled projects stay disabled', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const outsideGit = join(directory, 'plain');
    mkdirSync(outsideGit);
    const missing = await resolveProject(outsideGit, agentDir, makeConfig());
    assert.deepEqual(missing, { enabled: false, reason: 'not_configured' });
    assert.equal(existsSync(join(agentDir, 'memory')), false);

    const repo = createRepo(directory, 'disabled-repo');
    const disabled = await resolveProject(repo, agentDir, makeConfig([
      { root: realpathSync(repo), enabled: false },
    ]));
    assert.deepEqual(disabled, { enabled: false, reason: 'disabled' });
    assert.equal(existsSync(join(agentDir, 'memory')), false);
  });
});

test('ambient Git directory variables cannot redirect project discovery', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const target = createRepo(directory, 'target');
    const unrelated = createRepo(directory, 'unrelated');
    const config = makeConfig();
    const baseline = await resolveProject(target, agentDir, config);
    assert.equal(baseline.enabled, true);
    if (!baseline.enabled) return;

    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.GIT_DIR = join(unrelated, '.git');
    process.env.GIT_WORK_TREE = unrelated;
    process.env.GIT_COMMON_DIR = join(unrelated, '.git');
    try {
      const redirected = await resolveProject(target, agentDir, config);
      assert.equal(redirected.enabled, true);
      if (redirected.enabled) assert.equal(redirected.project.id, baseline.project.id);
    } finally {
      names.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});

test('memory roots and project memory directories cannot be symlinks', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const repo = createRepo(directory, 'repo');
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    const config = makeConfig([{ root: realpathSync(repo) }]);

    symlinkSync(outside, join(agentDir, 'memory'), 'dir');
    await assert.rejects(
      resolveProject(repo, agentDir, config),
      expectErrorCode('PROJECT_RESOLUTION_FAILED'),
    );
    rmSync(join(agentDir, 'memory'));

    const clean = await resolveProject(repo, agentDir, config);
    assert.equal(clean.enabled, true);
    if (!clean.enabled) return;
    assert.equal(existsSync(clean.project.memoryDir), false);
    assert.equal(existsSync(join(agentDir, 'memory')), false);
    mkdirSync(join(agentDir, 'memory'));
    symlinkSync(outside, clean.project.memoryDir, 'dir');
    await assert.rejects(
      resolveProject(repo, agentDir, config),
      expectErrorCode('PROJECT_RESOLUTION_FAILED'),
    );
  });
});

test('Git executable failures do not fall back to configured project roots', async () => {
  await withTemp(async directory => {
    const agentDir = makeAgent(directory);
    const root = join(directory, 'plain');
    mkdirSync(root);
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await assert.rejects(
        resolveProject(root, agentDir, makeConfig([{ root: realpathSync(root) }])),
        error => {
          assert.equal(errorCode(error), 'PROJECT_RESOLUTION_FAILED');
          assert.deepEqual((error as { details?: unknown }).details, {
            cause: 'git-executable-unavailable',
          });
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
