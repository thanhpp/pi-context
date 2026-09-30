import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseCallsJsonl } from '../scripts/eval-recall/artifacts.ts';
import { allFacts } from '../scripts/eval-recall/corpus.ts';
import { formatReport } from '../scripts/eval-recall/report.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_FILE = join(REPO_ROOT, 'scripts', 'eval-recall.ts');
const createdDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'eval-recall-entry-test-'));
  createdDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runEntry(extraEnv: Record<string, string>, agentDir = makeTemporaryDirectory()) {
  const tmpRoot = makeTemporaryDirectory();
  const artifactRoot = makeTemporaryDirectory();
  assert.ok(!artifactRoot.startsWith(`${tmpRoot}/`));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', ENTRY_FILE], {
    env: {
      HOME: makeTemporaryDirectory(),
      PI_CODING_AGENT_DIR: agentDir,
      TMPDIR: tmpRoot,
      PI_EVAL_ARTIFACT_ROOT: artifactRoot,
      PATH: dirname(process.execPath),
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.deepEqual(readdirSync(tmpRoot), []);
  return result;
}

test('refuses without PI_CONTEXT_EVAL', () => {
  const result = runEntry({});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PI_CONTEXT_EVAL=1/);
});

test('refuses without PI_EVAL_MODEL', () => {
  const result = runEntry({ PI_CONTEXT_EVAL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PI_EVAL_MODEL/);
});

test('refuses when pi is not on the PATH', () => {
  const emptyPath = makeTemporaryDirectory();
  const result = runEntry({ PI_CONTEXT_EVAL: '1', PI_EVAL_MODEL: 'fake/model', PATH: emptyPath });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pi is not on the PATH/);
});

test('rejects empty and relative artifact roots before pi version preflight', { skip: process.platform === 'win32' }, () => {
  const binDirectory = makeTemporaryDirectory();
  const fakePi = join(binDirectory, 'pi');
  const marker = join(binDirectory, 'preflight-called');
  writeFileSync(fakePi, `#!/bin/sh\nprintf called > '${marker}'\nexit 0\n`);
  chmodSync(fakePi, 0o755);
  for (const artifactRoot of ['', 'relative/artifacts']) {
    const result = runEntry({
      PI_CONTEXT_EVAL: '1',
      PI_EVAL_MODEL: 'fake/model',
      PI_EVAL_ARTIFACT_ROOT: artifactRoot,
      PATH: binDirectory,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PI_EVAL_ARTIFACT_ROOT must be a non-empty absolute path/);
    assert.deepEqual(readdirSync(binDirectory), ['pi']);
  }
});

test('refuses when the login file is missing', { skip: process.platform === 'win32' }, () => {
  const binDirectory = makeTemporaryDirectory();
  const fakePi = join(binDirectory, 'pi');
  writeFileSync(fakePi, '#!/bin/sh\nexit 0\n');
  chmodSync(fakePi, 0o755);
  const result = runEntry({ PI_CONTEXT_EVAL: '1', PI_EVAL_MODEL: 'fake/model', PATH: binDirectory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /auth\.json/);
});

test('refuses when the explicit executable is missing without using PATH pi', { skip: process.platform === 'win32' }, () => {
  const directory = makeTemporaryDirectory();
  const marker = join(directory, 'path-pi-called');
  const pathPi = join(directory, 'pi');
  writeFileSync(pathPi, `#!/bin/sh\nprintf called > '${marker}'\nexit 0\n`);
  chmodSync(pathPi, 0o755);
  const result = runEntry({
    PI_CONTEXT_EVAL: '1',
    PI_EVAL_MODEL: 'fake/model',
    PI_EVAL_EXECUTABLE: join(directory, 'missing-pi'),
    PATH: directory,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot run pi executable.*Check PI_EVAL_EXECUTABLE/);
  assert.deepEqual(readdirSync(directory), ['pi']);
});

test('uses the explicit executable for preflight and all calls despite PATH pi', { skip: process.platform === 'win32' }, () => {
  const directory = makeTemporaryDirectory();
  const executable = join(directory, 'selected pi');
  const fixture = join(REPO_ROOT, 'test', 'fixtures', 'fake-recall-pi.ts');
  writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  printf "0.99.1\\n"',
    '  exit 0',
    'fi',
    `exec '${process.execPath}' --experimental-strip-types '${fixture}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(executable, 0o755);
  const marker = join(directory, 'path-pi-called');
  const pathPi = join(directory, 'pi');
  writeFileSync(pathPi, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`);
  chmodSync(pathPi, 0o755);
  const agentDir = makeTemporaryDirectory();
  writeFileSync(join(agentDir, 'auth.json'), '{"marker":"fake-login"}');
  const callsDirectory = makeTemporaryDirectory();
  const artifactRoot = makeTemporaryDirectory();
  const result = runEntry({
    PI_CONTEXT_EVAL: '1',
    PI_EVAL_MODEL: 'fake/model',
    PI_EVAL_EXECUTABLE: executable,
    PI_EVAL_ARTIFACT_ROOT: artifactRoot,
    EVAL_RUNS: '1',
    FAKE_CALLS_DIR: callsDirectory,
    PATH: `${directory}:/usr/bin:/bin`,
  }, agentDir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(`pi executable: ${executable}; version: 0.99.1`));
  const artifactDirectories = readdirSync(artifactRoot);
  assert.equal(artifactDirectories.length, 1);
  const artifactDirectory = join(artifactRoot, artifactDirectories[0] ?? '');
  assert.ok(result.stderr.includes(`recall artifacts: ${artifactDirectory}`));
  assert.doesNotMatch(result.stderr, /artifact.*warning/i);
  const stored = parseCallsJsonl(readFileSync(join(artifactDirectory, 'calls.jsonl'), 'utf8'));
  assert.equal(stored.invalidLines, 0);
  assert.equal(stored.entries.length, 82);
  const questions = stored.entries.flatMap((entry) => entry.metadata.kind === 'question' ? [{
    runIndex: entry.metadata.runIndex,
    arm: entry.metadata.arm,
    caseId: entry.metadata.caseId,
    caseType: entry.metadata.caseType,
    hit: entry.metadata.score,
    status: entry.metadata.status,
  }] : []);
  const seeds = stored.entries.flatMap((entry) => entry.metadata.kind === 'seed' ? [{
    runIndex: entry.metadata.runIndex,
    factId: entry.metadata.factId,
    kind: entry.metadata.factKind,
    recorded: entry.metadata.recorded,
    status: entry.metadata.status,
  }] : []);
  assert.equal(result.stdout, `${formatReport({ model: 'fake/model', runs: 1, scoringVersion: 'answer-v2', questions, seeds })}\n`);
  assert.doesNotMatch(result.stdout, /artifact.*warning/i);
  const calls = readFileSync(join(callsDirectory, 'fake-calls.jsonl'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 82);
  assert.deepEqual(readdirSync(directory).sort(), ['pi', 'selected pi']);
  assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), '{"marker":"fake-login"}');
});

test('SIGTERM preserves a running manifest and removes temporary isolation', { timeout: 30_000, skip: process.platform === 'win32' }, async () => {
  const binDirectory = makeTemporaryDirectory();
  const tmpRoot = makeTemporaryDirectory();
  const artifactRoot = makeTemporaryDirectory();
  const agentDir = makeTemporaryDirectory();
  const callsDirectory = makeTemporaryDirectory();
  const fakePi = join(REPO_ROOT, 'test', 'fixtures', 'fake-recall-pi.ts');
  const executable = join(binDirectory, 'fake-pi');
  writeFileSync(join(agentDir, 'auth.json'), '{"marker":"fake-login"}');
  writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  printf "fixture-version\\n"',
    '  exit 0',
    'fi',
    `exec '${process.execPath}' --experimental-strip-types '${fakePi}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(executable, 0o755);

  const child = spawn(process.execPath, ['--experimental-strip-types', ENTRY_FILE], {
    env: {
      HOME: makeTemporaryDirectory(),
      PI_CODING_AGENT_DIR: agentDir,
      TMPDIR: tmpRoot,
      PI_EVAL_ARTIFACT_ROOT: artifactRoot,
      PI_CONTEXT_EVAL: '1',
      PI_EVAL_MODEL: 'fake/model',
      PI_EVAL_EXECUTABLE: executable,
      EVAL_RUNS: '1',
      FAKE_HANG_FACT_ID: allFacts()[0]?.fact.id ?? '',
      FAKE_CALLS_DIR: callsDirectory,
      PATH: `${binDirectory}:/usr/bin:/bin`,
    },
    stdio: 'ignore',
  });
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const callsPath = join(callsDirectory, 'fake-calls.jsonl');
  const deadline = Date.now() + 10_000;
  let fakeStarted = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const calls = readFileSync(callsPath, 'utf8').trim().split('\n');
      fakeStarted = calls.length === 1 && calls[0] !== '';
    } catch {
      fakeStarted = false;
    }
    if (fakeStarted) break;
    await delay(20);
  }
  if (!fakeStarted) {
    child.kill('SIGKILL');
    await childExit;
    assert.fail('The fake pi process did not start.');
  }

  child.kill('SIGTERM');
  const exit = await childExit;
  assert.equal(exit.code, 143);
  assert.deepEqual(readdirSync(tmpRoot), []);
  assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), '{"marker":"fake-login"}');

  const artifactDirectories = readdirSync(artifactRoot);
  assert.equal(artifactDirectories.length, 1);
  const artifactDirectory = join(artifactRoot, artifactDirectories[0] ?? '');
  assert.ok(!artifactDirectory.startsWith(`${tmpRoot}/`));
  const manifest = JSON.parse(readFileSync(join(artifactDirectory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.status, 'running');
  assert.equal(manifest.completedAt, undefined);
  assert.equal(readFileSync(join(artifactDirectory, 'calls.jsonl'), 'utf8'), '');
});

test('package.json defines the eval:recall script', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts['eval:recall'], 'node --experimental-strip-types scripts/eval-recall.ts');
});
