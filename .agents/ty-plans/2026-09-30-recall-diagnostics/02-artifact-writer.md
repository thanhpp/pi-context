# Task 2: Artifact Writer

**Depends on:** [Task 1](01-call-evidence.md)

**Goal:** Create unique artifact folders with a bounded call log, status manifest, and incomplete-line reader.

**Files:**

- Create: `scripts/eval-recall/artifacts.ts`
- Create: `test/eval-recall-artifacts.test.ts`

**Reuses:** `PiCallEvidence` in `scripts/eval-recall/pi.ts` supplies process and correlated `pi_context` evidence.

**Precondition:** Task 1 exports `PiCallEvidence` and `ToolCallEvidence` from `scripts/eval-recall/pi.ts`.

**Site conditions:** Use Node built-ins only. The default root is `<packageRoot>/.benchmarks/recall`. The caller supplies the selected root. The writer creates one UUID child under that root. Each child must contain `manifest.json` and append-only `calls.jsonl`. Append one JSONL line for each completed process outcome. A failed or timed-out call still has an outcome. Each serialized entry must be at most 16 MiB in UTF-8, including its newline.

An interrupted process can leave an incomplete final line. The reader must not return that line as a valid entry. After a call-log append failure, the writer must not attempt later appends to that file.

Export these types and signatures from `scripts/eval-recall/artifacts.ts`:

```ts
export interface SeedCallMetadata {
  kind: 'seed';
  runIndex: number;
  factId: string;
  factStage: FactStage;
  factText: string;
  factKind: 'question' | 'distractor';
  status: CallStatus;
  recorded: boolean;
  recordCalls: number;
}

export interface QuestionCallMetadata {
  kind: 'question';
  runIndex: number;
  arm: Arm;
  caseId: string;
  caseType: CaseType;
  question: string;
  status: CallStatus;
  score: boolean;
  scoringInputs: {
    expectedKeywords: readonly string[];
    forbiddenKeywords: readonly string[];
    abstentionPhrases: readonly string[];
  };
}

export type CallMetadata = SeedCallMetadata | QuestionCallMetadata;

export interface CallEvidence {
  answer: string;
  process: PiCallEvidence;
}

export interface CallEntry {
  metadata: CallMetadata;
  evidence: CallEvidence;
}

export interface StoredCallEntry {
  metadata: CallMetadata;
  evidence?: CallEvidence;
  evidenceOmitted: boolean;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  id: string;
  status: 'running' | 'complete' | 'incomplete' | 'write_failed';
  model: string;
  runs: number;
  expectedCalls: number;
  startedAt: string;
  completedAt?: string;
}

export interface AppendCallResult {
  appended: boolean;
  evidenceOmitted: boolean;
  warning?: string;
}

export interface ArtifactWriter {
  directory: string;
  appendCall(entry: CallEntry): Promise<AppendCallResult>;
  finish(status: 'complete' | 'incomplete'): Promise<void>;
}

export function createArtifactWriter(
  root: string,
  metadata: { model: string; runs: number; expectedCalls: number },
): Promise<ArtifactWriter>;

export function parseCallsJsonl(text: string): {
  entries: StoredCallEntry[];
  invalidLines: number;
  incompleteFinalLine: boolean;
};
```

Import `FactStage` and `CaseType` from `scripts/eval-recall/corpus.ts`. Import `Arm`, `CallStatus`, and `PiCallEvidence` from `scripts/eval-recall/pi.ts`.

The writer must create a UUID folder and write an initial `running` manifest. It must finish with `complete`, `incomplete`, or `write_failed`. An interrupt can leave a valid `running` manifest. Treat that status as unfinished. The manifest must not contain environment or login data.

Serialize the full entry first. Measure `Buffer.byteLength(serialized + '\n', 'utf8')`. If the entry is too large, keep the same complete metadata. Omit the full `evidence` field and set `evidenceOmitted: true`. Return a warning. If metadata alone cannot fit, do not write an oversized line. Return `appended: false` and a warning.

When a filesystem append fails, disable later appends. Return one warning for the first failure. Return no repeated warning for later disabled calls. `finish` must still try to write a `write_failed` manifest after an append error.

`parseCallsJsonl` must return only newline-terminated JSON object entries. Each returned entry must have valid `metadata` and a boolean `evidenceOmitted` field. Count malformed complete lines in `invalidLines`. Set `incompleteFinalLine: true` and exclude the last fragment when non-empty input has no final newline. Exclude the fragment even if it parses as JSON. Accept CRLF line endings.

## Steps

1. Create `scripts/eval-recall/artifacts.ts` with the exported contracts above.
2. Use `node:crypto` for UUIDs. Use `node:fs/promises` for files and directories.
3. Write the initial manifest before returning the writer.
4. Keep each completed artifact folder to the manifest and call log.
5. Implement the 16 MiB append limit. Preserve metadata when evidence is omitted.
6. Disable appends after the first call-log append error.
7. Implement `finish` for complete, incomplete, and write-failed evaluations.
8. Implement `parseCallsJsonl` to reject malformed lines and exclude an unterminated fragment.
9. Create `test/eval-recall-artifacts.test.ts` with `mkdtemp` roots.
10. Remove each temporary root after its test.
11. Test UUID separation, manifest states, and normal append.
12. Test the 16 MiB boundary, omission warning, and append-failure disabling.
13. Test CRLF, malformed lines, and an unterminated JSON fragment.

## Acceptance

- [ ] A normal writer creates one UUID folder with `manifest.json` and `calls.jsonl` under its supplied temporary root.
- [ ] Every written line is at most 16 MiB, including its newline. Oversized evidence is omitted with metadata retained and a warning.
- [ ] An append failure disables later appends. The writer can still try a `write_failed` manifest.
- [ ] The reader excludes an incomplete final line and reports malformed complete lines.
- [ ] `node --experimental-strip-types --test test/eval-recall-artifacts.test.ts` passes.
