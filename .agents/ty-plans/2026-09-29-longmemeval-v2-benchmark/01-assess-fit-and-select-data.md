🤖
# Task 1: Assess fit and select data

**Depends on:** None

**Goal:** Record the limits of the secondary proxy and pin a reproducible text-only small-tier pilot and full eligible set.

**Files:**

- Create: `docs/longmemeval-v2-fit.md`
- Create: `scripts/longmemeval-v2/dataset.ts`
- Create: `scripts/longmemeval-v2/select-pilot.ts`
- Create: `scripts/longmemeval-v2/pilot.json`
- Create: `test/longmemeval-v2-dataset.test.ts`

**Reuses:** `resolveProject(cwd: string, agentDir: string, config: ContextConfig): Promise<ProjectResolution>` in `src/project.ts` documents Git-based project identity. `data.public_data.load_questions`, `load_trajectories`, and `load_haystack` in the pinned upstream `data/public_data.py` define the source layout; use their field contract, not a duplicate dataset download.

**Precondition:** Install Python 3.11 outside this repository; this machine has only Python 3.13.5. Set `export LME_UPSTREAM="$HOME/benchmarks/LongMemEval-V2" DATA_ROOT="$HOME/benchmarks/longmemeval-v2" LME_VENV="$HOME/benchmarks/lme-venv"`. Run `mkdir -p "$HOME/benchmarks"` and `git clone https://github.com/xiaowu0162/LongMemEval-V2 "$LME_UPSTREAM"`, then `git -C "$LME_UPSTREAM" checkout 2cc8c540bdb87fe6761629b585e727e1c4704520`. If the checkout already exists, check `git -C "$LME_UPSTREAM" rev-parse HEAD` instead of cloning again; it must equal that commit. Run `python3.11 -m venv "$LME_VENV"` and `"$LME_VENV/bin/python" -m pip install -e "$LME_UPSTREAM"`. Run `"$LME_VENV/bin/python" -c 'import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id="xiaowu0162/longmemeval-v2", repo_type="dataset", revision="f152293e235517d504809563c833d7190b8c713b", local_dir=os.environ["DATA_ROOT"], allow_patterns=["questions.jsonl", "trajectories.jsonl", "haystacks/lme_v2_small.json", "checksums.sha256", "LICENSE", "SCHEMA.md"])'`. Run `(cd "$DATA_ROOT" && sha256sum -c --ignore-missing checksums.sha256)`; the expected hashes for `questions.jsonl`, `trajectories.jsonl`, and `haystacks/lme_v2_small.json` are `0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7`, `363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6`, and `9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593`, respectively. Stop before paid work if a hash differs.

**Site conditions:** The raw dataset stores `id`, `domain`, `question_type`, `question`, `image`, `answer`, and `eval_function` in `questions.jsonl`; trajectories have `id`, `domain`, and ordered `states` with `action`, `accessibility_tree`, `thought`, and screenshot references. `haystacks/lme_v2_small.json` maps every question ID to ordered trajectory IDs; small-tier questions share one 100-trajectory history in each domain. Exclude raw questions with non-null `image`. Do not include answers, evaluator specs, screenshot paths, or dataset file paths in Pi workspace/prompt content. The upstream `data/validate_data.py --no-check-screenshots` still checks question-image paths; it cannot validate this selective download unchanged. The upstream [README](https://github.com/xiaowu0162/LongMemEval-V2/blob/main/README.md) describes 451 total questions; the [paper limitations, Appendix E.1](https://arxiv.org/html/2605.12493) exclude coding-agent task success. The [leaderboard rules](https://github.com/xiaowu0162/LongMemEval-V2/blob/main/leaderboard/README.md) require Qwen reader and GPT-5.2 judge. pi-context saves selected facts, not transcripts, with a default 10 MiB quota (`README.md`, `src/config.ts`); describe the modality, domain, quota, and reader mismatches as limits of this secondary proxy. Stop if no eligible cases or if history cannot be rendered without labels.

## Steps

1. Document the suitability decision, source links, explicit non-official score label, expected costs (ingestion, answering, semantic grading, storage, downloads), missing published dollar rates, and the separate `npm run demo` project-memory check in `docs/longmemeval-v2-fit.md`.
2. Export `loadDataset(root: string): Promise<BenchmarkDataset>`, `selectCases(dataset: BenchmarkDataset, set: 'pilot' | 'full', pilotIds: readonly string[]): QuestionCase[]`, and `renderTrajectory(trajectory: Trajectory): string[]` from `dataset.ts`. Define the exported types in that file. Validate IDs, duplicate IDs, domain matches, 100 ordered trajectories per small-tier question, required text fields, file hashes, and that at least one eligible question remains in both domains. Return ordered state/action/accessibility text chunks of at most 32 KiB each; omit screenshots, thoughts, answer labels, and gold data. Never truncate an oversized observation silently; split it at a UTF-8 boundary while preserving order.
3. In `select-pilot.ts`, add `--data-root <absolute-path>` and `--output <path>` arguments. From the pinned snapshot, select five groups in order: `static-environment`, `dynamic-environment`, `procedure`, `errors-gotchas`, and the union of types ending `-abs`. Exclude `-abs` from the first three groups. For groups 1, 3, and 5 prefer `web`; for groups 2 and 4 prefer `enterprise`. Within the preferred domain choose the lexicographically smallest eligible ID; if none exists there, choose the smallest in the other domain. If a group is empty or the five choices do not include both domains, fail instead of silently changing the pilot. Write `pilot.json` with dataset revision, source hashes, IDs, domains, and question types; load it only if its hashes still match.
4. Test missing files, changed hashes, duplicate IDs, cross-domain haystacks, image exclusion, deterministic pilot IDs, complete text ordering, large observation splitting, and omission of gold/screenshot material with temporary synthetic fixtures. Keep default `npm test` offline.

## Acceptance

- [ ] `docs/longmemeval-v2-fit.md` cites the upstream data, reader requirements, scoring contract, and paper limits; it calls Pi scores non-official.
- [ ] `node --experimental-strip-types --test test/longmemeval-v2-dataset.test.ts` → all offline dataset checks pass.
- [ ] `node --experimental-strip-types scripts/longmemeval-v2/select-pilot.ts --data-root "$DATA_ROOT" --output scripts/longmemeval-v2/pilot.json` → a fixed, hash-bound pilot manifest from the pinned dataset; it includes both domains where available and no image questions.
