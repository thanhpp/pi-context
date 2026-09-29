import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPiContextExtension } from '../src/extension.ts';
import { createEccOptions, ecc } from '../src/ecc.ts';
import { loadConfig } from '../src/config.ts';
import { resolveProject } from '../src/project.ts';
import { openMemoryStore } from '../src/store.ts';
import type { ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent';
import { createFakePi } from './fixtures/fake-pi.ts';
import type { FakePiHarness } from './fixtures/fake-pi.ts';

const PROJECT_LIMIT = 10_485_760;
const PAST_EXPIRY = '2000-01-01T00:00:00.000Z';
const SESSION_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;
const ECC_FIELDS = [
  'schema', 'id', 'title', 'kind', 'scope', 'trust', 'status', 'sourceHarness',
  'targetHarnesses', 'tags', 'links', 'createdAt', 'updatedAt', 'body',
];

type Envelope = {
  ok: boolean;
  action: string;
  code?: string;
  message?: string;
  data?: any;
};

type ProjectEntry = {
  root: string;
  maxBytes?: number;
  cleanupMode?: 'auto' | 'ask';
  enabled?: boolean;
};

type FakeTrace = {
  confirmations: Array<{ title: string; message: string; options?: ExtensionUIDialogOptions }>;
  toolTexts: string[];
};

function withTemp(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-context-integration-'));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function git(args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/iu.test(key)) delete env[key];
  }
  const result = spawnSync('git', args, { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initializeGit(root: string): void {
  mkdirSync(root, { recursive: true });
  git(['-C', root, 'init', '-q']);
}

function writeConfig(agentDir: string, projects: ProjectEntry[]): void {
  writeFileSync(join(agentDir, 'pi-context.json'), JSON.stringify({
    version: 1,
    defaults: { maxBytes: PROJECT_LIMIT, cleanupMode: 'auto' },
    projects,
  }), 'utf8');
}

function makeHarness(
  cwd: string,
  sessionId: string,
  options: {
    mode?: 'tui' | 'rpc' | 'json' | 'print';
    confirm?: (title: string, message: string, options?: ExtensionUIDialogOptions) => Promise<boolean>;
    openStore?: typeof openMemoryStore;
  } = {},
): FakePiHarness {
  const harness = createFakePi({
    cwd,
    mode: options.mode ?? 'print',
    sessionId,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
  createPiContextExtension(options.openStore ?? openMemoryStore)(harness.api);
  return harness;
}

function trace(harness: FakePiHarness): FakeTrace {
  return (harness.api as unknown as { __testTrace: FakeTrace }).__testTrace;
}

function envelope(value: unknown): Envelope {
  assert.ok(typeof value === 'object' && value !== null, 'tool result must be an object');
  return value as Envelope;
}

function success(value: unknown): Envelope & { ok: true; data: any } {
  const result = envelope(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Envelope & { ok: true; data: any };
}

function failure(value: unknown, code: string): Envelope & { ok: false } {
  const result = envelope(value);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, code, JSON.stringify(result));
  return result as Envelope & { ok: false };
}

function recordDraft(
  title: string,
  body: string,
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title,
    body,
    kind: 'context',
    category: 'structure',
    ...values,
  };
}

function memoryId(value: unknown): string {
  const id = success(value).data.value.id;
  assert.equal(typeof id, 'string');
  return id as string;
}

function cleanupProposal(plan: any, obsoleteIds: string[], consolidations: unknown[] = []) {
  return {
    revision: plan.revision,
    obsoleteIds,
    consolidations,
  };
}

test('the real extension records and shares project memory, enforces quotas, and handles cleanup states', async () => {
  await withTemp(async directory => {
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(directory, 'agent');
    const seedRepo = join(directory, 'seed');
    const remoteRepo = join(directory, 'origin.git');
    const mainRepo = join(directory, 'main');
    const worktree = join(directory, 'worktree');
    const clone = join(directory, 'clone');
    const quotaRepo = join(directory, 'quota-repo');
    const approvalRepo = join(directory, 'approval-repo');
    const configuredRoot = join(directory, 'configured-non-git');
    const unconfiguredRoot = join(directory, 'unconfigured-non-git');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(configuredRoot, { recursive: true });
    mkdirSync(unconfiguredRoot, { recursive: true });

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;

      initializeGit(seedRepo);
      writeFileSync(join(seedRepo, 'seed.txt'), 'Synthetic source for local Git fixtures.\n', 'utf8');
      git(['-C', seedRepo, 'add', 'seed.txt']);
      git([
        '-C', seedRepo,
        '-c', 'user.name=Pi Context Test',
        '-c', 'user.email=pi-context-test@example.invalid',
        'commit', '--quiet', '-m', 'Create local integration fixture',
      ]);
      git(['clone', '--quiet', '--bare', seedRepo, remoteRepo]);
      git(['clone', '--quiet', remoteRepo, mainRepo]);
      git(['-C', mainRepo, 'worktree', 'add', '--quiet', '-b', 'integration-worktree', worktree, 'HEAD']);
      git(['clone', '--quiet', remoteRepo, clone]);
      initializeGit(quotaRepo);
      initializeGit(approvalRepo);

      const sameRemoteUrl = git(['-C', mainRepo, 'remote', 'get-url', 'origin']);
      assert.equal(git(['-C', clone, 'remote', 'get-url', 'origin']), sameRemoteUrl);
      assert.notEqual(
        git(['-C', mainRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(['-C', clone, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
      );
      assert.equal(
        git(['-C', mainRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
      );

      writeConfig(agentDir, [
        { root: quotaRepo, maxBytes: 64 * 1024 },
        { root: approvalRepo, cleanupMode: 'ask' },
        { root: configuredRoot },
      ]);

      const first = makeHarness(mainRepo, 'integration-first-session');
      await first.startSession();
      const ordinaryPrompt = 'Review the layout of this offline issue tracker and identify its next implementation step.';
      const firstPromptOptions = await first.beforeAgentStart(ordinaryPrompt);
      const injectedSkill = firstPromptOptions.sections.pi_context ?? '';
      const skillSource = readFileSync(new URL('../skills/pi-context/SKILL.md', import.meta.url), 'utf8');
      const skillBody = skillSource.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim();
      assert.ok(skillBody.length > 0);
      assert.ok(injectedSkill.includes(skillBody), 'the real bundled skill body must be injected');
      assert.match(injectedSkill, /Decide when memory can help/u);
      assert.doesNotMatch(ordinaryPrompt, /memory|remember|pi_context/iu);

      const structureId = memoryId(await first.callTool({
        action: 'record',
        record: recordDraft(
          'Issue tracker structure',
          'The project keeps application code in src and generated state outside the checkout. Shared integration marker.',
          { pinned: true, tags: ['layout'] },
        ),
      }));
      const sessionId = memoryId(await first.callTool({
        action: 'record',
        record: recordDraft(
          'Issue tracker session result',
          'The dependency review passed. The next task is input validation. Shared integration marker.',
          { kind: 'handoff', category: 'session' },
        ),
      }));
      const decisionId = memoryId(await first.callTool({
        action: 'record',
        record: recordDraft(
          'Issue tracker database decision',
          'Choose SQLite rather than PostgreSQL because deployment needs one local file and no database server. Shared integration marker.',
          { kind: 'decision', category: 'decision' },
        ),
      }));

      const mainResolution = await resolveProject(mainRepo, agentDir, await loadConfig(agentDir));
      assert.equal(mainResolution.enabled, true);
      if (!mainResolution.enabled) throw new Error('The main Git fixture did not resolve.');
      const mainStatus = success(await first.callTool({ action: 'status' }));
      assert.equal(mainStatus.data.projectId, mainResolution.project.id);
      const mainStore = openMemoryStore(mainResolution.project, mainResolution.policy);
      const snapshot = await mainStore.withSnapshot(value => value);
      assert.ok(snapshot, 'the records must exist in the actual temporary store');
      const eccScan = ecc.readMemoryFiles(createEccOptions(snapshot.baseDir));
      assert.equal(eccScan.invalidFileCount, 0);
      const ids = [structureId, sessionId, decisionId];
      for (const id of ids) {
        const item = eccScan.entries.find(entry => entry.memory.id === id);
        assert.ok(item, `missing ECC record ${id}`);
        const category = item.memory.kind;
        const filePath = join(snapshot.baseDir, 'project', `${category}s`, `${id}.md`);
        const document = readFileSync(filePath, 'utf8');
        const parsed = ecc.parseMemoryDocument(document);
        assert.deepEqual(Object.keys(parsed).sort(), [...ECC_FIELDS].sort());
        assert.deepEqual(parsed, item.memory);
        assert.match(document, /^---\nschema: "ecc\.memory\.v1"\n/u);
        assert.doesNotMatch(document, /^(?:pinned|expiresAt|provenance|sourceRefs):/mu);
      }

      const structureRead = success(await first.callTool({ action: 'read', id: structureId }));
      assert.equal(structureRead.data.retention.pinned, true);
      const sessionRead = success(await first.callTool({ action: 'read', id: sessionId }));
      const sessionMemory = sessionRead.data.record.memory;
      const sessionProvenance = sessionRead.data.retention.provenance[0];
      assert.equal(sessionProvenance.sessionId, 'integration-first-session');
      assert.equal(sessionProvenance.worktreeRoot, mainRepo);
      assert.match(sessionProvenance.head, /^[0-9a-f]{40}$/iu);
      assert.equal(
        sessionRead.data.retention.expiresAt,
        new Date(Date.parse(sessionMemory.createdAt) + SESSION_DAYS_MS).toISOString(),
      );
      const decisionRead = success(await first.callTool({ action: 'read', id: decisionId }));
      assert.equal(decisionRead.data.retention.expiresAt, null);

      const worktreeHarness = makeHarness(worktree, 'integration-worktree-session');
      const worktreeStatus = success(await worktreeHarness.callTool({ action: 'status' }));
      assert.equal(worktreeStatus.data.projectId, mainResolution.project.id);
      const sharedSearch = success(await worktreeHarness.callTool({
        action: 'search',
        query: 'shared integration marker',
      }));
      const sharedIds = sharedSearch.data.results.map((item: any) => item.memory.id);
      for (const id of ids) assert.ok(sharedIds.includes(id), `worktree search missed ${id}`);
      const worktreeDecision = success(await worktreeHarness.callTool({ action: 'read', id: decisionId }));
      assert.equal(worktreeDecision.data.record.memory.id, decisionId);

      const cloneHarness = makeHarness(clone, 'integration-clone-session');
      const cloneStatus = success(await cloneHarness.callTool({ action: 'status' }));
      assert.notEqual(cloneStatus.data.projectId, mainResolution.project.id);
      const isolatedSearch = success(await cloneHarness.callTool({
        action: 'search',
        query: 'shared integration marker',
      }));
      assert.deepEqual(isolatedSearch.data.results, []);

      const configuredHarness = makeHarness(configuredRoot, 'integration-configured-session');
      const configuredStatus = success(await configuredHarness.callTool({ action: 'status' }));
      assert.equal(configuredStatus.data.enabled, true);
      const unconfiguredHarness = makeHarness(unconfiguredRoot, 'integration-unconfigured-session');
      const unconfiguredStatus = success(await unconfiguredHarness.callTool({ action: 'status' }));
      assert.equal(unconfiguredStatus.data.enabled, false);
      assert.equal(unconfiguredStatus.data.errorCode, 'PROJECT_NOT_CONFIGURED');
      assert.match(
        (await unconfiguredHarness.beforeAgentStart('Inspect this standalone workspace.')).sections.pi_context ?? '',
        /memory=disabled/u,
      );

      const quotaHarness = makeHarness(quotaRepo, 'integration-quota-session');
      const pinnedTargetId = memoryId(await quotaHarness.callTool({
        action: 'record',
        record: recordDraft('Pinned target', `Target retained by a pinned record. ${'target detail '.repeat(20)}`),
      }));
      const pinnedId = memoryId(await quotaHarness.callTool({
        action: 'record',
        record: recordDraft('Pinned structure', `This structure stays pinned. ${'pin detail '.repeat(20)}`, {
          pinned: true,
          links: [pinnedTargetId],
        }),
      }));
      const largeSourceId = memoryId(await quotaHarness.callTool({
        action: 'record',
        record: recordDraft(
          'Large old implementation detail',
          `Source information for a safe replacement. ${'old implementation detail '.repeat(420)}`,
          { sourceRefs: ['fixture://quota/source'] },
        ),
      }));
      const survivorId = memoryId(await quotaHarness.callTool({
        action: 'record',
        record: recordDraft('Surviving linked record', 'This active record links to the large source.', {
          links: [largeSourceId],
        }),
      }));

      let blockedWrite: Envelope | undefined;
      for (let index = 0; index < 20 && blockedWrite === undefined; index += 1) {
        const candidate = await quotaHarness.callTool({
          action: 'record',
          record: recordDraft(
            `Quota fill ${index}`,
            `Quota fill data ${index}. ${'filler detail '.repeat(180)}`,
          ),
        });
        const result = envelope(candidate);
        if (!result.ok) {
          assert.equal(result.code, 'QUOTA_EXCEEDED');
          blockedWrite = result;
        }
      }
      assert.ok(blockedWrite, 'the fixture quota must block a persistent write');
      assert.equal(blockedWrite.code, 'QUOTA_EXCEEDED');
      const readableBeforeCleanup = success(await quotaHarness.callTool({ action: 'read', id: largeSourceId }));
      assert.match(readableBeforeCleanup.data.record.memory.body, /safe replacement/u);
      const quotaPlan = success(await quotaHarness.callTool({ action: 'cleanup_plan', requestedFreeBytes: 1 }));
      assert.ok(quotaPlan.data.candidates.some((candidate: any) => candidate.id === largeSourceId));
      assert.ok(quotaPlan.data.protectedCount >= 2);
      const quotaApply = success(await quotaHarness.callTool({
        action: 'cleanup_apply',
        proposal: cleanupProposal(quotaPlan.data, [], [{
          sourceIds: [largeSourceId],
          summary: {
            title: 'Compact implementation detail',
            body: 'The source detail was consolidated without dropping its reference.',
            kind: 'context',
            category: 'structure',
          },
        }]),
      }));
      assert.ok(quotaApply.data.value.freedBytes > 0);
      assert.equal(quotaApply.data.value.removedIds.includes(largeSourceId), true);
      assert.equal(quotaApply.data.state, 'committed');
      const recoveredStatus = success(await quotaHarness.callTool({ action: 'status' }));
      assert.ok(recoveredStatus.data.persistentBytes < quotaPlan.data.persistentBytes);
      const replacementId = quotaApply.data.value.createdIds[0] as string;
      const compacted = success(await quotaHarness.callTool({ action: 'read', id: replacementId }));
      assert.equal(compacted.data.retention.sourceRefs.includes('fixture://quota/source'), true);
      assert.equal(compacted.data.retention.consolidatedFrom.includes(largeSourceId), true);
      const redirectedSurvivor = success(await quotaHarness.callTool({ action: 'read', id: survivorId }));
      assert.deepEqual(redirectedSurvivor.data.record.memory.links, [replacementId]);
      assert.equal(success(await quotaHarness.callTool({ action: 'read', id: pinnedId })).data.retention.pinned, true);
      assert.equal(success(await quotaHarness.callTool({ action: 'read', id: pinnedTargetId })).data.record.memory.id, pinnedTargetId);
      assert.equal(trace(quotaHarness).confirmations.length, 0, 'automatic cleanup must not open an approval dialog');

      const approvalHarness = makeHarness(approvalRepo, 'integration-approval-session', {
        mode: 'rpc',
        confirm: async (_title, _message, options) => {
          assert.equal(options?.timeout, 30_000);
          return true;
        },
      });
      const approvedId = memoryId(await approvalHarness.callTool({
        action: 'record',
        record: recordDraft('Approved cleanup item', 'The approved cleanup removes this expired item.', {
          expiresAt: PAST_EXPIRY,
        }),
      }));
      const approvedPlan = success(await approvalHarness.callTool({ action: 'cleanup_plan', requestedFreeBytes: 1 }));
      const approvedResult = success(await approvalHarness.callTool({
        action: 'cleanup_apply',
        proposal: cleanupProposal(approvedPlan.data, [approvedId]),
      }));
      assert.ok(approvedResult.data.value.removedIds.includes(approvedId));
      assert.equal(trace(approvalHarness).confirmations.length, 1);
      failure(await approvalHarness.callTool({ action: 'read', id: approvedId }), 'MEMORY_NOT_FOUND');

      const refusedHarness = makeHarness(approvalRepo, 'integration-refused-session', {
        mode: 'rpc',
        confirm: async () => false,
      });
      const refusedId = memoryId(await refusedHarness.callTool({
        action: 'record',
        record: recordDraft('Refused cleanup item', 'A refusal must preserve this expired record.', {
          expiresAt: PAST_EXPIRY,
        }),
      }));
      const refusedPlan = success(await refusedHarness.callTool({ action: 'cleanup_plan', requestedFreeBytes: 1 }));
      failure(await refusedHarness.callTool({
        action: 'cleanup_apply',
        proposal: cleanupProposal(refusedPlan.data, [refusedId]),
      }), 'APPROVAL_REQUIRED');
      assert.equal(trace(refusedHarness).confirmations.length, 1);
      assert.equal(success(await refusedHarness.callTool({ action: 'read', id: refusedId })).data.record.memory.id, refusedId);

      const timeoutHarness = makeHarness(approvalRepo, 'integration-timeout-session', {
        mode: 'rpc',
        confirm: async () => { throw new Error('dialog timeout'); },
      });
      const timeoutId = memoryId(await timeoutHarness.callTool({
        action: 'record',
        record: recordDraft('Timed cleanup item', 'A timeout must preserve this expired record.', {
          expiresAt: PAST_EXPIRY,
        }),
      }));
      const timeoutPlan = success(await timeoutHarness.callTool({ action: 'cleanup_plan', requestedFreeBytes: 1 }));
      failure(await timeoutHarness.callTool({
        action: 'cleanup_apply',
        proposal: cleanupProposal(timeoutPlan.data, [timeoutId]),
      }), 'APPROVAL_REQUIRED');
      assert.equal(trace(timeoutHarness).confirmations.length, 1);
      assert.equal(success(await timeoutHarness.callTool({ action: 'read', id: timeoutId })).data.record.memory.id, timeoutId);

      let absentUiConfirmCalls = 0;
      const absentUiHarness = makeHarness(approvalRepo, 'integration-no-ui-session', {
        mode: 'print',
        confirm: async () => { absentUiConfirmCalls += 1; return true; },
      });
      const absentUiId = memoryId(await absentUiHarness.callTool({
        action: 'record',
        record: recordDraft('No UI cleanup item', 'Missing UI must preserve this expired record.', {
          expiresAt: PAST_EXPIRY,
        }),
      }));
      const absentUiPlan = success(await absentUiHarness.callTool({ action: 'cleanup_plan', requestedFreeBytes: 1 }));
      failure(await absentUiHarness.callTool({
        action: 'cleanup_apply',
        proposal: cleanupProposal(absentUiPlan.data, [absentUiId]),
      }), 'APPROVAL_REQUIRED');
      assert.equal(absentUiConfirmCalls, 0);
      assert.equal(trace(absentUiHarness).confirmations.length, 0);
      assert.equal(success(await absentUiHarness.callTool({ action: 'read', id: absentUiId })).data.record.memory.id, absentUiId);

      const revisionWriter = makeHarness(approvalRepo, 'integration-revision-writer-session', { mode: 'rpc' });
      let revisionWriterId = '';
      const staleApprover = makeHarness(approvalRepo, 'integration-stale-approver-session', {
        mode: 'rpc',
        confirm: async () => {
          revisionWriterId = memoryId(await revisionWriter.callTool({
            action: 'record',
            record: recordDraft('Concurrent approval change', 'A second session changes the approved revision.'),
          }));
          return true;
        },
      });
      const staleId = memoryId(await staleApprover.callTool({
        action: 'record',
        record: recordDraft('Stale approval item', 'This item remains after the approval becomes stale.', {
          expiresAt: PAST_EXPIRY,
        }),
      }));
      const stalePlan = success(await staleApprover.callTool({ action: 'cleanup_plan', requestedFreeBytes: 1 }));
      failure(await staleApprover.callTool({
        action: 'cleanup_apply',
        proposal: cleanupProposal(stalePlan.data, [staleId]),
      }), 'STALE_SNAPSHOT');
      assert.equal(trace(staleApprover).confirmations.length, 1);
      assert.equal(success(await staleApprover.callTool({ action: 'read', id: staleId })).data.record.memory.id, staleId);
      assert.equal(success(await revisionWriter.callTool({ action: 'read', id: revisionWriterId })).data.record.memory.id, revisionWriterId);

      const autoExpiredId = memoryId(await first.callTool({
        action: 'record',
        record: recordDraft('Automatic cleanup item', 'Automatic cleanup does not ask for approval.', {
          expiresAt: PAST_EXPIRY,
        }),
      }));
      const autoPlan = success(await first.callTool({ action: 'cleanup_plan', requestedFreeBytes: 1 }));
      const autoTuiHarness = makeHarness(mainRepo, 'integration-auto-cleanup-session', {
        mode: 'tui',
        confirm: async () => { throw new Error('automatic cleanup must not ask'); },
      });
      success(await autoTuiHarness.callTool({
        action: 'cleanup_apply',
        proposal: cleanupProposal(autoPlan.data, [autoExpiredId]),
      }));
      assert.equal(trace(autoTuiHarness).confirmations.length, 0);

      let failBeforeGc = true;
      const pendingStore: typeof openMemoryStore = (project, policy) => openMemoryStore(project, policy, {
        onPhase(phase) {
          if (phase === 'before_gc' && failBeforeGc) {
            failBeforeGc = false;
            throw new Error('injected maintenance failure');
          }
        },
      });
      const pendingHarness = makeHarness(mainRepo, 'integration-pending-maintenance-session', {
        openStore: pendingStore,
      });
      const pendingResult = success(await pendingHarness.callTool({
        action: 'record',
        record: recordDraft('Committed with pending maintenance', 'This record committed before maintenance stopped.'),
      }));
      assert.equal(pendingResult.data.maintenance, 'pending');
      assert.equal(pendingResult.data.state, 'committed_with_maintenance');
      assert.match(trace(pendingHarness).toolTexts.at(-1) ?? '', /Do not repeat the committed write/u);
      const pendingId = pendingResult.data.value.id as string;
      assert.match(
        success(await pendingHarness.callTool({ action: 'read', id: pendingId })).data.record.memory.body,
        /committed before maintenance/u,
      );
      assert.equal(failBeforeGc, false);
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
