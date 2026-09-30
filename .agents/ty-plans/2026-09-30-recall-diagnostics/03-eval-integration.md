# Task 3: Evaluation Integration

**Depends on:** [Task 1](01-call-evidence.md), [Task 2](02-artifact-writer.md)

**Goal:** Save each seed and question result while preserving benchmark behavior, cleanup, and standard output.

**Files:**

- Modify: `scripts/eval-recall/run.ts`
- Modify: `scripts/eval-recall.ts`
- Modify: `test/eval-recall-run.test.ts`
- Modify: `test/eval-recall-entry.test.ts`
- Modify: `test/fixtures/fake-recall-pi.ts`

**Reuses:** `runPi` in `scripts/eval-recall/pi.ts` returns existing outcomes and `PiCallEvidence`. `createArtifactWriter` in `scripts/eval-recall/artifacts.ts` creates the manifest and call log. `scoreAnswer` in `scripts/eval-recall/score.ts` supplies the existing score.

**Precondition:** Task 1 exports `PiCallEvidence` on `PiCallResult`. Task 2 provides `createArtifactWriter` and its call-entry types. Use `appendCall(entry: CallEntry): Promise<AppendCallResult>` for each result. Use `finish(status: 'complete' | 'incomplete'): Promise<void>` at evaluation end. `ArtifactWriter.directory` supplies `artifactDirectory`. Keep the current temporary-isolation cleanup and signal handlers.

**Site conditions:** The current `EvalOptions` type has these fields:

```ts
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
}
```

Add `artifactRoot` to the existing interface. The current option reader has this signature:

```ts
export function readOptions(
  env: NodeJS.ProcessEnv,
  defaults: { packageRoot: string; realAgentDir: string },
): ReadOptionsResult;
```

When `PI_EVAL_ARTIFACT_ROOT` is unset, set `artifactRoot` to `resolve(packageRoot, '.benchmarks', 'recall')`. When it is set, require a non-empty absolute path. Reject invalid values before the pi version preflight. A valid but unwritable root must warn. Evaluation calls must continue.

The current `runEval` signature is:

```ts
export async function runEval(
  options: EvalOptions,
  log: (line: string) => void = () => {},
): Promise<EvalResult>;
```

Extend its result type:

```ts
export interface EvalResult {
  questions: QuestionOutcome[];
  seeds: SeedOutcome[];
  artifactDirectory: string | null;
}
```

The current loop makes 34 seed calls per run. It then makes 24 extension and 24 control question calls. There are 82 calls per run and 164 calls for two runs. The loop has no automatic retry. Keep its call order and prompts. Keep `status`, `recorded`, and `hit` behavior unchanged. The current score is `result.status === 'ok' && scoreAnswer(evalCase, result.answer)`. Do not change `formatReport` or its standard-output text.

`scripts/eval-recall.ts` already passes `line => console.error(line)` to `runEval`. Print the returned artifact path to standard error. Keep the aggregate report on standard output. The entry already runs a pi version preflight and checks for the login file. Do not add a login-probe model call.

Each `runPi` resolution is one completed benchmark-call outcome. This includes `failed` and `timeout` results. Append one entry after each resolution. Seed metadata must include `runIndex`, `factId`, `fact.stage`, `fact.text`, `fact.kind`, `status`, `recordCalls`, and `recorded`. Keep the current rule `result.recordCalls >= 1` for `recorded`. Add the answer and `PiCallEvidence` to its evidence.

Question metadata must include `runIndex`, `arm`, `caseId`, `caseType`, `question`, `status`, `score`, and scoring inputs. Store the existing final `hit` value as `score`. Save `expectedKeywords`, `forbiddenKeywords`, and `ABSTENTION_PHRASES` from the scorer. Add the answer and `PiCallEvidence` to its evidence.

Send append errors and evidence-omission warnings through `log`. Do not throw these errors out of `runEval`. Do not stop later calls. Keep artifacts outside `tmpRoot`, `isolation.root`, `isolation.agentDir`, and `isolation.workspace`. Keep `prepareIsolation`, `removeIsolation`, and `cleanupActiveIsolations`. Keep the login symbolic-link behavior.

Finish the manifest as `complete` only after every call finishes. On an evaluation error, try to finish it as `incomplete`, then rethrow the original error. Log a manifest-write warning. An interrupt can leave a valid `running` manifest. The existing signal handler must still remove temporary isolation. It must not remove artifacts.

## Steps

1. Add `artifactRoot: string` to `EvalOptions`.
2. Extend `readOptions` to validate `PI_EVAL_ARTIFACT_ROOT`.
3. Use package-local `.benchmarks/recall` when the variable is unset.
4. Extend `EvalResult` with `artifactDirectory: string | null`.
5. Compute expected calls at `runEval` start. Use `options.runs * (allFacts().length + CASES.length * 2)`.
6. Try to create one writer for the full evaluation.
7. If writer creation fails, log one warning. Continue without a writer.
8. After each seed result, build its required metadata and evidence.
9. Append the seed entry before adding the unchanged `SeedOutcome`.
10. Compute the existing `hit` once for each question.
11. Save `hit` and the exact score inputs.
12. Append the answer and evidence before adding the unchanged `QuestionOutcome`.
13. Finalize the manifest after normal completion and caught evaluation errors.
14. Preserve the original evaluation error if finalization also fails.
15. In `scripts/eval-recall.ts`, print a non-null artifact path to standard error.
16. Keep `formatReport` on standard output. Add no probe or retry.
17. Use temporary artifact roots in `test/eval-recall-run.test.ts`.
18. Keep each root separate from `tmpRoot`.
19. Check entry counts, metadata, outcomes, scores, and process evidence.
20. Test a valid but unwritable artifact root. Confirm that fixture calls still run.
21. Test the default root in `readOptions` tests.
22. Test temporary overrides and invalid values before executable preflight.
23. Check path and warning output on standard error.
24. Check unchanged aggregate output on standard output.
25. Add correlated tool events and a deterministic hang mode to `test/fixtures/fake-recall-pi.ts`.
26. Keep seed and answer behavior and `FAKE_RECORD_SKIP_FACT_IDS`.
27. Add an entry interruption test. Wait for the fake process, then send `SIGTERM`.
28. Check that interruption leaves the manifest unfinished and removes temporary isolation.
29. Keep the artifact root separate from `tmpRoot`.

## Acceptance

- [ ] Every completed seed and question outcome creates one entry when the writer is available. Failed and timed-out outcomes also create entries.
- [ ] Seed and question entries contain required metadata, outcomes, and process evidence. Scoring inputs match the existing scorer.
- [ ] Artifact failures warn and do not change later model calls or aggregate results.
- [ ] The default root and absolute `PI_EVAL_ARTIFACT_ROOT` override work as specified. Invalid overrides stop before executable preflight.
- [ ] Normal and interrupted runs preserve artifacts and remove temporary login links and isolation roots.
- [ ] The entry prints artifact paths and warnings only on standard error. Aggregate standard output stays unchanged.
- [ ] `node --experimental-strip-types --test test/eval-recall-run.test.ts test/eval-recall-entry.test.ts` passes.
