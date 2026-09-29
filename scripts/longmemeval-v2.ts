#!/usr/bin/env node
import { cliMain } from './longmemeval-v2/run.ts';

cliMain(process.argv.slice(2)).then(code => {
  process.exitCode = code;
}).catch(() => {
  process.exitCode = 1;
});
