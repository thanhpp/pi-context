import type { StoredCallEntry } from './artifacts.ts';
import { countSuccessfulRecords } from './pi.ts';
import { scoreResponse, type ScoreReason } from './score.ts';

export function analyzeCalls(entries: readonly StoredCallEntry[]) {
  const seeds = { attempted: 0, reportedRecorded: 0, observedRecorded: 0, commitsBeforeUnsuccessfulExit: 0 };
  const questions = { attempted: 0, reportedHits: 0, replayedHits: 0, replayed: 0, scoreMismatches: 0 };
  const rejections: Partial<Record<ScoreReason, number>> = {};
  const toolErrors: Record<string, number> = {};
  let missingEvidence = 0;
  for (const entry of entries) {
    const metadata = entry.metadata;
    if (metadata.kind === 'seed') {
      seeds.attempted += 1;
      if (metadata.recorded) seeds.reportedRecorded += 1;
    } else {
      questions.attempted += 1;
      if (metadata.score) questions.reportedHits += 1;
    }
    if (entry.evidence === undefined) {
      missingEvidence += 1;
      continue;
    }
    const evidence = entry.evidence;
    for (const call of evidence.process.toolCalls) {
      if (!call.completed || typeof call.result !== 'object' || call.result === null) continue;
      const details = (call.result as Record<string, unknown>).details;
      if (typeof details !== 'object' || details === null) continue;
      const error = details as Record<string, unknown>;
      if (error.ok !== false || typeof error.code !== 'string' || !/^[A-Z_]{1,64}$/u.test(error.code)) continue;
      toolErrors[error.code] = (toolErrors[error.code] ?? 0) + 1;
    }
    if (metadata.kind === 'seed') {
      if (countSuccessfulRecords(evidence.process.toolCalls) > 0) {
        seeds.observedRecorded += 1;
        if (metadata.status !== 'ok') seeds.commitsBeforeUnsuccessfulExit += 1;
      }
      continue;
    }
    const score = scoreResponse({
      id: metadata.caseId,
      type: metadata.caseType,
      question: metadata.question,
      facts: [],
      expectedKeywords: [...metadata.scoringInputs.expectedKeywords],
      forbiddenKeywords: [...metadata.scoringInputs.forbiddenKeywords],
    }, evidence.answer, metadata.scoringVersion ?? 'strict-v1', metadata.scoringInputs.abstentionPhrases);
    const hit = metadata.status === 'ok' && score.hit;
    const reason = metadata.status === 'ok' ? score.reason : 'call_not_ok';
    questions.replayed += 1;
    if (hit) questions.replayedHits += 1;
    if (hit !== metadata.score) questions.scoreMismatches += 1;
    if (!hit) rejections[reason] = (rejections[reason] ?? 0) + 1;
  }
  return { seeds, questions, rejections, toolErrors, missingEvidence };
}
