🤖
# LongMemEval-V2 secondary benchmark — Plan

> Execute the tasks in dependency order. Each task file is self-contained. The confirmed scope is in [REQUIREMENTS.md](REQUIREMENTS.md).

**Goal:** Prepare a repeatable local Pi-session comparison of pi-context against a question-only control on eligible LongMemEval-V2 small-tier questions.

**Context:** pi-context retains selected project facts across sessions. LongMemEval-V2 tests retrieval from large web and enterprise histories, not coding-project task success. This plan treats it as a secondary proxy, measures setup and model costs, and keeps the existing project-memory demo as a separate check. This folder is the only output of this planning session; no benchmark was run.

**Architecture:** Keep the benchmark outside `src/`. A dataset loader selects pinned, text-only small-tier questions and renders trajectory accessibility trees and actions without gold answers or screenshots. A TypeScript runner reuses the subprocess and JSONL pattern in `scripts/two-session-demo.ts`: Pi runs history ingestion with only pi-context, then answers in a new session sharing the same Git fixture and project memory. A separate Pi process answers each question without the extension or history. Reuse compatible scoring functions from the pinned upstream Python package through a small bridge; use GPT-5.2 only for categories whose official grading requires an LLM. Collect Pi usage, label unsupported USD prices unknown, and keep atomic checkpoints and reports tagged by Git revision or source fingerprint. A setup guide explains both the pilot and all eligible text-only small-tier cases.

The upstream memory interface supplies bounded evidence to a fixed Qwen reader. A Pi model that chooses when to record memory cannot use that interface unchanged. The leaderboard also requires a Qwen reader and GPT-5.2 judge, so Luna/Sol results are **non-official**. Do not compare these scores with leaderboard scores. The question-only control has no ingestion cost; record its cost separately instead of implying equal work. A Pi SDK rewrite is not needed: the existing demo already starts isolated JSONL subprocesses and checks settled runs. The text-only subset avoids downloading large screenshot bundles; it excludes question-image cases and changes the multimodal task. The official validator still checks question-image paths even with `--no-check-screenshots`, so validate the selected text-only inputs in the local loader instead.

**Gating conditions:** Node >=22.19.0, Pi 0.87.1, TypeScript 5.9.3, Python 3.11, Git, and the pinned LongMemEval-V2 checkout at upstream commit `2cc8c540bdb87fe6761629b585e727e1c4704520` are required. Pin the Hugging Face dataset snapshot at `f152293e235517d504809563c833d7190b8c713b`. Check its published SHA-256 entries for `questions.jsonl`, `trajectories.jsonl`, and `haystacks/lme_v2_small.json` before Task 1 generates the pilot ID manifest. The dataset, Python environment, and model/judge credentials are external preconditions; no data or credentials enter Git. This machine has Python 3.13.5 but no `python3.11`; install Python 3.11 before Task 1 to download pinned data. This checkout has no Git HEAD and its project files are untracked; record a deterministic plugin-source fingerprint instead of inventing a revision until it has a commit. Pi must list the selected `openai-codex` Luna or Sol model. Semantic judging needs separate OpenAI API access. The upstream dataset has 451 total questions and shared 100-trajectory small-tier haystacks per domain; the eligible text-only count is determined from the pinned snapshot. pi-context defaults to a 10 MiB project quota and does not ingest transcripts automatically. The pilot must estimate ingestion calls and state quota limits before paid work. For N eligible questions and J semantic questions, paired answering needs 2N Pi calls and up to 2J judge calls before retries, plus domain-history ingestion calls. Full small-tier histories contain 100 trajectories per domain; selective text download avoids the upstream screenshot archives. No hard USD cap applies; unknown USD prices remain unknown. Require operator approval and `--execute` for every paid run or resume.

**Output:** A suitability report, fixed pilot manifest, local runner and scoring bridge, offline tests, a repeatable setup guide, and case-level reports tagged by Git revision or source fingerprint after an approved pilot.

## Tasks

| # | Task | Depends on | Covers | What it does |
|---|------|------------|--------|--------------|
| 1 | [Assess fit and select data](01-assess-fit-and-select-data.md) | — | R1, R3, R4 | Record limitations; validate text-only small-tier data and pin diverse pilot IDs. |
| 2 | [Run isolated Pi sessions](02-run-isolated-pi-sessions.md) | 1 | R2, R5, R7 | Run extension-on ingestion/question sessions and a question-only control; capture usage. |
| 3 | [Bridge scoring and costs](03-bridge-scoring-and-costs.md) | 1, 2 | R3, R6, R7 | Reuse upstream grading and estimate costs without inventing unknown prices. |
| 4 | [Orchestrate and resume runs](04-orchestrate-and-resume-runs.md) | 1, 2, 3 | R2, R4, R5, R6, R7, R8, R9 | Add the guarded CLI, report format, checkpoint recovery, and offline tests. |
| 5 | [Document and check setup](05-document-and-check-setup.md) | 1, 2, 3, 4 | R1, R4, R6, R8, R10, R11 | Add repeatable commands, safe data setup, suitability limits, and approved pilot checks. |

## Verification

Run `npm run check` and `npm test` without model credentials; both must pass. Run `npm run benchmark:longmemeval-v2 -- --data-root "$DATA_ROOT" --upstream-root "$LME_UPSTREAM" --set pilot --model openai-codex/gpt-6-luna --thinking medium --output-root .benchmarks/lme-v2` without `--execute`; it must list selected and excluded IDs, show estimates or unknown USD, and make no model calls. After the operator approves paid calls and the grader/model preflight passes, repeat with `--execute`; its report must contain paired non-official outcomes and recorded usage/cost states. Run `npm run demo` only with separate operator approval to check coding-project memory. Full mode uses `--set full` and the same text-only eligibility rules; it is not a 451-question claim.

## Out of Scope

- CI and scheduled execution; the first workflow is local.
- pi-context memory redesign; the benchmark measures existing behavior.
- Official leaderboard submission or comparable leaderboard scores; Pi reader and memory contracts differ.
- Using LongMemEval-V2 alone as a coding-project release gate; keep the separate project-memory demo.
- Medium-tier and screenshot-question scoring in the first setup; these need separate cost and modality decisions.
