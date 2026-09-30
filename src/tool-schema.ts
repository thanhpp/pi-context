import { Type, type Static } from 'typebox';
import type { MemoryKind } from './ecc.ts';

export const ACTIONS = [
  'status', 'search', 'read', 'record', 'retention', 'cleanup_plan', 'cleanup_apply',
] as const;
export type ToolAction = (typeof ACTIONS)[number];

export const MEMORY_KINDS = [
  'context', 'decision', 'fact', 'handoff', 'lesson', 'note', 'preference', 'runbook',
] as const satisfies readonly MemoryKind[];

const tagsSchema = Type.Optional(Type.Array(Type.String({
  minLength: 1,
  maxLength: 64,
  description: 'Use letters, numbers, dots, underscores, or hyphens. The tool converts uppercase letters to lowercase and spaces to hyphens.',
}), { maxItems: 32 }));
const linksSchema = Type.Optional(Type.Array(Type.String(), { maxItems: 64, uniqueItems: true }));
const summaryFields = {
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ minLength: 1, description: 'Project context. The UTF-8 limit is 65,536 bytes.' }),
  kind: Type.Enum(MEMORY_KINDS),
  category: Type.Enum(['session', 'structure', 'decision', 'other'] as const),
  tags: tagsSchema,
  links: linksSchema,
};
const summarySchema = Type.Object(summaryFields, { additionalProperties: false });
const recordSchema = Type.Object({
  ...summaryFields,
  pinned: Type.Optional(Type.Boolean()),
  expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceRefs: Type.Optional(Type.Array(Type.String(), { maxItems: 64, uniqueItems: true })),
}, { additionalProperties: false });
const retentionSchema = Type.Object({
  pinned: Type.Optional(Type.Boolean()),
  expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false });
const consolidationSchema = Type.Object({
  sourceIds: Type.Array(Type.String()),
  summary: summarySchema,
}, { additionalProperties: false });
const proposalSchema = Type.Object({
  revision: Type.String(),
  obsoleteIds: Type.Array(Type.String()),
  consolidations: Type.Array(consolidationSchema),
}, { additionalProperties: false });

export const parameters = Type.Object({
  action: Type.Enum(ACTIONS),
  query: Type.Optional(Type.String()),
  kinds: Type.Optional(Type.Array(Type.Enum(MEMORY_KINDS))),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  id: Type.Optional(Type.String()),
  record: Type.Optional(recordSchema),
  retention: Type.Optional(retentionSchema),
  requestedFreeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  proposal: Type.Optional(proposalSchema),
}, { additionalProperties: false });
export type PiContextParams = Static<typeof parameters>;
