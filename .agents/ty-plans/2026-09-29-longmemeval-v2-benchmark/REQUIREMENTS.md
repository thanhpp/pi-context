🤖
# LongMemEval-V2 benchmark for pi-context — Requirements

**Intent:** "To setup and run the pi-context benchmark using [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) 1. Check to see if it is suitable for testing the pi-context plugin 2. Consider the cost aspect 3. The setup guideline should be run over and over through the improvement process"

**Understanding:** Assess LongMemEval-V2 as a secondary memory proxy and plan a reusable local Pi-session runner and setup guide for comparison across plugin revisions.

## Requirements

- **R1** Document source-backed suitability limits before any paid run: LongMemEval-V2 is a secondary retrieval proxy, not a direct coding-agent test; stop if even this proxy cannot run fairly.
- **R2** Provide a local CLI that ingests each small-tier domain history once through Pi memory sessions, then runs matched fresh plugin-on and question-only plugin-off sessions; do not share memory across run/domain fixtures.
- **R3** Use pinned official LongMemEval-V2 data and reusable official grading rules where compatible; label all Luna/Sol Pi results as adapted, non-official scores.
- **R4** Pin a pilot with fixed IDs across eligible text-only small-tier categories and provide a separate full command for all eligible text-only small-tier cases; count and disclose exclusions from the 451 official questions.
- **R5** Let the operator select a configured OpenAI Luna or Sol model for a run; use that same resolved model and settings in both modes.
- **R6** Show a best-effort per-run model-cost estimate before paid calls, label missing USD rates unknown, and require an explicit execution flag for all paid calls without a spend cap.
- **R7** Report plugin-on and question-only plugin-off scores and case outcomes, measured token use, and answer-plus-grading costs; label missing or estimated USD costs and separate plugin-on ingestion cost.
- **R8** Save versioned case reports with configuration, dataset version, and model identity; record the plugin Git revision when it exists, or an explicit source fingerprint when the repository has no commit.
- **R9** On missing data, authentication, model, or grading failure, save valid completed stages, report the failed case, exit nonzero, and resume only uncompleted safe stages; block ambiguous partial writes and incomplete scores.
- **R10** Check the offline setup with automated tests, then complete one operator-approved paid pilot and save adapted scores and costs if the setup checks pass.
- **R11** Keep the existing project-memory demonstration as a separate product check; never use the LongMemEval-V2 score alone as a release gate.

## Expected Behaviors

| Situation | Expected result |
|-----------|-----------------|
| Operator checks setup without the execution flag | Show dataset and model checks and estimated cost; make no paid model calls. |
| Operator runs a pinned pilot with the execution flag | Run matched independent Pi sessions for each case and mode; reuse compatible official grading; write a non-official versioned report. |
| Operator selects full mode | Use all eligible small-tier questions without question images; count exclusions and show a separate estimate and approval flag. |
| Upstream leaderboard requires a fixed reader or its native memory API | Explain the mismatch; adapt the Pi path as a secondary proxy and mark all scores non-official. |
| Data, authentication, answer, or grading fails after completed cases | Save a checkpoint, exit nonzero, and resume only missing or invalid work. |
| User compares two plugin revisions | Reports show the same case IDs, model, settings, dataset version, outcome, cost labels, and Git revision or source fingerprint. |

## Constraints

- Run through real Pi sessions, not only calls to memory internals.
- Run locally through a Pi-driven CLI. Do not add CI automation.
- Support configured OpenAI Luna and Sol as operator choices; one model per run.
- Use official LongMemEval-V2 data where available and reuse compatible grading without claiming official leaderboard equivalence.
- This skill produces only a plan folder. A later executor builds the local runner and setup guide.
- Estimate spending when USD prices exist, report unknown prices explicitly, and do not impose a fixed USD limit; paid runs require an explicit execution flag.
- Use accessibility and action text. Exclude question-image cases from scored runs; report this omission and the number excluded.
- Do not make paid model calls while preparing this plan.

## Non-goals

- CI or scheduled execution; the first workflow is local.
- Redesigning pi-context memory behavior to improve benchmark scores; the task measures current behavior.
- Official LongMemEval-V2 leaderboard submission or claims of comparable leaderboard scores; the Pi reader and memory contract differ.
- Treating V2 as the only check of coding-agent project memory; retain the existing project-memory demo as a separate check.

## Done Criteria

- The user can use documented local commands repeatedly without changing the instructions between plugin revisions.
- Automated offline checks pass, and the suitability decision has source-backed evidence.
- After an operator approves paid calls, one pinned pilot produces matched case outcomes, adapted scores, costs, and a revision-marked report.
- A failed case can resume without rerunning completed valid cases or mislabeling partial scores.

## Decision Log

| # | Question | User's answer | Effect |
|---|----------|---------------|--------|
| 1 | Who runs the benchmark, and what does the plan deliver? | "Local CLI with pi harnessing" | R2 sets a local Pi runner. |
| 2 | Which cases run first? | "Pilot then full (Recommended)" | R4 provides separate pilot and full modes. |
| 3 | What model-spend limit applies per run? | "Estimate only" | R6 shows an estimate without a hard cap. |
| 4 | What result shows that setup is complete? | "Scores and costs (Recommended)" | R7 and R10 require scores and costs. |
| 5 | How should the runner test memory? | "Real Pi sessions (Recommended)" | R2 uses separate actual Pi sessions. |
| 6 | How should the runner treat the original scoring protocol? | "Official first (Recommended)" | R3 reuses official grading rules where compatible; later suitability evidence requires non-official score labels. |
| 7 | What happens on data, authentication, model, or scoring failures? | "Stop with checkpoint (Recommended)" | R9 requires a resumable checkpoint. |
| 8 | Which work is excluded? | "No CI (Recommended), No plugin redesign" | Both are non-goals. |
| 9 | How should matched runs select a model? | "Use OpenAI models. Target Luna and Sol" | R5 limits the model choices. |
| 10 | What history remains for improvement comparisons? | "Versioned reports (Recommended)" | R8 retains per-case run metadata. |
| 11 | What must precede paid calls? | "Explicit run flag (Recommended)" | R6 defaults to a non-paying estimate. |
| 12 | Which run proves the setup works? | "Approved pilot (Recommended)" | R10 requires an approved paid pilot when suitable. |
| 13 | How do Luna and Sol participate? | "Pick per run" | R5 uses one selected model per run. |
| 14 | What if V2 cannot fairly measure project memory? | "Stop and report (Recommended)" | If the secondary proxy cannot be run fairly, stop before paid evaluation; R1 records limits. |
| 15 | How should the pilot select cases? | "Fixed diverse set (Recommended)" | R4 pins representative IDs. |
| 16 | Do the first draft requirements match the user's intent? | "You learn about the pi-context plugin and the bechmark, see if it fits. Then write a setup plan" | Reframed the deliverable as a plan, not implementation. |
| 17 | Given the upstream reader and domain mismatch, what suitability conclusion applies? | "Secondary proxy (Recommended)" | R1, R3, and R11 permit adapted scores with explicit limits and a separate product check. |
| 18 | What should the setup plan direct a later executor to produce? | "Runner and guide (Recommended)" | R2, R8, and R10 plan a reusable harness and guide; this session writes no runner. |
| 19 | Which full tier should the first repeatable setup run? | "All small cases (Recommended)" | R4 uses the small tier; a text-only restriction needs confirmation. |
| 20 | How should screenshots be treated? | "Text-only subset" | Exclude question-image cases and disclose lost coverage. |
| 21 | Which plugin-off control tests cross-session memory? | "Question-only (Recommended)" | R7 compares with a question-only control and separates ingestion costs. |
| 22 | What happens when a model or judge has no USD price? | "Unknown allowed" | R6 and R7 allow unknown USD and record measured tokens. |
| 23 | Does full mode include all 451 cases or only eligible text-only cases? | "Eligible small set (Recommended)" | R4 defines full mode as the eligible text-only small tier and requires excluded counts. |
| 24 | Which architecture should the setup plan use? | "Pi CLI bridge (Recommended)" | Reuse the existing two-session JSONL subprocess pattern; score through a separate upstream Python bridge. |
