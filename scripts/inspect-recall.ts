import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCallsJsonl } from './eval-recall/artifacts.ts';
import { analyzeCalls } from './eval-recall/diagnostics.ts';

const MAX_LOG_BYTES = 256 * 1024 * 1024;

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (directory === undefined || process.argv.length !== 3) {
    throw new Error('Usage: npm run eval:inspect -- <artifact-directory>');
  }
  const manifest: unknown = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const file = await open(resolve(directory, 'calls.jsonl'), 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_LOG_BYTES) {
      throw new Error('The call log must be a regular file with at most 268,435,456 bytes.');
    }
    const buffer = Buffer.alloc(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > info.size) throw new Error('The call log changed during inspection.');
    const parsed = parseCallsJsonl(buffer.subarray(0, bytes).toString('utf8'));
    console.log(JSON.stringify({
      manifest,
      scan: { invalidLines: parsed.invalidLines, incompleteFinalLine: parsed.incompleteFinalLine },
      diagnostics: analyzeCalls(parsed.entries),
    }, null, 2));
  } finally {
    await file.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
