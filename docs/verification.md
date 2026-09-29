🤖 # Verification

## Deterministic checks

The required Task 8 command passed:

```sh
npm run check && node --experimental-strip-types --test test/integration.test.ts test/package.test.ts && npm pack --dry-run --ignore-scripts
```

TypeScript exited with code 0. Both Task 8 tests passed. The final package dry run listed 18 intended files. It did not list tests, scripts, fixtures, `node_modules`, credentials, logs, or memory stores. The package test also passed its bounded `npm pack --dry-run --json --ignore-scripts` check.

The full `npm test` command was not run. Prior Tasks 1–7 passed before this task.

## Live two-session demonstration

The live demonstration requires an authenticated pi main-model profile and explicit operator approval for two normal model requests. The operator has not approved these requests for this task. Do not run `npm run demo` until approval is available.

Live result: not run. The live criterion is incomplete. No package installation was performed. No live model request, session log, fixture store, or `.demo/<UUID>/` report was created for this task.

When an approved run is performed, record the exact `.demo/<UUID>/` paths printed by the script. Keep the report, session logs, and fixture memory for inspection. They contain the synthetic SQLite decision and are test artifacts. Record the observed provider and model identity, the successful tool-call IDs, the retrieval result, and the final answer checks. State `unavailable` if pi does not provide a provider or model identity. Do not record credentials.
