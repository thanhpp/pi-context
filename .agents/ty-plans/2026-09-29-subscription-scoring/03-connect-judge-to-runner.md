🤖

# Task 3: Connect subscription judging to benchmark runs

**Depends on:** [Task 1](01-prepare-upstream-scoring.md), [Task 2](02-build-typescript-judge.md)

**Goal:** Make benchmark runs, preflight reports, and checkpoints use the subscription judge while preserving current CLI and score fields.

**Files:**

- Modify: `scripts/longmemeval-v2/run.ts`
- Modify: `test/longmemeval-v2-run.test.ts`

**Reuses:** `runListModels(options: RunOptions): boolean`, `modelIsListed(output: string, model: string): boolean`, `makePreflight(options: RunOptions): Promise<PreflightData>`, `runScorer(options: RunOptions, runDirectory: string, checkpoint: Checkpoint, checkpointPath: string, input: { key: string; question: RawQuestion; answer: string; caseId: string; mode: 'memory' | 'control'; execute: boolean }): Promise<ScoreResult>`, `parseScoreOutput(text: string, expectedId: string): ScoreResult | null`, `refreshCaseResults`, `finalizeCosts`, and `executeBenchmark` in `scripts/longmemeval-v2/run.ts` already manage grading, recovery, and reports. `judgeSemanticCase(input: SemanticJudgeInput): Promise<SemanticJudgeResult>` in `scripts/longmemeval-v2/judge.ts` judges semantic cases through pi.

**Precondition:** The pinned dataset and upstream checkout are required for a real benchmark preflight. Existing test fixtures in `test/longmemeval-v2-run.test.ts` supply synthetic data, a fake grader, a fake pi process, and a fake auth file. A local no-refresh auth check returned OAuth `ready` and an offline list contained `openai-codex/gpt-6-sol`; neither check proves live model access. Old run checkpoints have a runner fingerprint that will change, so only fresh runs and runs first created after this change can resume.

**Site conditions:** `RunOptions.model` and `RunOptions.thinking` select the answer model and must not change. The CLI flags in `parseRunArguments(args: readonly string[]): RunOptions` must remain unchanged. `runScorer` currently launches `score.py` for all cases; its score JSON has `id`, `score`, `evalName`, `parsedAnswer`, `isUnknown`, `semanticJudge`, and `judgeUsage`. Keep these names and the existing case report columns. A semantic question is identified by `isSemantic(raw: RawQuestion): boolean`; the prepared metadata from `score.py --prepare-semantic` supplies `id`, `evalName`, `parsedAnswer`, and `isUnknown`. Normal deterministic scoring still calls the Python scorer. A complete `grade-*` checkpoint and valid private stdout JSON are reused on resume. A failed grade stops the run today. A missing `auth.json` also stops execution before any answer stage; a missing judge API key currently stops all execution. The new rule is: after an answer exists, any judge auth, model, transport, timeout, or output failure becomes a complete incorrect grade and does not stop the run. If shared pi auth is missing before answers, mark both modes of each unanswered case incorrect in the report, but keep run status incomplete. Other answer failures stay incomplete. Preserve valid earlier scores on resume. `judgeCost` retains the existing API-rate estimate only as a comparison, not an actual subscription charge.

## Steps

1. Generalize the local model-list check so preflight checks both the answer model and `openai-codex/gpt-6-sol`. Keep `RunReport.modelVisible` about the answer model and keep all existing report fields. Add a sanitized warning when the judge model is absent; a dry run must not send a paid request. Remove the `OPENAI_API_KEY` warning and execution gate. Retain answer model, storage, Python, and fixture preconditions.
2. For semantic cases in `runScorer`, ask `score.py --prepare-semantic` for upstream metadata, check its case ID and evaluator name, then call `judgeSemanticCase` with the reference answer, full response, parsed answer, private run directory, and the selected source auth directory. Preserve the existing 5-minute grader limit and private log size and mode limits. Construct the existing `ScoreResult` JSON, set `semanticJudge: true`, set `judgeUsage: null`, and force the score to false if `isUnknown` is true. Treat invalid preparation or upstream compatibility as an incomplete grader failure, not as an incorrect judge result. On a judge failure, write a valid false score to the private grade stdout and a safe error code to its private stderr, then commit a complete grade checkpoint so resume does not make another judge request.
3. If shared pi auth is absent before answer execution, create a distinct failed grade checkpoint for each ungraded mode with `score: false` and error code `MODEL_AUTH_NOT_AVAILABLE`, without an answer or judge request. Make `refreshCaseResults` show these modes as incorrect while their case status and overall run status stay incomplete. Do not count these synthetic grades as judge calls. A later resume with restored auth must replace the synthetic failed stages with real answer and grade stages; keep valid earlier stages unchanged. Do not change behavior for model mismatch, quota, or other answer-stage failures.
4. Keep the `judgeCost` value and rate file fields, but change report text to identify it as an API-rate comparison rather than a subscription invoice. Keep the report header, case table, status names, and score fields. Update the fake pi and grader paths in `test/longmemeval-v2-run.test.ts` so semantic cases use fake subscription events rather than the fake Python semantic grader. Test dry-run judge model visibility, successful deterministic and semantic pairs, an invalid semantic judge output, missing judge access after an answer, missing shared auth before answers, synthetic-score resume, and unchanged behavior for other answer errors. Confirm report text contains no gold answers, secret values, raw events, or private paths.

## Acceptance

- [ ] A dry run checks the judge model without a paid request and does not require `OPENAI_API_KEY`.
- [ ] Failed judge calls after answers produce incorrect scores and continue. Missing shared auth produces incorrect displayed scores but an incomplete run; resume can replace synthetic scores.
- [ ] `node --experimental-strip-types --test test/longmemeval-v2-run.test.ts` → all runner tests pass using fake processes.
- [ ] `npm run check` → TypeScript reports no errors.
