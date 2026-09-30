import type { EvalCase } from './corpus.ts';
import { containsToken } from './text.ts';

export const ABSTENTION_PHRASES: readonly string[] = [
  "don't know",
  'do not know',
  "don't have",
  'do not have',
  'no record',
  'not recorded',
  'not stored',
  'no information',
  'cannot find',
  "can't find",
  "couldn't find",
  'could not find',
  "didn't find",
  'did not find',
  'not found',
  'unable to find',
  'not sure',
  'no memory',
  'unknown',
];

export const SCORING_VERSIONS = ['strict-v1', 'answer-v2'] as const;
export type ScoringVersion = (typeof SCORING_VERSIONS)[number];
export const DEFAULT_SCORING_VERSION: ScoringVersion = 'answer-v2';
export type ScoreReason = 'hit' | 'empty_answer' | 'invalid_response' | 'forbidden_keyword'
  | 'missing_keyword' | 'missing_abstention' | 'unexpected_abstention' | 'call_not_ok';
export interface AnswerScore {
  hit: boolean;
  reason: ScoreReason;
  answer: string | null;
  context: string;
}

export function scoreResponse(
  evalCase: EvalCase,
  text: string,
  version: ScoringVersion,
  abstentionPhrases: readonly string[] = ABSTENTION_PHRASES,
): AnswerScore {
  const result = (reason: ScoreReason, answer: string | null, context = ''): AnswerScore => ({
    hit: reason === 'hit', reason, answer, context,
  });
  if (text.trim() === '') return result('empty_answer', '');
  if (version === 'strict-v1') {
    if (evalCase.forbiddenKeywords.some(keyword => containsToken(text, keyword))) {
      return result('forbidden_keyword', text);
    }
    const expectsKeyword = evalCase.type === 'present' || evalCase.type === 'superseded';
    const accepted = expectsKeyword ? evalCase.expectedKeywords : abstentionPhrases;
    return result(accepted.some(phrase => containsToken(text, phrase))
      ? 'hit' : expectsKeyword ? 'missing_keyword' : 'missing_abstention', text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result('invalid_response', null);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result('invalid_response', null);
  const response = parsed as Record<string, unknown>;
  if (Object.keys(response).length !== 2 || !Object.hasOwn(response, 'answer') || !Object.hasOwn(response, 'context')
    || (response.answer !== null && typeof response.answer !== 'string') || typeof response.context !== 'string') {
    return result('invalid_response', null);
  }
  const answer = response.answer as string | null;
  const context = response.context;
  const expectsKeyword = evalCase.type === 'present' || evalCase.type === 'superseded';
  if (answer === null) return result(expectsKeyword ? 'unexpected_abstention' : 'hit', answer, context);
  if (answer.trim() === '') return result('empty_answer', answer, context);
  if (evalCase.forbiddenKeywords.some(keyword => containsToken(answer, keyword))) {
    return result('forbidden_keyword', answer, context);
  }
  if (!expectsKeyword) return result('missing_abstention', answer, context);
  if (abstentionPhrases.some(phrase => containsToken(answer, phrase))) {
    return result('unexpected_abstention', answer, context);
  }
  return result(evalCase.expectedKeywords.some(keyword => containsToken(answer, keyword))
    ? 'hit' : 'missing_keyword', answer, context);
}

export function scoreAnswer(evalCase: EvalCase, answer: string): boolean {
  return scoreResponse(evalCase, answer, 'strict-v1').hit;
}
