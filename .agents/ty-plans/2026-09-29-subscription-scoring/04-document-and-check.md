🤖

# Task 4: Document subscription scoring and check the full change

**Depends on:** [Task 3](03-connect-judge-to-runner.md)

**Goal:** Give operators exact no-charge preflight and paid-run instructions, then check all scoring paths without a live request.

**Files:**

- Modify: `docs/longmemeval-v2-setup.md`

**Reuses:** `npm run check`, `npm test`, and `npm run benchmark:longmemeval-v2 -- ...` in `package.json` check types, run local tests, and invoke the benchmark CLI. `pi auth check --provider openai-codex --json --no-refresh` checks local subscription credentials without refreshing them. `PI_OFFLINE=1 pi --offline --list-models gpt-6-sol` lists cached visible models without a paid request.

**Precondition:** Node.js 22.19 or newer, installed npm dependencies, Python 3.11 for the scorer, and the pinned dataset and upstream checkout for a real dry run. `LME_UPSTREAM` and `DATA_ROOT` must point to the external locations described in `docs/longmemeval-v2-setup.md`. Local checks on 2026-09-29 reported OAuth `ready` for `openai-codex` and listed `gpt-6-sol`; they did not validate a live judgment. A live paid pilot needs separate operator approval.

**Site conditions:** The documentation currently says semantic grading uses a pinned GPT-5.2 API judge, requires `OPENAI_API_KEY`, and stops on judge failures. It shows the answer model `openai-codex/gpt-6-luna` with medium effort; keep that independent answer-model example. It gives both a no-charge pilot preflight without `--execute` and a separately approved paid execution with `--execute`. A preflight writes a dated report under `docs/benchmarks/` and makes no model request. The new judge is always `openai-codex/gpt-6-sol` with high effort. Deterministic rules stay local. Subscription judge failures after an answer become incorrect scores; missing shared auth before answers produces incorrect displayed scores and an incomplete run. The existing `judgeInputUsdPerMillionTokens` and `judgeOutputUsdPerMillionTokens` rate fields remain for an illustrative API-rate comparison, not a subscription invoice. Do not change old benchmark reports or the dataset.

## Steps

1. Replace the API-key/GPT-5.2 instructions with `pi` subscription login, a no-refresh auth check, offline model visibility for the judge, and explicit high effort for the judge only. State that visibility and no-refresh auth checks do not prove live access and make no paid request. Keep the answer-model run commands and resume requirements unchanged.
2. Explain incorrect semantic results on judge failure, synthetic incorrect scores with an incomplete run when shared auth is absent, and the fact that other answer failures remain incomplete. Explain that the semantic rubric comes from the pinned upstream rules, but this adapted result uses a different judge model. Relabel judge rates and estimated USD as a comparison instead of a subscription charge. Preserve data privacy and separate approval instructions for execution.
3. Run `npm run check && npm test` with no live request. With the pinned external inputs configured, run the existing no-`--execute` pilot command from this document and check that the report shows four eligible cases, 29 excluded image cases, answer-model visibility, and a judge-model visibility warning only if the judge is absent. Do not run the paid pilot as part of this task.

## Acceptance

- [ ] Documentation has no instruction to supply `OPENAI_API_KEY` for benchmark scoring and does not call an API-rate estimate a subscription charge.
- [ ] `npm run check && npm test` → TypeScript checks and all local tests pass without a model request.
- [ ] `npm run benchmark:longmemeval-v2 -- --data-root "$DATA_ROOT" --upstream-root "$LME_UPSTREAM" --set pilot --model openai-codex/gpt-6-luna --thinking medium --output-root .benchmarks/lme-v2` → `status: preflight`, four eligible cases, 29 excluded image cases, and no paid request when the pinned external inputs are configured.
