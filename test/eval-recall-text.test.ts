import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsToken, normalizeText } from '../scripts/eval-recall/text.ts';

test('normalizeText lowercases and straightens apostrophes', () => {
  assert.equal(normalizeText('It’s FINE'), "it's fine");
});

test('containsToken matches whole words only', () => {
  assert.equal(containsToken('Amazon SES.', 'ses'), true);
  assert.equal(containsToken('The team uses it', 'ses'), false);
  assert.equal(containsToken('Node 24.1', '24'), true);
  assert.equal(containsToken('in 2024', '20'), false);
  assert.equal(containsToken('Route 53 hosts it', 'route 53'), true);
});

test('containsToken escapes special characters', () => {
  assert.equal(containsToken('a+b', 'a+b'), true);
});

test('containsToken rejects an empty token', () => {
  assert.equal(containsToken('anything', ''), false);
});

test('containsToken treats typographic apostrophes as plain', () => {
  assert.equal(containsToken('I don’t know', "don't know"), true);
});
