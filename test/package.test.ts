import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_LIMIT_BYTES = 1_048_576;

test('npm package contains licensed runtime files and excludes private or generated data', () => {
  const result = spawnSync('npm', [
    'pack', '--dry-run', '--json', '--ignore-scripts',
  ], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: OUTPUT_LIMIT_BYTES,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `npm pack failed to start: ${result.error?.message ?? ''}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= OUTPUT_LIMIT_BYTES, 'npm pack output must stay bounded');

  const packages = JSON.parse(result.stdout) as Array<{
    files?: Array<{ path?: unknown }>;
  }>;
  assert.equal(packages.length, 1);
  const rawFiles = packages[0]?.files;
  assert.ok(Array.isArray(rawFiles));
  const files = rawFiles.map(file => file.path).filter((path): path is string => typeof path === 'string');
  const fileSet = new Set(files);
  const requiredFiles = [
    'package.json',
    'README.md',
    'docs/verification.md',
    'src/extension.ts',
    'skills/pi-context/SKILL.md',
    'vendor/ecc/memory-vault.js',
    'vendor/ecc/memory-vault-format.js',
    'vendor/ecc/path-safety.js',
    'vendor/ecc/package.json',
    'vendor/ecc/UPSTREAM.md',
    'vendor/ecc/LICENSE',
  ];
  for (const path of requiredFiles) assert.ok(fileSet.has(path), `package is missing ${path}`);

  const privateOrGenerated = files.filter(path => (
    /^(?:test|scripts|node_modules|\.demo|demo-logs|temporary-stores)(?:\/|$)/u.test(path) ||
    /(?:^|\/)(?:credentials?|memory-stores|logs)(?:\/|$)/iu.test(path) ||
    /\.(?:log|tmp|tsbuildinfo)$/iu.test(path)
  ));
  assert.deepEqual(privateOrGenerated, []);

  const boundary = readFileSync(resolve(PACKAGE_ROOT, 'vendor/ecc/package.json'), 'utf8');
  assert.match(boundary, /"type"\s*:\s*"commonjs"/u);
  const license = readFileSync(resolve(PACKAGE_ROOT, 'vendor/ecc/LICENSE'), 'utf8');
  assert.match(license, /MIT License/u);
  assert.match(license, /Copyright \(c\) 2026 Affaan Mustafa/u);
});
