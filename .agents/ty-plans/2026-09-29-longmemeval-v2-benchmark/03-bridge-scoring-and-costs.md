🤖
# Task 3: Bridge scoring and costs

**Depends on:** [Task 1](01-assess-fit-and-select-data.md), [Task 2](02-run-isolated-pi-sessions.md)

**Goal:** Score Pi answers with compatible upstream evaluation functions and report costs without treating unknown prices as zero.

**Files:**

- Create: `scripts/longmemeval-v2/score.py`
- Create: `scripts/longmemeval-v2/cost.ts`
- Create: `test/longmemeval-v2-score.test.ts`
- Create: `test/longmemeval-v2-cost.test.ts`

**Reuses:** The pinned upstream `evaluation/qa_eval_metrics.py` exports `extract_boxed_answer(text: str) -> str`, `is_unknown(parsed_answer: str) -> bool`, `eval_name(eval_spec: str) -> str`, `eval_from_spec(spec: str, *args: Any, **overrides: Any) -> Any`, and `score_to_bool(score: Any) -> bool`. Its `evaluation/harness.py` `score_prediction(row: dict[str, Any], eval_config: dict[str, Any]) -> tuple[bool, str, bool]` shows how to supply `question_item`, parsed answer, full response, and evaluator settings to semantic graders. `UsageTotals` in `scripts/longmemeval-v2/pi.ts` supplies final Pi message and nested-tool token counts.

**Precondition:** An external Python 3.11 environment has the upstream LongMemEval-V2 checkout installed at commit `2cc8c540bdb87fe6761629b585e727e1c4704520`. Semantic grading requires an OpenAI API key only for runs with an explicit execution flag. Dataset snapshots and credentials must remain outside the project repository.

**Site conditions:** Questions have `answer` and `eval_function` in `questions.jsonl`; neither goes to Pi's working directory or prompt. The official harness grades deterministic answers through `eval_from_spec` and uses `llm_abstention_checker`/`llm_gotchas_checker` for semantic cases. It forces `UNKNOWN` answers to incorrect. The official default judge is GPT-5.2 with medium reasoning. Pi reports provider usage in assistant `message_end` values; usage can be absent or cost can be zero because billing is not available. The upstream semantic checker does not expose a complete billable usage ledger to this bridge. Thus judge USD can be unknown. A missing rate or usage must produce `null` USD with a reason, never a false zero. Model requests for history ingestion count only on the memory side; the control receives only a fresh question. These scores remain adapted and non-official.

## Steps

1. Define `score_case(question: dict[str, Any], response_raw: str, *, execute: bool, evaluator_model: str = 'gpt-5.2') -> dict[str, Any]` in `score.py`. Accept one JSON case on stdin and write one JSON result on stdout. Use the upstream imports above to extract the answer, evaluate deterministic specifications, and mark `UNKNOWN` wrong. For `llm_abstention_checker` and `llm_gotchas_checker`, require `execute`, `OPENAI_API_KEY`, and the selected GPT-5.2 judge; provide the upstream `question_item`, parsed prediction, and full response. Missing credentials, malformed grade output, or an exception must exit nonzero with the case ID on stderr; do not silently score zero. Do not log the API key. If the upstream evaluator changes signature, stop with a compatibility error.
2. Export `estimateCost(usage: UsageTotals | null, rates: ModelRates | null): CostEstimate` and `estimatePreflight(input: { historyBytes: number; questionCount: number; sessionCount: number; rates: ModelRates | null }): CostEstimate` from `cost.ts`. Define rate fields as USD per million input/output/cache-read/cache-write tokens, plus judge rate fields if supplied. Estimate input tokens as rendered UTF-8 bytes divided by four plus 1,024 prompt/tool overhead tokens per Pi session. Assume 512 output tokens per Pi session and, for semantic cases, 1,024 judge input plus 256 judge output tokens per call. Label these assumptions as rough, never a firm maximum. Return nullable USD with a reason when rates or usage are absent; report judge call count and unknown judge usage separately. Preserve Pi reported cost as a distinct field, not a substitute for a verified USD bill.
3. Test deterministic correct, wrong, `UNKNOWN`, and malformed `eval_function` responses against the pinned upstream scorer without making a judge call. Mock the judge path for missing credentials and semantic failures. Test known rates, missing rates, missing usage, and separation of ingestion, question, and judge cost. The Node tests must skip upstream-dependent checks with an explicit message only when the upstream checkout is not configured; CI-free default tests must remain offline.

## Acceptance

- [ ] Deterministic cases match the pinned upstream `eval_from_spec`; semantic cases cannot call the judge without explicit execution and credentials.
- [ ] Unknown model or judge prices appear as `null` USD with an explanation, while measured token totals stay present.
- [ ] `node --experimental-strip-types --test test/longmemeval-v2-score.test.ts test/longmemeval-v2-cost.test.ts` → offline scoring and cost checks pass; with `LME_UPSTREAM` set, the upstream deterministic compatibility checks also pass.
