🤖 # Task 2: Answer scoring

**Depends on:** [Task 1](01-corpus-and-text.md)

**Goal:** Create `score.ts` with `scoreAnswer`, the deterministic scoring rule for the four case types, with tests.

**Files:**

- Create: `scripts/eval-recall/score.ts`
- Create: `test/eval-recall-score.test.ts`

**Reuses:**

- `containsToken(text: string, token: string): boolean` in `scripts/eval-recall/text.ts`. It matches a token only as a whole word, ignoring letter case and typographic apostrophes.
- The type `EvalCase` in `scripts/eval-recall/corpus.ts`.

**Precondition:** None.

**Site conditions:**

Repository conventions (apply to every file in this task):

- TypeScript, ES modules, Node 22.19 or later. Files run with `node --experimental-strip-types`. There is no build step.
- `npm run check` runs `tsc --noEmit` on `src/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`. The compiler options include `strict` and `erasableSyntaxOnly`. Do not use `enum`, `namespace` or constructor parameter properties. Import local files with the `.ts` extension.
- Tests use `node:test` and `node:assert/strict`. `npm test` runs `node --experimental-strip-types --test test/*.test.ts`.
- Add no dependency. Write no comment unless it states an invariant. Use descriptive names.
- The working tree has uncommitted deletions and edits that are not part of this task. Do not restore, stage or revert them.

Existing types that this task uses (from `scripts/eval-recall/corpus.ts`, created by Task 1):

```ts
export type CaseType = 'present' | 'absent' | 'superseded' | 'adjacent';
export interface Fact { id: string; text: string; stage: 'base' | 'update' }
export interface EvalCase {
  id: string;
  type: CaseType;
  question: string;
  facts: Fact[];
  expectedKeywords: string[];
  forbiddenKeywords: string[];
}
```

Scoring rule (required behavior). `scoreAnswer(evalCase, answer)` returns a boolean:

- An empty answer, or an answer that contains only white space, scores `false`.
- If the answer contains any forbidden keyword of the case (`containsToken`), the score is `false`, for every case type.
- Case type `present` or `superseded`: the score is `true` when the answer contains at least one expected keyword.
- Case type `absent` or `adjacent`: the score is `true` when the answer contains at least one phrase of `ABSTENTION_PHRASES`. The expected keywords of these types are empty and are not used.
- Matching ignores letter case and treats the typographic apostrophe as the plain apostrophe. `containsToken` already does both.

`score.ts` exports exactly:

```ts
export const ABSTENTION_PHRASES: readonly string[]
export function scoreAnswer(evalCase: EvalCase, answer: string): boolean
```

`ABSTENTION_PHRASES` contains exactly these strings: `don't know`, `do not know`, `don't have`, `do not have`, `no record`, `not recorded`, `not stored`, `no information`, `cannot find`, `can't find`, `couldn't find`, `could not find`, `didn't find`, `did not find`, `not found`, `unable to find`, `not sure`, `no memory`, `unknown`. The `find` phrases match a model that searched the store and found nothing, for example "I couldn't find any information about that".

## Steps

1. Create `scripts/eval-recall/score.ts` with the two exports and the rule above. Import `containsToken` from `./text.ts` and `type EvalCase` from `./corpus.ts`.
2. Create `test/eval-recall-score.test.ts`. Define four small `EvalCase` literals inside the test file (do not import `CASES`). Use these cases:
   - `present`: expected `['sqlite']`, forbidden `[]`.
   - `superseded`: expected `['flux']`, forbidden `['argo']`.
   - `absent`: expected `[]`, forbidden `['stripe']`.
   - `adjacent`: expected `[]`, forbidden `['realm']`.
3. Write these assertions:
   - `present`: `'We chose SQLite.'` scores `true`; `'We chose Postgres.'` scores `false`; `''` scores `false`.
   - `superseded`: `'Flux deploys it.'` scores `true`; `'Flux now, Argo before.'` scores `false`; `'Argo deploys it.'` scores `false`.
   - `absent`: `'I don’t know.'` (typographic apostrophe) scores `true`; `"I don't know, maybe Stripe."` scores `false`; `'It is Stripe.'` scores `false`; `'The project uses a provider.'` scores `false`.
   - `absent`: `'I couldn’t find any information about the payment provider.'` (typographic apostrophe) scores `true`.
   - `adjacent`: `'I do not know.'` scores `true`; `"I don't know, but the app uses Realm."` scores `false`; `'It uses Realm.'` scores `false`.
   - A `present` answer with only white space (`'   '`) scores `false`.
   - Every phrase in `ABSTENTION_PHRASES` scores `true` for the `absent` case when it is the whole answer.
4. Run `npm run check` and the test file.

## Acceptance

- [ ] `npm run check` → exits with code 0.
- [ ] `node --experimental-strip-types --test test/eval-recall-score.test.ts` → all tests pass.
- [ ] `grep -c "ABSTENTION_PHRASES" scripts/eval-recall/score.ts` → prints a number of 2 or more.
