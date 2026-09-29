🤖
# Task 5: Document and check setup

**Depends on:** [Task 1](01-assess-fit-and-select-data.md), [Task 2](02-run-isolated-pi-sessions.md), [Task 3](03-bridge-scoring-and-costs.md), [Task 4](04-orchestrate-and-resume-runs.md)

**Goal:** Give an operator exact reusable local commands, safety limits, and acceptance checks for a paid pilot.

**Files:**

- Create: `docs/longmemeval-v2-setup.md`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`

**Reuses:** `docs/longmemeval-v2-fit.md` holds the source-backed proxy decision; `scripts/longmemeval-v2.ts` is the CLI; `scripts/longmemeval-v2/pilot.json` pins case IDs. `npm run check`, `npm test`, and `npm run demo` already exist in `package.json`. The upstream `data/download_data.py` downloads the complete dataset snapshot, including screenshot archives; use Hugging Face `snapshot_download` with `allow_patterns` to avoid that transfer for this text-only proxy. The upstream `data/validate_data.py --no-check-screenshots` still checks question-image paths, so use the dataset loader's selected-case validation instead.

**Precondition:** Tasks 1–4 are complete; Python 3.11, Git, Node >=22.19.0, Pi 0.87.1, a configured `openai-codex` Luna or Sol model, and sufficient disk are available. Paid pilot acceptance needs explicit operator approval, an authenticated answer model, and `OPENAI_API_KEY` for semantic grading. No approval means the operator performs only offline and preflight checks.

**Site conditions:** Upstream code is pinned at `2cc8c540bdb87fe6761629b585e727e1c4704520`; the dataset is pinned at `f152293e235517d504809563c833d7190b8c713b`. Pin file hashes against upstream `checksums.sha256`, not only the checkout name. `questions.jsonl`, `trajectories.jsonl`, and `haystacks/lme_v2_small.json` are sufficient for the selected text-only path. Do not claim the full mode scores all 451 questions; it scores every eligible small-tier question with no question image. pi-context records selected facts under the Pi agent directory by Git identity, with a default 10 MiB quota, and memory can remain after the run. Pi JSON/print mode cannot approve ask-mode memory cleanup automatically. Do not delete active user memory with shell commands. Logs can contain history and answers; prevent credentials, gold data, and raw logs from entering Git. Model prices and judged-call usage can be unknown; a displayed estimate is not a spend cap. This checkout has no Git HEAD, so report a plugin-source fingerprint until a commit exists. Python 3.11 is not installed here; install it in an external environment before scoring. `npm run demo` needs separate paid-call approval and is not replaced by the V2 proxy.

## Steps

1. Add `"benchmark:longmemeval-v2": "node --experimental-strip-types scripts/longmemeval-v2.ts"` to `package.json`. Ignore only `.benchmarks/` in `.gitignore`. Add a short link to `docs/longmemeval-v2-setup.md` in `README.md`; do not change existing plugin behavior or tests.
2. In the setup guide, give the exact external setup: `export LME_UPSTREAM="$HOME/benchmarks/LongMemEval-V2"; export DATA_ROOT="$HOME/benchmarks/longmemeval-v2"`; `mkdir -p "$HOME/benchmarks"; if [ ! -d "$LME_UPSTREAM/.git" ]; then git clone https://github.com/xiaowu0162/LongMemEval-V2 "$LME_UPSTREAM"; fi`; `git -C "$LME_UPSTREAM" checkout 2cc8c540bdb87fe6761629b585e727e1c4704520`; `git -C "$LME_UPSTREAM" rev-parse HEAD` must equal that commit; `export LME_VENV="$HOME/benchmarks/lme-venv"; python3.11 -m venv "$LME_VENV"; "$LME_VENV/bin/python" -m pip install -e "$LME_UPSTREAM"; export PATH="$LME_VENV/bin:$PATH"`. Install Python 3.11 first if that executable is missing. Show `snapshot_download(repo_id='xiaowu0162/longmemeval-v2', repo_type='dataset', revision='f152293e235517d504809563c833d7190b8c713b', local_dir=DATA_ROOT, allow_patterns=['questions.jsonl', 'trajectories.jsonl', 'haystacks/lme_v2_small.json', 'checksums.sha256', 'LICENSE', 'SCHEMA.md'])`. Put the data and checkout outside the pi-context repository. Run `(cd "$DATA_ROOT" && sha256sum -c --ignore-missing checksums.sha256)` and stop on mismatch. Explain why the complete upstream downloader and screenshot validator are not used.
3. Document `node --experimental-strip-types scripts/longmemeval-v2/select-pilot.ts --data-root "$DATA_ROOT" --output scripts/longmemeval-v2/pilot.json` and the approved pilot ID manifest. Give offline `npm run check` and `npm test` commands. Give a no-charge preflight: `npm run benchmark:longmemeval-v2 -- --data-root "$DATA_ROOT" --upstream-root "$LME_UPSTREAM" --set pilot --model openai-codex/gpt-6-luna --thinking medium --output-root .benchmarks/lme-v2`. Tell the operator to check candidate model IDs with `pi --list-models luna` or `pi --list-models sol`; pin one exact ID per run. Give separate `--set full`, `--execute`, and `--resume <run-dir> --execute` examples. Show the same flags for Sol without silently switching models.
4. Explain preflight call counts, rough token-cost assumptions, unknown USD rates, `--rates-json` fields, GPT-5.2 judge credentials, the cost of history ingestion versus question-only controls, and storage/download cost. Explain 0700 run directories, private logs, 10 MiB quota stops, inability to claim leaderboard equivalence, excluded image counts, and how to retain case reports tagged by Git revision or plugin-source fingerprint. Document that a partial report cannot be read as a complete score. State how to inspect benchmark-owned memory from the reported project ID without deleting the user's normal project memory. Require explicit approval before the paid pilot and separate approval before `npm run demo`.
5. After approval, run one pinned paid pilot with `--execute`, save its Git-revision-tagged or fingerprint-tagged report and measured usage/cost states, then run `npm run demo` only if separately approved. If credentials, dataset files, judge access, or quota block execution, preserve the failed checkpoint and state the exact precondition; do not claim a successful benchmark.

## Acceptance

- [ ] `npm run check` and `npm test` → pass without API calls or dataset downloads.
- [ ] The documented preflight command exits successfully with eligible/excluded counts, estimated or unknown USD, and no paid calls.
- [ ] After explicit approval, the documented pilot command with `--execute` writes paired non-official outcomes, token usage, cost states, and a versioned report; an incomplete run exits nonzero and remains resumable.
- [ ] The guide presents `npm run demo` as a separate project-memory check and includes no leaderboard-score claim.
