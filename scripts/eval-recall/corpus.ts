import { containsToken, normalizeText } from './text.ts';

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

function singleFactCase(
  id: string,
  type: 'present' | 'adjacent',
  question: string,
  text: string,
  expectedKeywords: string[],
  forbiddenKeywords: string[],
): EvalCase {
  return {
    id,
    type,
    question,
    facts: [{ id: `${id}-fact`, text, stage: 'base' }],
    expectedKeywords,
    forbiddenKeywords,
  };
}

function supersededCase(
  id: string,
  question: string,
  baseText: string,
  updateText: string,
  expected: string,
  forbidden: string,
): EvalCase {
  return {
    id,
    type: 'superseded',
    question,
    facts: [
      { id: `${id}-base`, text: baseText, stage: 'base' },
      { id: `${id}-update`, text: updateText, stage: 'update' },
    ],
    expectedKeywords: [expected],
    forbiddenKeywords: [forbidden],
  };
}

function absentCase(id: string, question: string, forbiddenKeywords: string[]): EvalCase {
  return { id, type: 'absent', question, facts: [], expectedKeywords: [], forbiddenKeywords };
}

export const CASES: EvalCase[] = [
  singleFactCase(
    'present-storage',
    'present',
    'Which storage engine did we choose for Halyard?',
    'Halyard stores its data in SQLite because deployment must be one local file.',
    ['sqlite'],
    [],
  ),
  singleFactCase(
    'present-cache',
    'present',
    'Which cache server holds our report queries?',
    'Halyard caches report queries in Valkey with a ninety second expiry.',
    ['valkey'],
    [],
  ),
  singleFactCase(
    'present-jobs',
    'present',
    'What carries our background jobs?',
    'Halyard sends background jobs through NATS JetStream and not through RabbitMQ.',
    ['nats', 'jetstream'],
    [],
  ),
  singleFactCase(
    'present-ci',
    'present',
    'Which service runs our continuous integration?',
    'Halyard continuous integration runs on Buildkite.',
    ['buildkite'],
    [],
  ),
  singleFactCase(
    'present-format',
    'present',
    'Which tool formats our code?',
    'Halyard formats code with Biome and forbids Prettier.',
    ['biome'],
    [],
  ),
  singleFactCase(
    'present-region',
    'present',
    'In which cloud region does production run?',
    'Halyard production runs in the Frankfurt region, eu-central-1.',
    ['frankfurt', 'eu-central-1'],
    [],
  ),
  supersededCase(
    'superseded-deploy',
    'Which tool deploys Halyard to the cluster?',
    'Halyard deploys to the cluster with Argo CD.',
    'Halyard deploys to the cluster with Flux.',
    'flux',
    'argo',
  ),
  supersededCase(
    'superseded-email',
    'Which service sends our transactional email?',
    'Halyard sends transactional email through Postmark.',
    'Halyard sends transactional email through Amazon SES.',
    'ses',
    'postmark',
  ),
  supersededCase(
    'superseded-runtime',
    'Which Node version does Halyard run on?',
    'Halyard runs on Node 20.',
    'Halyard runs on Node 24.',
    '24',
    '20',
  ),
  supersededCase(
    'superseded-logs',
    'In which format does Halyard write application logs?',
    'Halyard writes application logs as plain text lines.',
    'Halyard writes application logs as JSON lines.',
    'json',
    'plain text',
  ),
  supersededCase(
    'superseded-release',
    'On which weekday does Halyard cut release branches?',
    'Halyard cuts release branches every Friday.',
    'Halyard cuts release branches every Tuesday.',
    'tuesday',
    'friday',
  ),
  supersededCase(
    'superseded-attachments',
    'Where does Halyard store uploaded attachments?',
    'Halyard stores uploaded attachments in MinIO.',
    'Halyard stores uploaded attachments in Cloudflare R2.',
    'r2',
    'minio',
  ),
  singleFactCase(
    'adjacent-billing',
    'adjacent',
    'Which database does the Halyard billing service use?',
    'The Halyard mobile app keeps local data in Realm.',
    [],
    ['realm'],
  ),
  singleFactCase(
    'adjacent-dashboard',
    'adjacent',
    'Which framework builds the Halyard admin dashboard?',
    'The Halyard documentation site is built with Astro.',
    [],
    ['astro'],
  ),
  singleFactCase(
    'adjacent-notifier',
    'adjacent',
    'What runs the Halyard notification sender?',
    'The Halyard batch importer runs as Kubernetes CronJobs, one CronJob for each tenant.',
    [],
    ['cronjob', 'cronjobs'],
  ),
  singleFactCase(
    'adjacent-audit',
    'adjacent',
    'Which engine stores the Halyard audit log?',
    'The Halyard search index is served by Meilisearch.',
    [],
    ['meilisearch'],
  ),
  singleFactCase(
    'adjacent-identity',
    'adjacent',
    'Which identity provider does Halyard production use?',
    'The Halyard staging environment signs users in with Keycloak.',
    [],
    ['keycloak'],
  ),
  singleFactCase(
    'adjacent-ios',
    'adjacent',
    'Which language is the Halyard iOS client written in?',
    'The Halyard Android client is written in Kotlin.',
    [],
    ['kotlin'],
  ),
  absentCase('absent-payments', 'Which payment provider does Halyard use?', ['stripe', 'paypal', 'adyen']),
  absentCase('absent-errors', 'Which tool does Halyard use for error tracking?', ['sentry', 'rollbar', 'bugsnag']),
  absentCase('absent-signin', 'How do Halyard users sign in?', ['oauth', 'saml', 'auth0', 'password']),
  absentCase('absent-license', 'Which open source license does Halyard use?', ['mit', 'apache', 'gpl']),
  absentCase('absent-language', 'Which programming language is the Halyard backend written in?', [
    'golang',
    'rust',
    'java',
    'python',
    'typescript',
  ]),
  absentCase('absent-registrar', 'Which registrar owns the Halyard domain?', ['godaddy', 'namecheap', 'gandi']),
];

const DISTRACTOR_TEXTS = [
  "Halyard's code owners file assigns the infrastructure folder to the platform team.",
  'Halyard pull requests need two approvals before they merge.',
  'Halyard uses semantic versioning for its public API releases.',
  'Halyard holds its weekly planning meeting on Mondays.',
  'Halyard support tickets get a first reply within one business day.',
  'The Halyard brand color is deep teal.',
  'Halyard engineers write commit messages in the imperative mood.',
  'The Halyard changelog is generated from merged pull request titles.',
  'Halyard refreshes staging data from anonymized production snapshots.',
  'The Halyard onboarding guide lives in the docs folder of the repository.',
];

export const DISTRACTORS: Fact[] = DISTRACTOR_TEXTS.map((text, index) => ({
  id: `distractor-${String(index + 1).padStart(2, '0')}`,
  text,
  stage: 'base',
}));

export function allFacts(): SeedFact[] {
  const caseFacts = CASES.flatMap((evalCase) => evalCase.facts);
  return [
    ...caseFacts.filter((fact) => fact.stage === 'base').map((fact): SeedFact => ({ fact, kind: 'question' })),
    ...DISTRACTORS.map((fact): SeedFact => ({ fact, kind: 'distractor' })),
    ...caseFacts.filter((fact) => fact.stage === 'update').map((fact): SeedFact => ({ fact, kind: 'question' })),
  ];
}

const CASE_TYPES: readonly CaseType[] = ['present', 'superseded', 'adjacent', 'absent'];

const BANNED_WORDS = [
  'memory',
  'memories',
  'remember',
  'remembers',
  'record',
  'records',
  'recall',
  'password',
  'passwords',
  'secret',
  'secrets',
  'token',
  'tokens',
  'credential',
  'credentials',
  'api key',
  'api keys',
];

function hasStructure(evalCase: EvalCase): boolean {
  const stages = evalCase.facts.map((fact) => fact.stage);
  switch (evalCase.type) {
    case 'present':
    case 'adjacent':
      return stages.length === 1 && stages[0] === 'base';
    case 'absent':
      return stages.length === 0;
    case 'superseded':
      return stages.length === 2 && stages.includes('base') && stages.includes('update');
  }
}

function hasKeywordLists(evalCase: EvalCase): boolean {
  const expected = evalCase.expectedKeywords.length;
  const forbidden = evalCase.forbiddenKeywords.length;
  switch (evalCase.type) {
    case 'present':
      return expected >= 1 && forbidden === 0;
    case 'superseded':
      return expected >= 1 && forbidden >= 1;
    case 'absent':
    case 'adjacent':
      return expected === 0 && forbidden >= 1;
  }
}

function keywordsOf(evalCase: EvalCase): string[] {
  return [...evalCase.expectedKeywords, ...evalCase.forbiddenKeywords];
}

export function validateCorpus(cases: readonly EvalCase[], distractors: readonly Fact[]): void {
  if (cases.length !== 24) throw new Error(`expected 24 cases, got ${cases.length}`);

  for (const type of CASE_TYPES) {
    const count = cases.filter((evalCase) => evalCase.type === type).length;
    if (count !== 6) throw new Error(`expected 6 cases of type ${type}, got ${count}`);
  }

  const caseIds = new Set<string>();
  for (const evalCase of cases) {
    if (caseIds.has(evalCase.id)) throw new Error(`duplicate case id: ${evalCase.id}`);
    caseIds.add(evalCase.id);
  }

  if (distractors.length < 10) throw new Error(`expected at least 10 distractors, got ${distractors.length}`);

  const factIds = new Set<string>();
  for (const fact of [...cases.flatMap((evalCase) => evalCase.facts), ...distractors]) {
    if (factIds.has(fact.id)) throw new Error(`duplicate fact id: ${fact.id}`);
    factIds.add(fact.id);
  }

  for (const distractor of distractors) {
    if (distractor.stage !== 'base') throw new Error(`distractor ${distractor.id} must have stage base`);
  }

  for (const evalCase of cases) {
    if (!hasStructure(evalCase)) throw new Error(`case ${evalCase.id} has a wrong fact structure`);
  }

  for (const evalCase of cases) {
    if (!hasKeywordLists(evalCase)) throw new Error(`case ${evalCase.id} has wrong keyword lists`);
  }

  for (const evalCase of cases) {
    for (const keyword of keywordsOf(evalCase)) {
      if (keyword === '' || keyword !== normalizeText(keyword).trim()) {
        throw new Error(`keyword "${keyword}" of case ${evalCase.id} is not normalized`);
      }
    }
  }

  for (const evalCase of cases) {
    for (const keyword of keywordsOf(evalCase)) {
      if (containsToken(evalCase.question, keyword)) {
        throw new Error(`keyword "${keyword}" of case ${evalCase.id} appears in the question`);
      }
    }
  }

  for (const evalCase of cases) {
    const baseFact = evalCase.facts.find((fact) => fact.stage === 'base');
    const updateFact = evalCase.facts.find((fact) => fact.stage === 'update');
    const notInFact = (keyword: string): never => {
      throw new Error(`keyword "${keyword}" of case ${evalCase.id} does not appear in its fact`);
    };
    const inWrongFact = (keyword: string): never => {
      throw new Error(`keyword "${keyword}" of case ${evalCase.id} appears in the wrong fact`);
    };
    if (evalCase.type === 'present') {
      for (const keyword of evalCase.expectedKeywords) {
        if (!containsToken(baseFact?.text ?? '', keyword)) notInFact(keyword);
      }
    } else if (evalCase.type === 'adjacent') {
      for (const keyword of evalCase.forbiddenKeywords) {
        if (!containsToken(baseFact?.text ?? '', keyword)) notInFact(keyword);
      }
    } else if (evalCase.type === 'superseded') {
      for (const keyword of evalCase.expectedKeywords) {
        if (!containsToken(updateFact?.text ?? '', keyword)) notInFact(keyword);
        if (containsToken(baseFact?.text ?? '', keyword)) inWrongFact(keyword);
      }
      for (const keyword of evalCase.forbiddenKeywords) {
        if (!containsToken(baseFact?.text ?? '', keyword)) notInFact(keyword);
        if (containsToken(updateFact?.text ?? '', keyword)) inWrongFact(keyword);
      }
    }
  }

  for (const evalCase of cases) {
    const ownFactIds = new Set(evalCase.facts.map((fact) => fact.id));
    const otherFacts = [...cases.flatMap((other) => other.facts), ...distractors].filter(
      (fact) => !ownFactIds.has(fact.id),
    );
    for (const keyword of keywordsOf(evalCase)) {
      const clash = otherFacts.find((fact) => containsToken(fact.text, keyword));
      if (clash) throw new Error(`keyword "${keyword}" of case ${evalCase.id} appears in another fact: ${clash.id}`);
    }
  }

  const texts = [
    ...cases.flatMap((evalCase) => [
      { id: evalCase.id, text: evalCase.question },
      ...evalCase.facts.map((fact) => ({ id: fact.id, text: fact.text })),
    ]),
    ...distractors.map((fact) => ({ id: fact.id, text: fact.text })),
  ];
  for (const { id, text } of texts) {
    for (const word of BANNED_WORDS) {
      if (containsToken(text, word)) throw new Error(`banned word "${word}" in ${id}`);
    }
  }
}
