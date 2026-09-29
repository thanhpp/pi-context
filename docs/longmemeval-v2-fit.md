# LongMemEval-V2 fit for pi-context

## Decision

Use LongMemEval-V2 as a secondary retrieval proxy. Do not use it as a coding-agent release gate. The benchmark tests memory for agents in custom browser environments. It asks a memory system to return evidence for a fixed reader. It does not test whether an agent completes coding tasks. The paper lists coding agents among the domains that LME-V2 does not cover, and it notes that its fixed-reader setup does not measure end-to-end task success ([paper, Appendix E.1](https://arxiv.org/html/2605.12493#A5.SS1)).

The mismatch is material. pi-context asks a Pi model to select and store project facts across sessions. It does not save complete transcripts. LME-V2 supplies web and enterprise trajectories, including accessibility trees and actions. Its upstream memory modules consume trajectories and return compact evidence. The official setup uses Qwen3.5-9B as the reader; the leaderboard checks for a Qwen3.5-9B reader and a GPT-5.2 judge ([upstream README, model setup](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/README.md#setup-model-endpoints-and-software), [leaderboard checks](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/leaderboard/README.md#step-1-build-one-operating-point)). A Pi/Luna or Pi/Sol result changes the memory interface and reader. Label every such score **adapted, non-official**. Do not compare it with leaderboard scores.

This benchmark can still show whether pi-context can preserve selected information from long, non-code histories. It cannot show whether pi-context improves coding work. Keep `npm run demo` as a separate project-memory check. Run it only after separate operator approval. This assessment did not run the demo or make paid model calls.

## Pinned data and coverage

The data source is the Hugging Face snapshot `f152293e235517d504809563c833d7190b8c713b`. The upstream code defines question, trajectory, and haystack files ([upstream loader at commit `2cc8c540bdb87fe6761629b585e727e1c4704520`](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/data/public_data.py), [dataset schema at the pinned snapshot](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/SCHEMA.md)). The loader checks these SHA-256 values before it uses the data:

| File | SHA-256 |
|---|---|
| `questions.jsonl` | `0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7` |
| `trajectories.jsonl` | `363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6` |
| `haystacks/lme_v2_small.json` | `9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593` |

The upstream README reports 451 questions in total. This snapshot has 422 text-only small-tier questions and 29 questions with images. All 29 image questions use the `errors-gotchas` type. The text-only set therefore has no eligible `errors-gotchas` question. The upstream validator still checks question-image files when screenshot checks are disabled ([CLI option](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/data/validate_data.py#L17-L27), [question-image check](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/data/public_data.py#L217-L229)). This setup does not download screenshot archives. The local loader validates selected text inputs instead.

**USER-AUTHORIZED OVERRIDE: four-case text-only pilot; omit errors-gotchas.** The five-group plan required one `errors-gotchas` case, but the image rule excludes every case in that group. The approved pilot keeps the other groups in their original order:

1. `static-environment`, prefer `web`.
2. `dynamic-environment`, prefer `enterprise`.
3. `procedure`, prefer `web`.
4. The union of question types ending in `-abs`, prefer `web`.

Each group uses the lexicographically smallest eligible ID in the preferred domain. It uses the smallest ID in the other domain only when the preferred domain has no eligible case. Selection fails if a group is empty or if the four choices do not cover both domains. The resulting manifest binds four fixed IDs, their domains and question types, the dataset revision, and the three source hashes. The override reduces coverage. The pilot does not test environment gotchas.

The full text-only set contains 422 questions across `web` and `enterprise`. It includes no `errors-gotchas` cases. Full mode must report the 29 image exclusions and must not claim to cover all 451 questions.

## Scoring limits

The upstream evaluator uses each question's `eval_function` specification. Its deterministic functions include normalized phrase matching and multiple-choice matching. Its abstention and gotcha functions use an LLM grader ([upstream scoring code](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/evaluation/qa_eval_metrics.py#L71-L109), [LLM graders](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/evaluation/qa_eval_metrics.py#L221-L355), [question-type mapping](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/evaluation/harness.py#L48-L62)). The selected four-case pilot contains three deterministic-scoring cases and one `-abs` case that uses `llm_abstention_checker`. The `-abs` case needs semantic grading for each answer mode. Reuse compatible upstream rules, but mark all Pi outcomes as adapted and non-official.

The upstream benchmark also measures query latency and, for its leaderboard, combines web and enterprise runs before it computes LAFS ([leaderboard metric contract](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/leaderboard/README.md#what-gets-scored)). This pilot uses four selected cases, not the full official question set. Its adapted score cannot represent an official tier score.

## Cost and storage

No price table in the pinned data or upstream benchmark repository sets a USD rate for the configured Pi Luna/Sol model. Do not apply a different provider's token rate to those model IDs. Check the active account's price before paid work. Record USD as `unknown` if no matching rate is available. Use measured token counts where Pi reports them.

For this four-case pilot, the paired answer stage needs eight Pi answer requests: four with project memory and four question-only controls. The pilot selects one LLM-graded abstention case. The grader can need up to two requests, one for each answer mode, before retries. The project-memory path also needs to ingest one 100-trajectory history for each domain. The actual number of ingestion requests and tokens depends on the Pi ingestion plan. Record ingestion use separately from answering. The question-only control has no history-ingestion cost.

The selected data files need local storage. The pinned `trajectories.jsonl` file is about 1.2 GiB on this machine. The run also needs space for memory files and reports. pi-context's default project quota is 10 MiB; it stores selected facts, not full transcripts ([configuration and quota](../README.md#configuration)). Check the quota before paid work. Download bandwidth and local storage costs depend on the operator's service and hardware. The upstream repository does not give USD estimates for them.

Do not report a score or a USD cost when missing data, model access, judge access, or a matching rate blocks the run. Require operator approval before paid model work. Keep the existing `npm run demo` check separate from this benchmark.
