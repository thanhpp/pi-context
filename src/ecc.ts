import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ContextError } from './errors.ts';

export { ContextError };

export type MemoryKind =
  | 'context'
  | 'decision'
  | 'fact'
  | 'handoff'
  | 'lesson'
  | 'note'
  | 'preference'
  | 'runbook';

export interface MemoryRecord {
  schema: 'ecc.memory.v1';
  id: string;
  title: string;
  kind: MemoryKind;
  scope: 'project' | 'team' | 'user';
  trust: 'unreviewed';
  status: 'active' | 'rejected' | 'superseded';
  sourceHarness: string;
  targetHarnesses: string[];
  tags: string[];
  links: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

export type MemorySummary = Omit<MemoryRecord, 'body'>;

export interface EccRoots {
  readonly project: string;
  readonly team: string;
  readonly user: string;
}

export interface EccOptions {
  roots: EccRoots;
  scopes: ['project'];
  targetHarness: 'pi';
  now?: () => string;
  idFactory?: () => string;
}

export interface EccInvalidFile {
  path: string;
  code: string;
  message: string;
}

export interface EccDiagnostics {
  invalidFiles: EccInvalidFile[];
  invalidFileCount: number;
  skippedSymlinks: string[];
  skippedSymlinkCount: number;
  scannedBytes: number;
  truncated: boolean;
  diagnosticsTruncated: boolean;
}

export interface EccScan extends EccDiagnostics {
  entries: Array<{ memory: MemoryRecord; path: string }>;
}

export interface EccSearchResult {
  results: Array<{
    memory: MemorySummary;
    score: number;
    excerpt: string;
  }>;
  diagnostics: EccDiagnostics;
}

export interface EccReadResult {
  memory: MemoryRecord;
  path: string;
  backlinks: MemorySummary[];
  backlinksTruncated: boolean;
}

export interface EccMemoryInput {
  id?: string;
  title: string;
  kind?: MemoryKind;
  scope?: MemoryRecord['scope'];
  sourceHarness?: string;
  targetHarnesses?: string[];
  tags?: string[];
  links?: string[];
  body: string;
}

export type EccScope = MemoryRecord['scope'];

export interface EccCallOptions {
  roots?: EccRoots;
  scopes?: EccScope[];
  scope?: EccScope;
  targetHarness?: string;
  now?: () => string;
  idFactory?: () => string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  kinds?: MemoryKind[];
  trust?: MemoryRecord['trust'];
  limit?: number;
}

export interface EccRootOptions {
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface EccVaultInitialization {
  scopes: EccScope[];
  roots: EccRoots;
  directories: string[];
}

export interface EccSaveResult {
  memory: MemoryRecord;
  path: string;
}

export interface EccDoctorResult extends EccDiagnostics {
  schemaVersion: 'ecc.memory.doctor.v1';
  ok: boolean;
  memoryCount: number;
  duplicateIds: Array<{ id: string; paths: string[] }>;
  duplicateIdCount: number;
  brokenLinks: Array<{ sourceId: string; targetId: string; path: string }>;
  brokenLinkCount: number;
}

interface VaultModule {
  resolveVaultRoots(options?: EccRootOptions): EccRoots;
  initializeVault(options?: EccCallOptions): EccVaultInitialization;
  normalizeMemory(memory: unknown): MemoryRecord;
  serializeMemoryDocument(memory: MemoryRecord): string;
  parseMemoryDocument(source: string, sourcePath?: string): MemoryRecord;
  saveMemory(input: EccMemoryInput, options?: EccCallOptions): EccSaveResult;
  readMemoryFiles(options?: EccCallOptions): EccScan;
  searchMemories(query: string, options?: EccCallOptions): EccSearchResult;
  readMemoryById(id: string, options?: EccCallOptions): EccReadResult;
  doctorMemoryVault(options?: EccCallOptions): EccDoctorResult;
  readRegularTextFile(
    filePath: string,
    options?: { label?: string; maxBytes?: number; trustedRoot?: string },
  ): string;
  findPotentialSecrets(value: unknown): string[];
  defaultMemoryId(now?: Date): string;
  tokenize(value: unknown): string[];
  scoreMemory(memory: MemoryRecord, query: string): number;
}

interface FormatModule {
  validateMemoryId(value: unknown): string;
  hasUnsafeControlCharacters(value: string, allowBodyWhitespace?: boolean): boolean;
  validateSlug(value: unknown, label: string): string;
  asNonEmptyString(value: unknown, label: string, maxChars?: number): string;
  findPotentialSecrets(value: unknown): string[];
}

const require = createRequire(import.meta.url);
const vault = require('../vendor/ecc/memory-vault.js') as VaultModule;
const format = require('../vendor/ecc/memory-vault-format.js') as FormatModule;

export function createEccOptions(baseDir: string): EccOptions {
  const roots = vault.resolveVaultRoots({
    cwd: baseDir,
    homeDir: baseDir,
    env: {
      ECC_MEMORY_PROJECT_ROOT: baseDir,
      ECC_MEMORY_USER_ROOT: join(baseDir, '.disabled-user'),
    },
  });
  return {
    roots,
    scopes: ['project'],
    targetHarness: 'pi',
  };
}

export const ecc = {
  resolveVaultRoots: vault.resolveVaultRoots,
  initializeVault: vault.initializeVault,
  normalizeMemory: vault.normalizeMemory,
  serializeMemoryDocument: vault.serializeMemoryDocument,
  parseMemoryDocument: vault.parseMemoryDocument,
  saveMemory: vault.saveMemory,
  readMemoryFiles: vault.readMemoryFiles,
  searchMemories: vault.searchMemories,
  readMemoryById: vault.readMemoryById,
  doctorMemoryVault: vault.doctorMemoryVault,
  readRegularTextFile: vault.readRegularTextFile,
  findPotentialSecrets: format.findPotentialSecrets,
  defaultMemoryId: vault.defaultMemoryId,
  tokenize: vault.tokenize,
  scoreMemory: vault.scoreMemory,
  validateMemoryId: format.validateMemoryId,
  hasUnsafeControlCharacters: format.hasUnsafeControlCharacters,
  validateSlug: format.validateSlug,
  asNonEmptyString: format.asNonEmptyString,
} as const;
