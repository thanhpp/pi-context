import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { killLivePiProcesses } from './eval-recall/pi.ts';
import { formatReport } from './eval-recall/report.ts';
import { cleanupActiveIsolations, readOptions, runEval } from './eval-recall/run.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function exitWith(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = readOptions(process.env, { packageRoot: PACKAGE_ROOT, realAgentDir: getAgentDir() });
  if (!parsed.ok) exitWith(parsed.message);
  const { options } = parsed;

  const piVersion = spawnSync(options.executable, ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (piVersion.error || piVersion.status !== 0) {
    exitWith(options.executable === 'pi'
      ? 'pi is not on the PATH. Install pi and retry.'
      : `Cannot run pi executable ${options.executable}. Check PI_EVAL_EXECUTABLE and retry.`);
  }
  console.error(`pi executable: ${options.executable}; version: ${piVersion.stdout.trim()}`);

  const authFile = resolve(options.realAgentDir, 'auth.json');
  if (!existsSync(authFile)) exitWith(`The login file ${authFile} does not exist. Log in with pi first.`);

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      killLivePiProcesses();
      cleanupActiveIsolations();
      process.exit(code);
    });
  }

  try {
    const { questions, seeds, artifactDirectory } = await runEval(options, line => console.error(line));
    if (artifactDirectory !== null) console.error(`recall artifacts: ${artifactDirectory}`);
    console.log(formatReport({ model: options.model, runs: options.runs, scoringVersion: options.scoringVersion, questions, seeds }));
  } catch (error) {
    exitWith(error instanceof Error ? error.message : String(error));
  }
}

await main();
