// SPDX-License-Identifier: Apache-2.0
/**
 * SystemPromptReport v1 type and Zod schema.
 *
 * Per design §8.1: a structured snapshot of every component of an
 * assembled system prompt, capturing per-file accounting so operators
 * can answer "why didn't the model use IDENTITY.md?" by inspecting
 * `injectedWorkspaceFiles[].missing` / `truncated` / `rawChars` /
 * `injectedChars`.
 *
 * Both the TypeScript type `SystemPromptReport` AND the Zod schema
 * `SystemPromptReportSchema` are first-class deliverables of this
 * module. The two stay in sync via the
 * `expectTypeOf<z.infer<typeof Schema>>().toEqualTypeOf<Type>()`
 * assertion in `types.test.ts`.
 *
 * Schema-versioned (`traceSchema: "comis-system-prompt-report"`,
 * `schemaVersion: 1`) so future revisions can land additive fields
 * without breaking persisted records.
 *
 * Comis-specific notes:
 *   - `injectedWorkspaceFiles[]` reflects bootstrap-injected files only
 *     (from `loadWorkspaceBootstrapFiles`). Today only `AGENTS.md` is
 *     loaded; the schema accommodates N entries.
 *   - `tools.entries[].callable` is a Comis improvement over the design:
 *     `false` indicates the tool was registered but filtered out by
 *     policy (e.g., toolPolicy.deny). Present in the prompt but not
 *     invocable.
 *
 * @module
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const SystemPromptBlockSchema = z.object({
  /** SHA256 hex digest of the assembled system prompt. */
  sha256: z.string(),
  /** Total characters in the assembled system prompt. */
  chars: z.number().int().nonnegative(),
  /** Characters between the `# Project Context` and `## Silent Replies`
   *  markers (the bootstrap-file injection region per design §2.6).
   *  `0` when markers are absent. */
  projectContextChars: z.number().int().nonnegative(),
  /** chars - projectContextChars (the static-prefix region). */
  nonProjectContextChars: z.number().int().nonnegative(),
});

const BootstrapTruncationSchema = z.object({
  /** Whether the bootstrap budget was hit and content truncated. */
  applied: z.boolean(),
  /** Number of files whose content was head+tail-truncated. */
  filesTruncated: z.number().int().nonnegative(),
  /** Sum of original char counts before truncation. */
  originalCharsTotal: z.number().int().nonnegative(),
  /** Sum of injected char counts after truncation. */
  injectedCharsTotal: z.number().int().nonnegative(),
});

const InjectedWorkspaceFileSchema = z.object({
  /** Workspace file name (e.g., "AGENTS.md"). */
  name: z.string(),
  /** Whether the file was missing from the workspace at load time. */
  missing: z.boolean(),
  /** Whether the file's content was truncated to fit the bootstrap budget. */
  truncated: z.boolean(),
  /** Original character count on disk (0 when missing). */
  rawChars: z.number().int().nonnegative(),
  /** Character count actually injected into the prompt. */
  injectedChars: z.number().int().nonnegative(),
  /** SHA256 of the raw file content (omitted when missing). */
  sha256: z.string().optional(),
});

const SkillEntrySchema = z.object({
  name: z.string(),
  blockChars: z.number().int().nonnegative(),
});

const SkillsBlockSchema = z.object({
  entries: z.array(SkillEntrySchema),
  /** Total characters in the rendered skills XML block. */
  promptChars: z.number().int().nonnegative(),
});

const ToolEntrySchema = z.object({
  name: z.string(),
  /** Number of input-schema properties. */
  propertiesCount: z.number().int().nonnegative(),
  /** Character size of the rendered tool schema. */
  schemaChars: z.number().int().nonnegative(),
  /** Whether the tool is invocable (false when policy-filtered). */
  callable: z.boolean(),
});

const ToolsBlockSchema = z.object({
  entries: z.array(ToolEntrySchema),
  /** Sum of schemaChars across all entries. */
  totalSchemaChars: z.number().int().nonnegative(),
});

const MemoryInjectionSchema = z.object({
  ragHits: z.number().int().nonnegative(),
  charsInjected: z.number().int().nonnegative(),
  trustTags: z.array(z.string()),
});

const SandboxSchema = z.object({
  /** Sandbox profile name (e.g., "bwrap-strict"). */
  profile: z.string().optional(),
  /** Whether sandbox enforcement is enabled. */
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for SystemPromptReport v1. Consumed by `@comis/core`
 * API contracts (task 8) for RPC-surface validation.
 */
export const SystemPromptReportSchema = z.object({
  traceSchema: z.literal("comis-system-prompt-report"),
  schemaVersion: z.literal(1),
  source: z.union([
    z.literal("run"),
    z.literal("boot"),
    z.literal("session-create"),
  ]),
  generatedAt: z.number().int().nonnegative(),
  traceId: z.string().optional(),
  agentId: z.string(),
  tenantId: z.string().optional(),
  sessionId: z.string(),
  sessionKey: z.string().optional(),
  runId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  workspaceDir: z.string().optional(),
  systemPrompt: SystemPromptBlockSchema,
  /** Plan 45.1-05 (TRAJ-FIX-09): per-file bootstrap budget knob (from
   *  `config.bootstrap.maxChars`) that produced the truncation
   *  outcome — required so operators can read the budget alongside
   *  the result. Breaking change vs pre-45.1 persisted rows by
   *  design (see plan §Risks). */
  bootstrapMaxChars: z.number().int().nonnegative(),
  /** Plan 45.1-05 (TRAJ-FIX-09): aggregate cap across all bootstrap
   *  files, when configured. Optional because the aggregate cap is
   *  not configured in every deployment. */
  bootstrapTotalMaxChars: z.number().int().nonnegative().optional(),
  bootstrapTruncation: BootstrapTruncationSchema.optional(),
  injectedWorkspaceFiles: z.array(InjectedWorkspaceFileSchema),
  skills: SkillsBlockSchema,
  tools: ToolsBlockSchema,
  memoryInjection: MemoryInjectionSchema.optional(),
  sandbox: SandboxSchema.optional(),
});

// ---------------------------------------------------------------------------
// TypeScript type (Type ⇄ Schema sync proven in types.test.ts)
// ---------------------------------------------------------------------------

/**
 * SystemPromptReport v1 — structured snapshot of every component of
 * an assembled system prompt.
 *
 * The type is the operator-facing shape (TypeScript-first). The
 * paired `SystemPromptReportSchema` Zod schema runtime-validates the
 * same shape at the RPC boundary. The two are proven equivalent via
 * `expectTypeOf<z.infer<...>>().toEqualTypeOf<...>()` in
 * `types.test.ts`.
 */
export type SystemPromptReport = {
  readonly traceSchema: "comis-system-prompt-report";
  readonly schemaVersion: 1;
  readonly source: "run" | "boot" | "session-create";
  readonly generatedAt: number;
  readonly traceId?: string;
  readonly agentId: string;
  readonly tenantId?: string;
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly runId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly workspaceDir?: string;
  readonly systemPrompt: {
    readonly sha256: string;
    readonly chars: number;
    readonly projectContextChars: number;
    readonly nonProjectContextChars: number;
  };
  /** Plan 45.1-05 (TRAJ-FIX-09): per-file bootstrap budget knob. */
  readonly bootstrapMaxChars: number;
  /** Plan 45.1-05 (TRAJ-FIX-09): aggregate cap across all bootstrap
   *  files (optional — not every deployment configures it). */
  readonly bootstrapTotalMaxChars?: number;
  readonly bootstrapTruncation?: {
    readonly applied: boolean;
    readonly filesTruncated: number;
    readonly originalCharsTotal: number;
    readonly injectedCharsTotal: number;
  };
  readonly injectedWorkspaceFiles: ReadonlyArray<{
    readonly name: string;
    readonly missing: boolean;
    readonly truncated: boolean;
    readonly rawChars: number;
    readonly injectedChars: number;
    readonly sha256?: string;
  }>;
  readonly skills: {
    readonly entries: ReadonlyArray<{
      readonly name: string;
      readonly blockChars: number;
    }>;
    readonly promptChars: number;
  };
  readonly tools: {
    readonly entries: ReadonlyArray<{
      readonly name: string;
      readonly propertiesCount: number;
      readonly schemaChars: number;
      readonly callable: boolean;
    }>;
    readonly totalSchemaChars: number;
  };
  readonly memoryInjection?: {
    readonly ragHits: number;
    readonly charsInjected: number;
    readonly trustTags: ReadonlyArray<string>;
  };
  readonly sandbox?: {
    readonly profile?: string;
    readonly enabled: boolean;
  };
};
