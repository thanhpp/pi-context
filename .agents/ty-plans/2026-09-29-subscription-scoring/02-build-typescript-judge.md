🤖

# Task 2: Build the TypeScript subscription judge

**Depends on:** [Task 1](01-prepare-upstream-scoring.md)

**Goal:** Judge semantic cases through one isolated pi subscription request per case and return a binary result without an API key.

**Files:**

- Create: `scripts/longmemeval-v2/judge.ts`
- Create: `test/longmemeval-v2-judge.test.ts`
- Create: `test/fixtures/fake-judge-pi.ts`

**Reuses:** The JSON event framing and model identity checks in `scripts/longmemeval-v2/pi.ts` show how existing pi sessions check `message_end` and `agent_settled`. The pinned upstream `evaluation/qa_eval_metrics.py` at revision `2cc8c540bdb87fe6761629b585e727e1c4704520` supplies the exact abstention and gotchas system prompts, user prompt templates, and `_parse_llm_binary_judgement` contract. The new `--prepare-semantic` mode in `scripts/longmemeval-v2/score.py` supplies `parsedAnswer` and `isUnknown` without a model call.

**Precondition:** The operator has used pi `/login` for `openai-codex`. An offline check with installed pi 0.87.1 reported `ready` OAuth credentials and listed `openai-codex/gpt-6-sol`; it did not prove live model access. No live request is required for tests. The pinned upstream evaluator source must be available to copy its exact rubric text and compare the parser behavior.

**Site conditions:** Add exported `SemanticJudgeInput` with `question: string`, `answer: string`, `responseRaw: string`, `parsedAnswer: string`, `evaluator: 'llm_abstention_checker' | 'llm_gotchas_checker'`, `cwd: string`, `authDirectory: string`, and optional test-only executable path, arguments, and timeout. Add exported `SemanticJudgeResult` with `score: boolean` and `errorCode: string | null`. Export `judgeSemanticCase(input: SemanticJudgeInput): Promise<SemanticJudgeResult>`. The model is always `openai-codex/gpt-6-sol` with `high` reasoning effort; it is independent of the answer model in `RunOptions.model`. For abstention, require a flaw-aware answer or an explicit inability to check the live environment without a premise-following answer. Generic UNKNOWN and contradictions are incorrect. For gotchas, require at least one reference insight and no contradiction. Both rubrics ask for JSON with `label` 0 or 1 and `reason`. The upstream parser accepts a JSON object inside text or a markdown fence, string or numeric binary labels, and fallback `label: 0|1` patterns; it rejects empty or nonbinary output. The upstream evaluator passes the full response and extracted final answer. A literal `UNKNOWN` extracted answer is incorrect after judgment. The existing `pi.ts` session launcher requires a persistent session and answer-specific modes; do not reuse it for a judge that contains a reference answer.

**Pinned rubric text:** Use these exact system instructions. Abstention: “You are a strict grader for flawed-premise (abstention) questions. Judge whether a model answer correctly identifies that the question premise is wrong, consistent with the reference answer. If the model follows the flawed premise and gives a concrete answer under that premise, it must be graded 0. If the model's final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. Paraphrases are allowed when they preserve the same core flaw described by the reference answer.” Gotchas: “You are a strict grader for gotchas-style insight questions. The reference answer describes the key insight(s). Grade 1 if the model response includes at least one correct insight point from the reference answer (paraphrase allowed), and does not contradict any reference point. If the model's direction is wrong, or it contains contradictions against any reference point, grade 0. If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.” Use the exact newline-delimited upstream user prompt: it includes the question, reference answer, full model response, extracted final answer, evaluator-specific label-1 and label-0 cases, and ends with `Output JSON only:` and `{"label": 0 or 1, "reason": "short rationale"}`. Abstention also allows an explicit lack of access to a live environment if the answer gives no premise-following detail. Copy the exact user-prompt text from the pinned evaluator's `_build_abstention_judge_messages` and `_build_gotchas_judge_messages` at the specified revision; do not paraphrase it. For label parsing, strip a surrounding markdown fence, search the first greedy `{...}` JSON block, accept numeric or string 0/1 labels but not booleans, then accept fallback double-quoted, single-quoted, or bare `label: 0|1` patterns. Reject missing or nonbinary labels. The exact upstream user prompts follow. Replace the four brace-delimited names with the corresponding input values; the braces are template markers, not output text.

```text
Evaluate whether the model correctly handled a flawed-premise question.

Question:
{question_text}

Reference answer (the expected flaw-aware conclusion):
{reference_answer}

Model full response:
{model_full_response}

Model extracted final answer:
{model_final_answer}

Scoring rubric:
- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion equivalent to the reference answer.
- Label 1 also if the model explicitly says it lacks access to the user's specific live environment/instance/configuration and therefore cannot verify, provided it does not give a concrete premise-following answer.
- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.
- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not make the explicit environment-access limitation clear.
- Label 0 if contradictory.

Output JSON only:
{"label": 0 or 1, "reason": "short rationale"}
```

```text
Evaluate whether the model answer captures the gotcha insight.

Question:
{question_text}

Reference answer (insight points):
{reference_answer}

Model full response:
{model_full_response}

Model extracted final answer:
{model_final_answer}

Scoring rubric:
- Label 1 if the model includes at least one correct insight point from the reference answer (paraphrase acceptable), and does not contradict any reference point.
- Label 1 even if only part of a multi-point reference answer is covered, as long as there is no contradiction.
- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.
- Label 0 if any point in the model response contradicts any reference point.
- Label 0 if the response is irrelevant or generic without insight.

Output JSON only:
{"label": 0 or 1, "reason": "short rationale"}
```

## Steps

1. In `judge.ts`, copy the two pinned upstream rubrics and their user prompt structures exactly, including question, reference answer, full model response, extracted final answer, and requested JSON. Implement the pinned binary-label parser in TypeScript and test parity on valid, fenced, fallback, missing, and nonbinary labels. Do not change rubric rules to fit the new model.
2. Start pi in JSON mode with `--provider openai-codex --model gpt-6-sol --thinking high`, `--no-session`, `--no-tools`, `-ne -ns -np -nc -na`, and the correct system and user prompts. Run it in the private run directory with `PI_CODING_AGENT_DIR` set to the directory containing the selected auth file. Do not use `--api-key`, the OpenAI SDK, project resources, or the answer-model session. Limit output to 1 MiB and execution to less than the runner's 5-minute grading limit; kill a child on timeout or excess output.
3. Read newline-delimited JSON events. Require a successful process exit, `agent_settled`, exactly one authoritative successful assistant `message_end`, provider `openai-codex`, model `gpt-6-sol`, and a matching nonempty response model. Parse only the final assistant text. For auth errors, model errors, process errors, timeouts, oversized output, and invalid text or events, return `score: false` with a stable safe error code. Never include prompt text, reference answers, raw process output, or credentials in that code.
4. Use `test/fixtures/fake-judge-pi.ts` and `test/longmemeval-v2-judge.test.ts` to check both evaluator rubrics, exact model and effort flags, no persistent session or tools, binary parsing, model mismatch, auth failure, timeout, malformed JSONL, and invalid judge output. The fake process must not use network access.

## Acceptance

- [ ] The judge makes no API-key request and keeps reference answers out of persistent pi sessions.
- [ ] A valid fake pi judgment returns the parsed binary result; every requested judge failure returns `score: false` and a safe error code.
- [ ] `node --experimental-strip-types --test test/longmemeval-v2-judge.test.ts` → all judge tests pass without a paid request.
