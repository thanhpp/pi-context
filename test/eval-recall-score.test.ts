import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvalCase } from '../scripts/eval-recall/corpus.ts';
import { ABSTENTION_PHRASES, scoreAnswer, scoreResponse } from '../scripts/eval-recall/score.ts';

function makeCase(
  type: EvalCase['type'],
  expectedKeywords: string[],
  forbiddenKeywords: string[],
): EvalCase {
  return { id: `${type}-case`, type, question: 'Question?', facts: [], expectedKeywords, forbiddenKeywords };
}

const presentCase = makeCase('present', ['sqlite'], []);
const supersededCase = makeCase('superseded', ['flux'], ['argo']);
const absentCase = makeCase('absent', [], ['stripe']);
const adjacentCase = makeCase('adjacent', [], ['realm']);

test('present case needs an expected keyword', () => {
  assert.equal(scoreAnswer(presentCase, 'We chose SQLite.'), true);
  assert.equal(scoreAnswer(presentCase, 'We chose Postgres.'), false);
  assert.equal(scoreAnswer(presentCase, ''), false);
  assert.equal(scoreAnswer(presentCase, '   '), false);
});

test('superseded case rejects an answer that names the old value', () => {
  assert.equal(scoreAnswer(supersededCase, 'Flux deploys it.'), true);
  assert.equal(scoreAnswer(supersededCase, 'Flux now, Argo before.'), false);
  assert.equal(scoreAnswer(supersededCase, 'Argo deploys it.'), false);
});

test('absent case needs an abstention and no forbidden keyword', () => {
  assert.equal(scoreAnswer(absentCase, 'I don’t know.'), true);
  assert.equal(scoreAnswer(absentCase, "I don't know, maybe Stripe."), false);
  assert.equal(scoreAnswer(absentCase, 'It is Stripe.'), false);
  assert.equal(scoreAnswer(absentCase, 'The project uses a provider.'), false);
  assert.equal(scoreAnswer(absentCase, 'I couldn’t find any information about the payment provider.'), true);
});

test('adjacent case needs an abstention and no forbidden keyword', () => {
  assert.equal(scoreAnswer(adjacentCase, 'I do not know.'), true);
  assert.equal(scoreAnswer(adjacentCase, "I don't know, but the app uses Realm."), false);
  assert.equal(scoreAnswer(adjacentCase, 'It uses Realm.'), false);
});

test('answer-v2 separates current answers from historical and adjacent context', () => {
  const current = JSON.stringify({ answer: 'Flux', context: 'Argo CD was used before.' });
  assert.equal(scoreResponse(supersededCase, current, 'answer-v2').hit, true);
  assert.equal(scoreAnswer(supersededCase, current), false);
  const unknown = JSON.stringify({ answer: null, context: 'The mobile app uses Realm. The billing database has no support.' });
  assert.equal(scoreResponse(adjacentCase, unknown, 'answer-v2').hit, true);
  assert.equal(scoreAnswer(adjacentCase, unknown), false);
  assert.equal(scoreResponse(presentCase, JSON.stringify({ answer: 'SQLite', context: '' }), 'answer-v2').reason, 'hit');
});

test('answer-v2 rejects guesses, unsupported abstentions, and forbidden primary answers', () => {
  const score = (evalCase: EvalCase, answer: string | null, context = '') =>
    scoreResponse(evalCase, JSON.stringify({ answer, context }), 'answer-v2');
  assert.equal(score(supersededCase, 'Argo', 'Flux is current.').reason, 'forbidden_keyword');
  assert.equal(score(supersededCase, 'Flux or Argo').reason, 'forbidden_keyword');
  assert.equal(score(supersededCase, null, 'Flux is current.').reason, 'unexpected_abstention');
  assert.equal(score(supersededCase, "I don't know, maybe Flux.").reason, 'unexpected_abstention');
  assert.equal(score(adjacentCase, 'Realm').reason, 'forbidden_keyword');
  assert.equal(score(absentCase, 'PayPal').reason, 'missing_abstention');
  assert.equal(score(absentCase, "I don't know.").reason, 'missing_abstention');
  assert.equal(score(presentCase, 'Postgres').reason, 'missing_keyword');
  assert.equal(score(presentCase, '').reason, 'empty_answer');
  assert.equal(score(absentCase, null, 'I do not know.').reason, 'hit');
});

test('answer-v2 requires the exact JSON response contract', () => {
  for (const answer of ['Flux', '```json\n{"answer":"Flux","context":""}\n```', '{}', 'null', '[]',
    '{"answer":"Flux"}', '{"answer":24,"context":""}', '{"answer":"Flux","context":null}',
    '{"answer":"Flux","context":"","extra":true}']) {
    assert.equal(scoreResponse(supersededCase, answer, 'answer-v2').reason, 'invalid_response', answer);
  }
  assert.equal(scoreResponse(supersededCase, ' ', 'answer-v2').reason, 'empty_answer');
});

test('every abstention phrase scores as the whole answer', () => {
  for (const phrase of ABSTENTION_PHRASES) {
    assert.equal(scoreAnswer(absentCase, phrase), true, phrase);
  }
});
