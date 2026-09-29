import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ContextError } from './errors.ts';

const CONFIG_FILE = 'pi-context.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const DEFAULT_POLICY: ProjectPolicy = {
  maxBytes: 10_485_760,
  cleanupMode: 'auto',
};

export interface ProjectPolicy {
  maxBytes: number;
  cleanupMode: 'auto' | 'ask';
}

export interface ProjectConfigEntry {
  root: string;
  maxBytes?: number;
  cleanupMode?: 'auto' | 'ask';
  enabled?: boolean;
}

export interface ContextConfig {
  version: 1;
  defaults: ProjectPolicy;
  projects: ProjectConfigEntry[];
}

function configError(message: string, details?: Record<string, unknown>): ContextError {
  return new ContextError('CONFIG_INVALID', message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw configError(`Configuration contains an unknown ${field} key.`, { field });
    }
  }
}

function validatePolicyFields(
  value: Record<string, unknown>,
  field: string,
): Partial<ProjectPolicy> {
  const policy: Partial<ProjectPolicy> = {};
  if (Object.hasOwn(value, 'maxBytes')) {
    const maxBytes = value.maxBytes;
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw configError(`Configuration has an invalid ${field} byte limit.`, { field });
    }
    policy.maxBytes = maxBytes;
  }
  if (Object.hasOwn(value, 'cleanupMode')) {
    const cleanupMode = value.cleanupMode;
    if (cleanupMode !== 'auto' && cleanupMode !== 'ask') {
      throw configError(`Configuration has an invalid ${field} cleanup mode.`, { field });
    }
    policy.cleanupMode = cleanupMode;
  }
  return policy;
}

function expandRoot(root: unknown, field: string): string {
  if (typeof root !== 'string' || root.length === 0 || /[\u0000-\u001f\u007f]/u.test(root)) {
    throw configError('Configuration has an unsafe project root.', { field });
  }
  const expanded = root.startsWith('~/')
    ? `${homedir()}${root.slice(1)}`
    : root;
  if (!isAbsolute(expanded)) {
    throw configError('Project roots must be absolute paths.', { field });
  }
  return expanded;
}

async function canonicalRoot(root: unknown, field: string): Promise<string> {
  const expanded = expandRoot(root, field);
  try {
    const canonical = await realpath(expanded);
    const info = await lstat(canonical);
    if (!info.isDirectory()) {
      throw configError('Project roots must be existing directories.', { field });
    }
    return canonical;
  } catch (error) {
    if (error instanceof ContextError) throw error;
    throw configError('Project roots must be existing directories.', {
      field,
      cause: causeName(error),
    });
  }
}

function causeName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/u.test(code)) return code;
  }
  return 'invalid-value';
}

function defaultConfig(): ContextConfig {
  return {
    version: 1,
    defaults: { ...DEFAULT_POLICY },
    projects: [],
  };
}

function parseConfig(text: string): Omit<ContextConfig, 'projects'> & {
  projects: Array<Omit<ProjectConfigEntry, 'root'> & { root: unknown }>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw configError('Configuration file contains invalid JSON.');
  }
  if (!isRecord(parsed)) throw configError('Configuration file must contain a JSON object.');
  rejectUnknownKeys(parsed, ['version', 'defaults', 'projects'], 'top-level');
  if (parsed.version !== 1) throw configError('Configuration version is not supported.');
  if (!Array.isArray(parsed.projects)) {
    throw configError('Configuration projects must be an array.');
  }

  const defaults = { ...DEFAULT_POLICY };
  if (Object.hasOwn(parsed, 'defaults')) {
    if (!isRecord(parsed.defaults)) {
      throw configError('Configuration defaults must be an object.');
    }
    rejectUnknownKeys(parsed.defaults, ['maxBytes', 'cleanupMode'], 'defaults');
    Object.assign(defaults, validatePolicyFields(parsed.defaults, 'defaults'));
  }

  const projects = parsed.projects.map((entry, index) => {
    const field = `projects[${index}]`;
    if (!isRecord(entry)) throw configError('Project entries must be objects.', { field });
    rejectUnknownKeys(entry, ['root', 'maxBytes', 'cleanupMode', 'enabled'], 'project');
    if (!Object.hasOwn(entry, 'root')) throw configError('Project entries need a root.', { field });
    const policy = validatePolicyFields(entry, field);
    if (Object.hasOwn(entry, 'enabled') && typeof entry.enabled !== 'boolean') {
      throw configError('Project entries have an invalid enabled value.', { field });
    }
    return {
      root: entry.root,
      ...(policy.maxBytes === undefined ? {} : { maxBytes: policy.maxBytes }),
      ...(policy.cleanupMode === undefined ? {} : { cleanupMode: policy.cleanupMode }),
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled as boolean }),
    };
  });
  return { version: 1, defaults, projects };
}

async function readConfigFile(filePath: string): Promise<Buffer | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (causeName(error) === 'ENOENT') return undefined;
    throw configError('Configuration file cannot be accessed.', { cause: causeName(error) });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw configError('Configuration file must be a regular, non-symlink file.');
  }

  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw configError('Configuration file cannot be opened safely.', { cause: causeName(error) });
  }
  try {
    const openedInfo = await file.stat();
    if (!openedInfo.isFile()) {
      throw configError('Configuration file must be a regular, non-symlink file.');
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) {
      throw configError('Configuration file exceeds the 64 KiB limit.');
    }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof ContextError) throw error;
    throw configError('Configuration file cannot be read.', { cause: causeName(error) });
  } finally {
    await file.close();
  }
}

export async function loadConfig(agentDir: string): Promise<ContextConfig> {
  const filePath = join(agentDir, CONFIG_FILE);
  const bytes = await readConfigFile(filePath);
  if (bytes === undefined) return defaultConfig();

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw configError('Configuration file must contain valid UTF-8.');
  }
  const parsed = parseConfig(text);
  const projects: ProjectConfigEntry[] = [];
  const seenRoots = new Set<string>();
  for (let index = 0; index < parsed.projects.length; index += 1) {
    const entry = parsed.projects[index];
    if (!entry) continue;
    const root = await canonicalRoot(entry.root, `projects[${index}].root`);
    if (seenRoots.has(root)) {
      throw configError('Configuration contains duplicate canonical project roots.', {
        field: `projects[${index}].root`,
      });
    }
    seenRoots.add(root);
    projects.push({ ...entry, root });
  }
  return { version: 1, defaults: parsed.defaults, projects };
}
