🤖

# Subscription Scoring — Requirements

**Intent:** "Change the scoring to use OpenAI subscription with gpt-6-sol/high"

**Understanding:** Route the LongMemEval benchmark's model-based scoring through the OpenAI subscription with `gpt-6-sol` and high reasoning effort, without separate API billing.

## Requirements

- **R1** The benchmark CLI uses the authenticated OpenAI subscription for every model-based scoring decision with model `gpt-6-sol` and high reasoning effort.
- **R2** The benchmark CLI keeps the existing deterministic evaluation rules local and unchanged.
- **R3** If subscription authentication, model access, transport, timeout, or judge output fails after an answer exists, the scorer records that model-based case as incorrect and continues the run.
- **R4** The benchmark CLI keeps its command interface and score output format compatible with the existing benchmark.
- **R5** The change uses installed pi tooling without a new dependency or a separate OpenAI API key.
- **R6** Automated tests cover successful subscription judging, failed judging, and missing shared authentication; a dry run checks judge model visibility without a paid request.
- **R7** If shared pi authentication is missing before answer generation, the benchmark records both modes of every unanswered case as incorrect and reports the run as incomplete; other answer failures retain the current incomplete behavior.
- **R8** The report keeps the API-rate judge cost estimate as a comparison and identifies it as an estimate, not a subscription charge.
- **R9** TypeScript semantic scoring preserves the pinned upstream abstention and gotchas rubrics, binary judgment parsing, and UNKNOWN handling while changing the judge transport and model.

## Expected Behaviors

| Situation | Expected result |
|-----------|-----------------|
| A semantic case has subscription access and the judge returns a valid decision. | The case receives the model-based decision from `gpt-6-sol` at high reasoning effort. |
| A deterministic case needs no semantic judgment. | The current local rule scores the case without a model call. |
| A semantic case is judged by the TypeScript runner. | The scoring rubric and binary result agree with the pinned upstream evaluator. |
| Authentication, model access, transport, timeout, or judge output fails for one semantic case after an answer exists. | The case is incorrect; the benchmark continues to other cases. |
| Shared pi authentication is missing before answer generation. | Both modes for every unanswered case are incorrect; the run remains incomplete. |
| Another answer-generation failure occurs. | The run remains incomplete under the existing behavior. |
| An operator runs a benchmark dry run. | The run checks that the judge model is visible without making a paid request. |
| A report shows judge costs. | The existing API-rate estimate remains and is identified as a comparison, not a subscription charge. |

## Constraints

- Preserve the benchmark CLI and score output format.
- Use installed pi tooling; add no dependency or separate OpenAI API key.
- Keep the benchmark answer model, dataset, evaluation rules, and previous results unchanged.

## Non-goals

- Changing the model that answers benchmark questions is excluded; this request changes scoring only.
- Changing the dataset or evaluation rules is excluded; existing deterministic rules remain local.
- Migrating or rescoring existing result files is excluded; only new benchmark scoring uses the new judge.
- Supporting direct standalone Python scoring as a subscription entry point is excluded; the benchmark CLI is the caller.

## Done Criteria

- Automated tests cover a valid subscription judgment, each requested judge-failure class, and missing shared authentication.
- A benchmark dry run checks judge model visibility without a paid request.
- The CLI and score output format stay compatible; the report labels the judge cost estimate as a comparison.

## Decision Log

| # | Question | User's answer | Effect |
|---|----------|---------------|--------|
| 1 | Why change the scoring judge? | Use subscription | R1 and R5: avoid separate API billing. |
| 2 | What does `gpt-6-sol/high` mean? | Model + effort | R1: model `gpt-6-sol`, high reasoning effort. |
| 3 | Which scoring path must use the subscription? | All scoring | R1: all model-based judgments; clarified by question 5. |
| 4 | What happens when authentication or model access is unavailable? | Mark incorrect | R3: fail the affected case, not the entire run. |
| 5 | Should deterministic cases call the model? | Keep rules | R2: deterministic cases stay local. |
| 6 | Which caller gets the new behavior? | Benchmark CLI | R1 and non-goal: no direct Python subscription entry point. |
| 7 | What compatibility and dependency limit applies? | Keep outputs | R4 and R5: preserve CLI and output, add no dependency. |
| 8 | What shows completion? | Tests + dry run | R6 and Done Criteria. |
| 9 | Which judge failures should mark the case incorrect? | All judge failures | R3: include auth, model, transport, timeout, invalid output. |
| 10 | What work is outside scope? | No run model changes | Non-goals: leave benchmark answer model, dataset, rules, and prior results unchanged. |
| 11 | What if pi authentication is missing before answer generation? | Incorrect cases | R7: both unanswered modes receive incorrect scores. |
| 12 | How should judge cost appear with subscription usage? | Keep API estimate | R8: retain the estimate and label it as a comparison. |
| 13 | Should synthetic incorrect scores count as a complete run? | Incomplete run | R7: keep overall status incomplete. |
| 14 | What happens for other answer-generation failures? | Keep incomplete | R7: retain the existing incomplete behavior. |
| 15 | Which architecture should implement subscription judging? | TypeScript judge | R9: implement the judge in the TypeScript runner and keep the upstream scoring rules. |
