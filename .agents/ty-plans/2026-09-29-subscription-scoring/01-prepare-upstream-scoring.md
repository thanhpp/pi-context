🤖

# Task 1: Prepare pinned upstream scoring data

**Depends on:** None

**Goal:** Let the TypeScript runner get the pinned evaluator's answer metadata without making an API request.

**Files:**

- Modify: `scripts/longmemeval-v2/score.py`
- Modify: `test/longmemeval-v2-score.test.ts`

**Reuses:** `_load_upstream`, `_require_question`, and `score_case` in `scripts/longmemeval-v2/score.py` validate the pinned upstream checkout, the case, and deterministic scores.

**Precondition:** A clean LongMemEval-V2 upstream checkout at commit `2cc8c540bdb87fe6761629b585e727e1c4704520` is available through `LME_UPSTREAM` for upstream-backed tests; Python 3.11 is available. Tests that need the upstream checkout must keep their existing skip behavior when it is absent.

**Site conditions:** `score_case(question: dict[str, Any], response_raw: str, *, execute: bool, evaluator_model: str = "gpt-5.2") -> dict[str, Any]` loads the pinned `evaluation/qa_eval_metrics.py`, calls `extract_boxed_answer`, `eval_name`, `is_unknown`, and `eval_from_spec`. The semantic names are `llm_abstention_checker` and `llm_gotchas_checker`. The current semantic branch requires `OPENAI_API_KEY`, GPT-5.2, and medium effort. `main() -> int` reads `{ "question": ..., "responseRaw": ... }` from stdin. It writes one JSON score line or writes `SCORE_ERROR case_id=... code=...` to stderr. Keep the existing deterministic JSON output and its local evaluation rules. Direct Python semantic execution is not a subscription entry point; do not retain a path that charges a separate OpenAI API key. Preserve the existing CLI flags, including `--evaluator-model`, although the benchmark runner will no longer use that flag for semantic calls.

## Steps

1. Add a `--prepare-semantic` mode to `main()`. Validate the case and response, load the pinned evaluator, and return exactly one JSON object with `id`, `evalName`, `parsedAnswer`, and `isUnknown`. Require one of the two semantic evaluator names. Use upstream `extract_boxed_answer`, `eval_name`, and `is_unknown`. Do not call `eval_from_spec` or any model in this mode.
2. Keep `score_case` for deterministic cases. For direct semantic `--execute`, return a stable `SEMANTIC_RUNNER_REQUIRED` error instead of reading `OPENAI_API_KEY` or calling the upstream API. Keep malformed input and upstream-compatibility failures as errors with a case ID; do not turn them into incorrect grades.
3. Update `test/longmemeval-v2-score.test.ts` to check deterministic correct, wrong, UNKNOWN, and malformed results; semantic preparation for both evaluator names; and a direct semantic call that cannot make an API call. Replace the GPT-5.2/API-key tests. Keep upstream-dependent tests conditional on `LME_UPSTREAM`.

## Acceptance

- [ ] Semantic preparation outputs only upstream-derived metadata and makes no model request, even with `OPENAI_API_KEY` present.
- [ ] Direct semantic scoring never calls the old API judge; deterministic scores keep the existing JSON field names and values.
- [ ] `LME_UPSTREAM="$HOME/benchmarks/LongMemEval-V2" node --experimental-strip-types --test test/longmemeval-v2-score.test.ts` → scorer tests pass with the pinned checkout.
