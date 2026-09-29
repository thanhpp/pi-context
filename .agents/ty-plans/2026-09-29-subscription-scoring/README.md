🤖

# Subscription Scoring — Plan

> Execute the tasks in dependency order. Each task file is self-contained. The user's confirmed intent is in [REQUIREMENTS.md](REQUIREMENTS.md).

**Goal:** Score model-based LongMemEval cases through the authenticated OpenAI subscription with `gpt-6-sol` and high reasoning effort.

**Context:** The benchmark currently calls a GPT-5.2 API-key judge for semantic cases. The user wants to avoid separate API billing without changing the answer model, deterministic rules, CLI, or existing results. Judge failures become incorrect scores; absent shared authentication also marks unanswered modes incorrect, but the run stays incomplete.

**Architecture:** Keep the pinned Python upstream evaluator for deterministic scoring and answer extraction. Add a preparation mode that returns semantic answer metadata without an API call. Add a TypeScript judge that copies the pinned semantic rubrics and binary parser, then sends one isolated, no-tools, no-session pi request through `openai-codex/gpt-6-sol` at high effort. The runner retains score JSON fields, private checkpoints, and the answer-model CLI. It checks judge model visibility during preflight, records failed semantic requests as incorrect grades, and records synthetic incorrect grades for absent shared authentication while keeping the run incomplete. The report labels its retained API-rate estimate as a comparison. The user chose TypeScript judging over a Python transport hook into the pinned upstream internals. This avoids changing the upstream checkout or binding the transport to two private upstream functions. It requires exact rubric and parser parity tests because copied rules can drift.

**Gating conditions:** Use Node.js 22.19 or newer, installed npm dependencies, Python 3.11, and a clean upstream LongMemEval-V2 checkout at commit `2cc8c540bdb87fe6761629b585e727e1c4704520`. A real dry run also needs the pinned external dataset. Installed pi 0.87.1 returned OAuth `ready` from `PI_OFFLINE=1 pi auth check --provider openai-codex --json --no-refresh`. `PI_OFFLINE=1 pi --offline --list-models gpt-6-sol` listed `openai-codex/gpt-6-sol`. These no-charge checks did not prove a live judgment or high-effort access. A live paid run requires separate operator approval. Existing checkpoints have a runner fingerprint that this change will replace; start a new run rather than resuming an old checkpoint.

**Output:** The benchmark uses subscription judging for new semantic cases, keeps deterministic scoring local, reports judge access failures as incorrect results, and provides tests and updated operator instructions.

## Tasks

| # | Task | Depends on | Covers | What it does |
|---|------|------------|--------|--------------|
| 1 | [Prepare upstream scoring data](01-prepare-upstream-scoring.md) | — | R2, R5, R9 | Provide semantic metadata without an API call; keep deterministic scoring. |
| 2 | [Build TypeScript judge](02-build-typescript-judge.md) | 1 | R1, R3, R5, R9 | Send isolated pi judge requests and parse binary outcomes. |
| 3 | [Connect judge to runner](03-connect-judge-to-runner.md) | 1, 2 | R1, R2, R3, R4, R6, R7, R8 | Connect preflight, checkpoint, report, and failure behavior. |
| 4 | [Document and check](04-document-and-check.md) | 3 | R4, R5, R6, R7, R8 | Update operator instructions and run no-charge checks. |

## Verification

1. Run `npm run check && npm test`; all type checks and local tests must pass without network requests.
2. Set `LME_UPSTREAM` and `DATA_ROOT` to the pinned external checkout and dataset. Run `npm run benchmark:longmemeval-v2 -- --data-root "$DATA_ROOT" --upstream-root "$LME_UPSTREAM" --set pilot --model openai-codex/gpt-6-luna --thinking medium --output-root .benchmarks/lme-v2` without `--execute`.
3. Check that the report says `preflight`, lists four eligible cases and 29 excluded images, and reports judge visibility. Do not run a paid pilot without separate approval.

## Out of Scope

- Changing the answer model is excluded; this plan changes the semantic judge only.
- Changing the dataset or evaluation rules is excluded; deterministic rules stay local and copied semantic rules must match the pinned upstream evaluator.
- Migrating or rescoring existing result files is excluded; only new runs use subscription judging.
- Adding subscription access to standalone Python scoring is excluded; the benchmark CLI owns the subscription judge.
