🤖 # Task 1: Corpus and text helpers

**Depends on:** None

**Goal:** Create the token matcher `text.ts` and the fact corpus `corpus.ts` (24 cases, 10 distractor facts, a validator), with tests.

**Files:**

- Create: `scripts/eval-recall/text.ts`
- Create: `scripts/eval-recall/corpus.ts`
- Create: `test/eval-recall-text.test.ts`
- Create: `test/eval-recall-corpus.test.ts`

**Reuses:** None. No existing file provides this.

**Precondition:** None.

**Site conditions:**

Repository conventions (apply to every file in this task):

- TypeScript, ES modules, Node 22.19 or later. Files run with `node --experimental-strip-types`. There is no build step.
- `npm run check` runs `tsc --noEmit` on `src/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`. The compiler options include `strict` and `erasableSyntaxOnly`. Do not use `enum`, `namespace` or constructor parameter properties. Import local files with the `.ts` extension.
- Tests use `node:test` and `node:assert/strict`. `npm test` runs `node --experimental-strip-types --test test/*.test.ts`.
- Add no dependency. Write no comment unless it states an invariant. Use descriptive names.
- The working tree has uncommitted deletions and edits that are not part of this task (the old LongMemEval-V2 files, `README.md`, `package.json`). Do not restore, stage or revert them.

`text.ts` exports exactly these functions:

```ts
export function normalizeText(text: string): string
export function containsToken(text: string, token: string): boolean
```

- `normalizeText` lowercases the text and replaces the characters U+2018, U+2019 and U+02BC with the plain apostrophe `'`.
- `containsToken` normalizes both arguments. It returns `false` when the normalized token is empty. Otherwise it escapes the regular-expression special characters of the token and tests the text with the pattern `(?<![a-z0-9])TOKEN(?![a-z0-9])`. A token therefore matches only as a whole word: `ses` does not match `uses`, `20` does not match `2024`, and `24` does match `Node 24.1`.

`corpus.ts` exports exactly these names:

```ts
export type CaseType = 'present' | 'absent' | 'superseded' | 'adjacent';
export type FactStage = 'base' | 'update';
export interface Fact { id: string; text: string; stage: FactStage }
export interface EvalCase {
  id: string;
  type: CaseType;
  question: string;
  facts: Fact[];
  expectedKeywords: string[];
  forbiddenKeywords: string[];
}
export interface SeedFact { fact: Fact; kind: 'question' | 'distractor' }
export const CASES: EvalCase[]
export const DISTRACTORS: Fact[]
export function allFacts(): SeedFact[]
export function validateCorpus(cases: readonly EvalCase[], distractors: readonly Fact[]): void
```

`allFacts()` returns, in this order: the `base` facts of `CASES` in array order (kind `question`), then `DISTRACTORS` (kind `distractor`), then the `update` facts of `CASES` in array order (kind `question`). It returns 34 entries. The order guarantees that every `update` fact comes after every `base` fact.

Fact IDs: a `present` or `adjacent` case has one fact with the ID `<case id>-fact` and stage `base`. A `superseded` case has two facts in this array order: `<case id>-base` with stage `base`, then `<case id>-update` with stage `update`. An `absent` case has an empty `facts` array. The distractors have the IDs `distractor-01` to `distractor-10` and stage `base`.

The case array order in `CASES` is: the six `present` cases, the six `superseded` cases, the six `adjacent` cases, the six `absent` cases, each group in the order of the tables below.

Case data. All questions and facts are about the fictional project "Halyard". Copy the text exactly.

`present` cases (one fact each, no forbidden keywords):

| Case id | Question | Fact text | Expected keywords |
|---|---|---|---|
| `present-storage` | Which storage engine did we choose for Halyard? | Halyard stores its data in SQLite because deployment must be one local file. | `sqlite` |
| `present-cache` | Which cache server holds our report queries? | Halyard caches report queries in Valkey with a ninety second expiry. | `valkey` |
| `present-jobs` | What carries our background jobs? | Halyard sends background jobs through NATS JetStream and not through RabbitMQ. | `nats`, `jetstream` |
| `present-ci` | Which service runs our continuous integration? | Halyard continuous integration runs on Buildkite. | `buildkite` |
| `present-format` | Which tool formats our code? | Halyard formats code with Biome and forbids Prettier. | `biome` |
| `present-region` | In which cloud region does production run? | Halyard production runs in the Frankfurt region, eu-central-1. | `frankfurt`, `eu-central-1` |

`superseded` cases (base fact first, then update fact):

| Case id | Question | Base fact text | Update fact text | Expected | Forbidden |
|---|---|---|---|---|---|
| `superseded-deploy` | Which tool deploys Halyard to the cluster? | Halyard deploys to the cluster with Argo CD. | Halyard deploys to the cluster with Flux. | `flux` | `argo` |
| `superseded-email` | Which service sends our transactional email? | Halyard sends transactional email through Postmark. | Halyard sends transactional email through Amazon SES. | `ses` | `postmark` |
| `superseded-runtime` | Which Node version does Halyard run on? | Halyard runs on Node 20. | Halyard runs on Node 24. | `24` | `20` |
| `superseded-logs` | In which format does Halyard write application logs? | Halyard writes application logs as plain text lines. | Halyard writes application logs as JSON lines. | `json` | `plain text` |
| `superseded-release` | On which weekday does Halyard cut release branches? | Halyard cuts release branches every Friday. | Halyard cuts release branches every Tuesday. | `tuesday` | `friday` |
| `superseded-attachments` | Where does Halyard store uploaded attachments? | Halyard stores uploaded attachments in MinIO. | Halyard stores uploaded attachments in Cloudflare R2. | `r2` | `minio` |

`adjacent` cases (one fact each, no expected keywords):

| Case id | Question | Fact text | Forbidden keywords |
|---|---|---|---|
| `adjacent-billing` | Which database does the Halyard billing service use? | The Halyard mobile app keeps local data in Realm. | `realm` |
| `adjacent-dashboard` | Which framework builds the Halyard admin dashboard? | The Halyard documentation site is built with Astro. | `astro` |
| `adjacent-notifier` | What runs the Halyard notification sender? | The Halyard batch importer runs as Kubernetes CronJobs, one CronJob for each tenant. | `cronjob`, `cronjobs` |
| `adjacent-audit` | Which engine stores the Halyard audit log? | The Halyard search index is served by Meilisearch. | `meilisearch` |
| `adjacent-identity` | Which identity provider does Halyard production use? | The Halyard staging environment signs users in with Keycloak. | `keycloak` |
| `adjacent-ios` | Which language is the Halyard iOS client written in? | The Halyard Android client is written in Kotlin. | `kotlin` |

`absent` cases (no facts, no expected keywords):

| Case id | Question | Forbidden keywords |
|---|---|---|
| `absent-payments` | Which payment provider does Halyard use? | `stripe`, `paypal`, `adyen` |
| `absent-errors` | Which tool does Halyard use for error tracking? | `sentry`, `rollbar`, `bugsnag` |
| `absent-signin` | How do Halyard users sign in? | `oauth`, `saml`, `auth0`, `password` |
| `absent-license` | Which open source license does Halyard use? | `mit`, `apache`, `gpl` |
| `absent-language` | Which programming language is the Halyard backend written in? | `golang`, `rust`, `java`, `python`, `typescript` |
| `absent-registrar` | Which registrar owns the Halyard domain? | `godaddy`, `namecheap`, `gandi` |

Distractor facts (stage `base`):

| Fact id | Text |
|---|---|
| `distractor-01` | Halyard's code owners file assigns the infrastructure folder to the platform team. |
| `distractor-02` | Halyard pull requests need two approvals before they merge. |
| `distractor-03` | Halyard uses semantic versioning for its public API releases. |
| `distractor-04` | Halyard holds its weekly planning meeting on Mondays. |
| `distractor-05` | Halyard support tickets get a first reply within one business day. |
| `distractor-06` | The Halyard brand color is deep teal. |
| `distractor-07` | Halyard engineers write commit messages in the imperative mood. |
| `distractor-08` | The Halyard changelog is generated from merged pull request titles. |
| `distractor-09` | Halyard refreshes staging data from anonymized production snapshots. |
| `distractor-10` | The Halyard onboarding guide lives in the docs folder of the repository. |

`validateCorpus` throws an `Error` when a rule fails. The message must contain the text below, with the values filled in. It checks the rules in this order:

1. The case count is 24: `expected 24 cases, got <n>`.
2. Each type has 6 cases: `expected 6 cases of type <type>, got <n>`.
3. Case IDs are unique: `duplicate case id: <id>`.
4. There are at least 10 distractors: `expected at least 10 distractors, got <n>`.
5. Fact IDs are unique over all case facts and all distractors: `duplicate fact id: <id>`.
6. Every distractor has stage `base`: `distractor <id> must have stage base`.
7. Fact structure by type: `present` and `adjacent` have exactly one fact with stage `base`; `absent` has no fact; `superseded` has exactly two facts, one with stage `base` and one with stage `update`. Failure message: `case <id> has a wrong fact structure`.
8. Keyword lists by type: `present` has at least one expected keyword and no forbidden keyword; `superseded` has at least one of each; `absent` and `adjacent` have no expected keyword and at least one forbidden keyword. Failure message: `case <id> has wrong keyword lists`.
9. Every keyword equals `normalizeText(keyword).trim()` and is not empty: `keyword "<k>" of case <id> is not normalized`.
10. No keyword appears in the case's own question (use `containsToken`): `keyword "<k>" of case <id> appears in the question`.
11. Each keyword appears in the fact it belongs to: for `present`, each expected keyword in the fact; for `superseded`, each expected keyword in the `update` fact and each forbidden keyword in the `base` fact; for `adjacent`, each forbidden keyword in the fact. Failure message: `keyword "<k>" of case <id> does not appear in its fact`. For `superseded`, an expected keyword must not appear in the `base` fact and a forbidden keyword must not appear in the `update` fact: `keyword "<k>" of case <id> appears in the wrong fact`.
12. No keyword of a case appears in any fact that does not belong to that case, including all distractors and, for `absent` cases, every fact: `keyword "<k>" of case <id> appears in another fact: <fact id>`.
13. No fact text and no question contains a banned word, matched with `containsToken`: `banned word "<w>" in <id>`, where `<id>` is the fact ID or the case ID. The banned words are: `memory`, `memories`, `remember`, `remembers`, `record`, `records`, `recall`, `password`, `passwords`, `secret`, `secrets`, `token`, `tokens`, `credential`, `credentials`, `api key`, `api keys`. The extension refuses suspected secrets, and the prompts must never name memory.

## Steps

1. Create `scripts/eval-recall/text.ts` as specified above.
2. Create `test/eval-recall-text.test.ts`. It asserts: `normalizeText('It’s FINE')` returns `it's fine`; `containsToken('Amazon SES.', 'ses')` is `true`; `containsToken('The team uses it', 'ses')` is `false`; `containsToken('Node 24.1', '24')` is `true`; `containsToken('in 2024', '20')` is `false`; `containsToken('Route 53 hosts it', 'route 53')` is `true`; `containsToken('a+b', 'a+b')` is `true` (special characters are escaped); `containsToken('anything', '')` is `false`; `containsToken('I don’t know', 'don\'t know')` is `true`.
3. Create `scripts/eval-recall/corpus.ts`: the types, `CASES` and `DISTRACTORS` with the exact data above, `allFacts` and `validateCorpus`. Import `containsToken` and `normalizeText` from `./text.ts`.
4. Create `test/eval-recall-corpus.test.ts` with these tests:
   - `validateCorpus(CASES, DISTRACTORS)` does not throw.
   - `CASES.length` is 24, each type has 6 cases, `DISTRACTORS.length` is 10, and `allFacts().length` is 34.
   - In `allFacts()`, no `base` fact comes after an `update` fact, 24 entries have kind `question` and 10 have kind `distractor`.
   - Negative tests on a `structuredClone` of the data, each with `assert.throws(..., /<message text>/)`: remove one case (`expected 24 cases`); change one case type (`expected 6 cases of type`); copy a case ID (`duplicate case id`); copy a fact ID (`duplicate fact id`); drop a distractor (`expected at least 10 distractors`); add the word `memory` to a distractor text (`banned word "memory"`); add the word `sqlite` to a distractor text (`appears in another fact`); add an expected keyword to a question (`appears in the question`); remove the `update` fact of a `superseded` case (`wrong fact structure`); set an absent case's expected keywords to `['x']` (`wrong keyword lists`).
5. Run `npm run check` and the two test files.

## Acceptance

- [ ] `npm run check` → exits with code 0.
- [ ] `node --experimental-strip-types --test test/eval-recall-text.test.ts test/eval-recall-corpus.test.ts` → all tests pass.
- [ ] `node --experimental-strip-types -e "import('./scripts/eval-recall/corpus.ts').then(m => console.log(m.CASES.length, m.DISTRACTORS.length, m.allFacts().length))"` → prints `24 10 34`.
- [ ] `git status --short src/` → prints nothing.
