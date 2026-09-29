import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import type { ContextConfig } from '../src/config.ts';

function withTemp(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-context-config-'));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function writeConfig(agentDir: string, content: string): void {
  writeFileSync(join(agentDir, 'pi-context.json'), content, 'utf8');
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code)
    : undefined;
}

function expectConfigError(error: unknown): boolean {
  return errorCode(error) === 'CONFIG_INVALID';
}

const DEFAULT_CONFIG: ContextConfig = {
  version: 1,
  defaults: { maxBytes: 10_485_760, cleanupMode: 'auto' },
  projects: [],
};

test('missing configuration returns defaults and creates no files', async () => {
  await withTemp(async agentDir => {
    assert.deepEqual(await loadConfig(agentDir), DEFAULT_CONFIG);
    assert.deepEqual(readdirSync(agentDir), []);
  });
});

test('configuration applies overrides and canonicalizes absolute and ~/ roots', async () => {
  await withTemp(async directory => {
    const agentDir = join(directory, 'agent');
    const projects = join(directory, 'projects');
    const realProject = join(projects, 'real');
    const alias = join(projects, 'alias');
    mkdirSync(agentDir);
    mkdirSync(realProject, { recursive: true });
    symlinkSync(realProject, alias, 'dir');
    writeConfig(agentDir, JSON.stringify({
      version: 1,
      defaults: { cleanupMode: 'ask' },
      projects: [
        { root: alias, maxBytes: 4096 },
        { root: '~/' },
      ],
    }));

    const config = await loadConfig(agentDir);
    assert.deepEqual(config.defaults, { maxBytes: 10_485_760, cleanupMode: 'ask' });
    assert.deepEqual(config.projects, [
      { root: realpathSync(realProject), maxBytes: 4096 },
      { root: realpathSync(homedir()) },
    ]);
  });
});

test('configuration keeps shell-looking path characters literal', async () => {
  await withTemp(async directory => {
    const agentDir = join(directory, 'agent');
    const literalRoot = join(directory, '$(echo not-run)-$ROOT');
    mkdirSync(agentDir);
    mkdirSync(literalRoot);
    const oldRoot = process.env.ROOT;
    process.env.ROOT = join(directory, 'other-root');
    try {
      writeConfig(agentDir, JSON.stringify({ version: 1, projects: [{ root: literalRoot }] }));
      assert.deepEqual((await loadConfig(agentDir)).projects, [{ root: realpathSync(literalRoot) }]);
    } finally {
      if (oldRoot === undefined) delete process.env.ROOT;
      else process.env.ROOT = oldRoot;
    }
  });
});

test('configuration rejects malformed JSON, unsupported versions, unknown keys, and invalid limits', async () => {
  await withTemp(async directory => {
    const agentDir = join(directory, 'agent');
    const root = join(directory, 'project');
    mkdirSync(agentDir);
    mkdirSync(root);
    const invalidConfigs = [
      '{ invalid',
      JSON.stringify({ version: 2, projects: [] }),
      JSON.stringify({ version: 1, projects: [], unexpected: true }),
      JSON.stringify({ version: 1, projects: [{ root, maxBytes: 0 }] }),
      JSON.stringify({ version: 1, projects: [{ root, cleanupMode: 'always' }] }),
      JSON.stringify({ version: 1, projects: [{ root, enabled: 'no' }] }),
      JSON.stringify({ version: 1, projects: [{ root: 'relative/path' }] }),
      JSON.stringify({ version: 1, projects: [{ root }] }) + ' '.repeat(64 * 1024),
    ];
    for (const contents of invalidConfigs) {
      writeConfig(agentDir, contents);
      await assert.rejects(loadConfig(agentDir), expectConfigError);
    }
  });
});

test('configuration rejects roots that are missing or duplicate after canonicalization', async () => {
  await withTemp(async directory => {
    const agentDir = join(directory, 'agent');
    const root = join(directory, 'project');
    const alias = join(directory, 'alias');
    mkdirSync(agentDir);
    mkdirSync(root);
    symlinkSync(root, alias, 'dir');
    writeConfig(agentDir, JSON.stringify({
      version: 1,
      projects: [{ root }, { root: alias }],
    }));
    await assert.rejects(loadConfig(agentDir), expectConfigError);

    writeConfig(agentDir, JSON.stringify({ version: 1, projects: [{ root: join(directory, 'missing') }] }));
    await assert.rejects(loadConfig(agentDir), expectConfigError);
  });
});

test('configuration rejects symlinks, non-files, and invalid UTF-8', async () => {
  await withTemp(async directory => {
    const agentDir = join(directory, 'agent');
    mkdirSync(agentDir);
    const external = join(directory, 'external.json');
    writeFileSync(external, '{"version":1,"projects":[]}');
    symlinkSync(external, join(agentDir, 'pi-context.json'));
    await assert.rejects(loadConfig(agentDir), expectConfigError);

    rmSync(join(agentDir, 'pi-context.json'));
    mkdirSync(join(agentDir, 'pi-context.json'));
    await assert.rejects(loadConfig(agentDir), expectConfigError);

    rmSync(join(agentDir, 'pi-context.json'), { recursive: true });
    writeFileSync(join(agentDir, 'pi-context.json'), Buffer.from([0xff, 0xfe]));
    await assert.rejects(loadConfig(agentDir), expectConfigError);
  });
});
