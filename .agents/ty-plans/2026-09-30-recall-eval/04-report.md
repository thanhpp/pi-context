🤖 # Task 4: Report formatting

**Depends on:** [Task 1](01-corpus-and-text.md), [Task 3](03-pi-runner.md)

**Goal:** Create `report.ts` with the outcome types and `formatReport`, which prints the hit rates per case type for both arms, the spread over runs, the record rates and the failure counts, with tests.

**Files:**

- Create: `scripts/eval-recall/report.ts`
- Create: `test/eval-recall-report.test.ts`

**Reuses:**

- The type `CaseType` in `scripts/eval-recall/corpus.ts`.
- The types `Arm` and `CallStatus` in `scripts/eval-recall/pi.ts`.

**Precondition:** None.

**Site conditions:**

Repository conventions (apply to every file in this task):

- TypeScript, ES modules, Node 22.19 or later. Files run with `node --experimental-strip-types`. There is no build step.
- `npm run check` runs `tsc --noEmit` on `src/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`. The compiler options include `strict` and `erasableSyntaxOnly`. Do not use `enum`, `namespace` or constructor parameter properties. Import local files with the `.ts` extension.
- Tests use `node:test` and `node:assert/strict`. `npm test` runs `node --experimental-strip-types --test test/*.test.ts`.
- Add no dependency. Write no comment unless it states an invariant. Use descriptive names.
- The working tree has uncommitted deletions and edits that are not part of this task. Do not restore, stage or revert them.

Existing types that this task uses:

```ts
export type CaseType = 'present' | 'absent' | 'superseded' | 'adjacent';
export type Arm = 'extension' | 'control';
export type CallStatus = 'ok' | 'timeout' | 'failed';
```

`report.ts` exports exactly:

```ts
export interface QuestionOutcome {
  runIndex: number;
  arm: Arm;
  caseId: string;
  caseType: CaseType;
  hit: boolean;
  status: CallStatus;
}
export interface SeedOutcome {
  runIndex: number;
  factId: string;
  kind: 'question' | 'distractor';
  recorded: boolean;
  status: CallStatus;
}
export interface ReportInput {
  model: string;
  runs: number;
  questions: readonly QuestionOutcome[];
  seeds: readonly SeedOutcome[];
}
export function formatReport(input: ReportInput): string
```

`runIndex` starts at 1. A question outcome with a status other than `ok` has `hit: false`; `formatReport` counts it as a miss and does not check the status for the hit count.

Required output. `formatReport` returns lines joined with `\n`, with no trailing line feed:

1. `pi-context recall eval`
2. `model: <model>`
3. `runs: <runs>`
4. An empty line.
5. A table. The header row has these cells in this order: `case type`, `extension`, `control`, `difference`, `extension range`, `control range`. Then one row for each of `present`, `superseded`, `absent`, `adjacent` (in this order), then a row named `total`. Each column is as wide as its longest cell plus 2 spaces. The last column is not padded. Trim trailing white space of every line.
6. An empty line.
7. `seed record rate: question facts <x>/<y> (<p>%), distractor facts <x>/<y> (<p>%)`. Over all runs, `<y>` is the number of seed outcomes of that kind and `<x>` is the number with `recorded: true`.
8. `extension answers: <t> timeouts, <f> failures; seed sessions: <t> timeouts, <f> failures`. The first pair counts question outcomes of arm `extension` with status `timeout` and `failed`. The second pair counts all seed outcomes with those statuses.
9. `control answers: <t> timeouts, <f> failures`. It counts question outcomes of arm `control`.

Cell formats:

- Percent `<p>` is `Math.round(100 * x / y)`. If `y` is 0, the cell text is `n/a`.
- The `extension` and `control` cells are `<hits>/<total> (<p>%)`. `hits` is the number of outcomes with `hit: true` for that arm and case type over all runs. `total` is the number of outcomes for that arm and case type. The `total` row uses all case types.
- The `difference` cell is the extension percent minus the control percent, as `+<n> pp` when positive, `-<n> pp` when negative and `0 pp` when zero. The cell is `n/a` when either total is 0. The percents are the rounded values of the two cells.
- The range cells are `<min>%-<max>%`. For each run index that has at least one outcome for that arm and case type, compute the rounded percent of that run. `<min>` and `<max>` are the lowest and highest of these percents. The cell is `n/a` when no run has an outcome.

## Steps

1. Create `scripts/eval-recall/report.ts` with the types, `formatReport` and the format above. Import the types `CaseType`, `Arm` and `CallStatus` with `import type`.
2. Create `test/eval-recall-report.test.ts` with a helper that builds `QuestionOutcome` arrays from a compact description. Write these tests:
   - With 2 runs, every case type with 6 outcomes per run for each arm, arm `extension` always `hit: true` and arm `control` always `hit: false`, the `present` row contains `12/12 (100%)`, `0/12 (0%)`, `+100 pp`, `100%-100%` and `0%-0%`.
   - With arm `extension` `present` outcomes of run 1 all `hit: true` (6 of 6) and run 2 half `hit: true` (3 of 6), the `present` row contains `9/12 (75%)` and the range `50%-100%`.
   - When the control rate is higher than the extension rate, the difference cell has the form `-<n> pp`. When both rates are equal, it is `0 pp`.
   - A case type with no outcomes shows `n/a` in all its cells.
   - Seeds: 3 outcomes of kind `question` with 2 `recorded: true`, and 2 of kind `distractor` with 1 `recorded: true`, give the line `seed record rate: question facts 2/3 (67%), distractor facts 1/2 (50%)`.
   - Counts: one `timeout` and two `failed` question outcomes of arm `extension`, one `failed` question outcome of arm `control`, and one `timeout` seed outcome give the lines `extension answers: 1 timeouts, 2 failures; seed sessions: 1 timeouts, 0 failures` and `control answers: 0 timeouts, 1 failures`.
   - The first three lines equal `pi-context recall eval`, `model: <model>` and `runs: <runs>`. The fourth line is empty. The output does not end with a line feed.
3. Run `npm run check` and the test file.

## Acceptance

- [ ] `npm run check` → exits with code 0.
- [ ] `node --experimental-strip-types --test test/eval-recall-report.test.ts` → all tests pass.
