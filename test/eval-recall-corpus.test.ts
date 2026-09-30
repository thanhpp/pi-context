import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allFacts,
  CASES,
  DISTRACTORS,
  validateCorpus,
  type CaseType,
  type EvalCase,
  type Fact,
} from '../scripts/eval-recall/corpus.ts';

function cloneCorpus(): { cases: EvalCase[]; distractors: Fact[] } {
  return { cases: structuredClone(CASES), distractors: structuredClone(DISTRACTORS) };
}

function findCase(cases: EvalCase[], type: CaseType): EvalCase {
  const found = cases.find((evalCase) => evalCase.type === type);
  assert.ok(found);
  return found;
}

test('the shipped corpus is valid', () => {
  assert.doesNotThrow(() => validateCorpus(CASES, DISTRACTORS));
});

test('the corpus has the specified sizes', () => {
  assert.equal(CASES.length, 24);
  for (const type of ['present', 'absent', 'superseded', 'adjacent'] as const) {
    assert.equal(CASES.filter((evalCase) => evalCase.type === type).length, 6);
  }
  assert.equal(DISTRACTORS.length, 10);
  assert.equal(allFacts().length, 34);
});

test('allFacts puts every update fact after every base fact', () => {
  const facts = allFacts();
  const firstUpdate = facts.findIndex((entry) => entry.fact.stage === 'update');
  assert.ok(firstUpdate >= 0);
  assert.ok(facts.slice(firstUpdate).every((entry) => entry.fact.stage === 'update'));
  assert.equal(facts.filter((entry) => entry.kind === 'question').length, 24);
  assert.equal(facts.filter((entry) => entry.kind === 'distractor').length, 10);
});

test('validateCorpus rejects a missing case', () => {
  const { cases, distractors } = cloneCorpus();
  cases.pop();
  assert.throws(() => validateCorpus(cases, distractors), /expected 24 cases/);
});

test('validateCorpus rejects a wrong case type count', () => {
  const { cases, distractors } = cloneCorpus();
  findCase(cases, 'present').type = 'absent';
  assert.throws(() => validateCorpus(cases, distractors), /expected 6 cases of type/);
});

test('validateCorpus rejects a duplicate case id', () => {
  const { cases, distractors } = cloneCorpus();
  cases[1]!.id = cases[0]!.id;
  assert.throws(() => validateCorpus(cases, distractors), /duplicate case id/);
});

test('validateCorpus rejects a duplicate fact id', () => {
  const { cases, distractors } = cloneCorpus();
  distractors[1]!.id = distractors[0]!.id;
  assert.throws(() => validateCorpus(cases, distractors), /duplicate fact id/);
});

test('validateCorpus rejects too few distractors', () => {
  const { cases, distractors } = cloneCorpus();
  distractors.pop();
  assert.throws(() => validateCorpus(cases, distractors), /expected at least 10 distractors/);
});

test('validateCorpus rejects a banned word in a distractor', () => {
  const { cases, distractors } = cloneCorpus();
  distractors[0]!.text += ' It is a memory aid.';
  assert.throws(() => validateCorpus(cases, distractors), /banned word "memory"/);
});

test('validateCorpus rejects a keyword that appears in another fact', () => {
  const { cases, distractors } = cloneCorpus();
  distractors[0]!.text += ' It also uses sqlite.';
  assert.throws(() => validateCorpus(cases, distractors), /appears in another fact/);
});

test('validateCorpus rejects an expected keyword in the question', () => {
  const { cases, distractors } = cloneCorpus();
  const evalCase = findCase(cases, 'present');
  evalCase.question += ` Is it ${evalCase.expectedKeywords[0]}?`;
  assert.throws(() => validateCorpus(cases, distractors), /appears in the question/);
});

test('validateCorpus rejects a superseded case without its update fact', () => {
  const { cases, distractors } = cloneCorpus();
  const evalCase = findCase(cases, 'superseded');
  evalCase.facts = evalCase.facts.filter((fact) => fact.stage !== 'update');
  assert.throws(() => validateCorpus(cases, distractors), /wrong fact structure/);
});

test('validateCorpus rejects expected keywords on an absent case', () => {
  const { cases, distractors } = cloneCorpus();
  findCase(cases, 'absent').expectedKeywords = ['x'];
  assert.throws(() => validateCorpus(cases, distractors), /wrong keyword lists/);
});
