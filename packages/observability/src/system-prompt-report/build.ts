// SPDX-License-Identifier: Apache-2.0
/**
 * buildSystemPromptReport — synthesize a SystemPromptReport v1 from
 * the prompt-assembly outputs.
 *
 * Highlights:
 *   - SHA256 digests for cross-correlation with the `prompt:submitted`
 *     event.
 *   - `# Project Context` ↔ `## Silent Replies` marker extraction
 *     splits the assembled prompt into project-context vs the static
 *     prefix (the cache-stable region).
 *   - WeakMap caching keyed on the tool object identity + schema
 *     object identity avoids redoing JSON.stringify per turn.
 *   - `policyFilteredToolNames` (Comis-specific): tools registered in
 *     the prompt but blocked by policy carry `callable: false`.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { SystemPromptReport } from "./types.js";

// ---------------------------------------------------------------------------
// Per-component shapes (intentionally loose so callers can pass shapes
// from @comis/agent without circular imports).
// ---------------------------------------------------------------------------

/**
 * Lightweight bootstrap-file shape consumed by the report builder.
 *
 * Note: this is intentionally NOT the `BootstrapFile` from
 * `@comis/agent/bootstrap` (that interface is `readonly content?: string`,
 * which means we can't quickly compute injected chars without re-running
 * the truncation). Callers should pre-compute `injectedChars` from the
 * already-built `BootstrapContextFile[]` and pass `rawChars` from the
 * source `BootstrapFile`'s `content?.length ?? 0`.
 */
export interface BootstrapFileForReport {
  readonly name: string;
  readonly missing: boolean;
  /** Original character count on disk (0 when missing). */
  readonly rawChars: number;
  /** Character count actually injected into the prompt. */
  readonly injectedChars: number;
  /** Raw file content for sha256 digest (omit when missing). */
  readonly rawContent?: string;
}

/**
 * Lightweight tool shape consumed by the report builder.
 *
 * Caller provides the tool's input-schema object. The builder caches
 * the rendered metadata (propertiesCount + schemaChars) per schema
 * object identity (WeakMap), so re-passing the same schema across
 * builds is O(1).
 */
export interface ResolvedToolForReport {
  readonly name: string;
  /** Tool input-schema (Zod-rendered JSON Schema or arbitrary plain
   *  object — the builder only reads `properties` keys + JSON.stringify
   *  length). */
  readonly schema: object | undefined;
}

interface ToolReportEntry {
  readonly propertiesCount: number;
  readonly schemaChars: number;
}

/**
 * Cluster of optional metadata fields (per the optional-field-bloat
 * architecture invariant: ≤12 optional fields per interface).
 *
 * Wraps cross-correlation IDs + provider/model/workspace identifiers
 * that flow through the report unchanged. Callers may pass `{}` if
 * none of these are available; the builder writes them as `undefined`
 * into the SystemPromptReport's optional fields.
 */
export interface BuildParamsContext {
  readonly traceId?: string;
  readonly tenantId?: string;
  readonly sessionKey?: string;
  readonly runId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly workspaceDir?: string;
}

interface BuildParams {
  readonly source: "run" | "boot" | "session-create";
  readonly generatedAt: number;
  readonly agentId: string;
  readonly sessionId: string;
  /** Optional metadata cluster — cross-correlation IDs + identifiers. */
  readonly context?: BuildParamsContext;
  /** The literal assembled system prompt string. */
  readonly systemPrompt: string;
  /** Operator's bootstrap budget for per-file truncation detection. */
  readonly bootstrapMaxChars: number;
  /** Optional aggregate cap across all bootstrap files. */
  readonly bootstrapTotalMaxChars?: number;
  /** Pre-computed truncation summary (optional — when omitted the
   *  builder synthesizes from injectedWorkspaceFiles[]). */
  readonly bootstrapTruncation?: SystemPromptReport["bootstrapTruncation"];
  readonly bootstrapFiles: ReadonlyArray<BootstrapFileForReport>;
  readonly skillsPrompt?: {
    readonly entries: ReadonlyArray<{ readonly name: string; readonly blockChars: number }>;
    readonly promptChars: number;
  };
  readonly tools: ReadonlyArray<ResolvedToolForReport>;
  /** Tool names registered in the prompt but blocked by policy. */
  readonly policyFilteredToolNames?: ReadonlySet<string>;
  readonly memoryInjection?: SystemPromptReport["memoryInjection"];
  readonly sandbox?: SystemPromptReport["sandbox"];
}

// ---------------------------------------------------------------------------
// Module-level caches (WeakMap keyed on object identity).
// ---------------------------------------------------------------------------

/** Cache rendered ToolReportEntry per tool object identity. */
const TOOL_ENTRY_CACHE = new WeakMap<object, ToolReportEntry>();

/** Cache schema metadata per schema-object identity (for tools that share
 *  schemas across calls). */
const SCHEMA_STATS_CACHE = new WeakMap<object, ToolReportEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_CONTEXT_MARKER = "# Project Context";
const SILENT_REPLIES_MARKER = "## Silent Replies";

/**
 * Measure the character count between the `# Project Context` header
 * and the `## Silent Replies` marker (the bootstrap-file injection
 * region).
 *
 * Returns 0 when either marker is missing.
 */
export function measureRenderedProjectContextChars(systemPrompt: string): number {
  const start = systemPrompt.indexOf(PROJECT_CONTEXT_MARKER);
  if (start < 0) return 0;
  const end = systemPrompt.indexOf(SILENT_REPLIES_MARKER, start + PROJECT_CONTEXT_MARKER.length);
  if (end < 0) return 0;
  return end - (start + PROJECT_CONTEXT_MARKER.length);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function getOrComputeToolEntry(tool: ResolvedToolForReport): ToolReportEntry {
  // Tier 1: per-tool object identity (covers the common case where the
  // same tool object is reused across turns).
  const cachedByTool = TOOL_ENTRY_CACHE.get(tool);
  if (cachedByTool) return cachedByTool;

  // Tier 2: per-schema object identity (covers the case where the
  // wrapper tool object changes but the schema is shared, e.g., when
  // a fresh adapter wraps a shared schema constant).
  let entry: ToolReportEntry;
  const schema = tool.schema;
  if (schema && typeof schema === "object") {
    const cachedBySchema = SCHEMA_STATS_CACHE.get(schema);
    if (cachedBySchema) {
      entry = cachedBySchema;
    } else {
      entry = renderToolEntry(schema);
      SCHEMA_STATS_CACHE.set(schema, entry);
    }
  } else {
    entry = { propertiesCount: 0, schemaChars: 0 };
  }

  TOOL_ENTRY_CACHE.set(tool, entry);
  return entry;
}

function renderToolEntry(schema: object): ToolReportEntry {
  const schemaChars = JSON.stringify(schema).length;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  const propertiesCount = props && typeof props === "object" ? Object.keys(props).length : 0;
  return { propertiesCount, schemaChars };
}

/**
 * Per-file truncation predicate (260519-rrm deviation H fix).
 *
 * Tolerate a single trailing-whitespace character: the bootstrap injector
 * strips trailing whitespace from injected content, so `rawChars -
 * injectedChars === 1` is whitespace normalization, NOT truncation. A
 * delta > 1 indicates real truncation.
 *
 * The audit captured `SOUL.md 2840→2839`, `IDENTITY.md 787→786`,
 * `USER.md 458→457` — all three are single-newline strips, and the
 * pre-fix predicate flagged all three as truncated. The 1-char tolerance
 * is intentionally minimal; larger tolerances would mask real bugs.
 */
function isFileTruncated(f: BootstrapFileForReport): boolean {
  return (
    !f.missing &&
    f.injectedChars < f.rawChars &&
    f.rawChars - f.injectedChars > 1
  );
}

function summarizeBootstrapTruncation(
  files: ReadonlyArray<BootstrapFileForReport>,
): SystemPromptReport["bootstrapTruncation"] {
  let originalCharsTotal = 0;
  let injectedCharsTotal = 0;
  let filesTruncated = 0;
  for (const f of files) {
    originalCharsTotal += f.rawChars;
    injectedCharsTotal += f.injectedChars;
    if (isFileTruncated(f)) filesTruncated += 1;
  }
  return {
    applied: filesTruncated > 0,
    filesTruncated,
    originalCharsTotal,
    injectedCharsTotal,
  };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a SystemPromptReport v1 from the prompt-assembly outputs.
 *
 * Pure synchronous function — no I/O. The caller persists via
 * `persistSystemPromptReport` (see persist.ts).
 */
export function buildSystemPromptReport(params: BuildParams): SystemPromptReport {
  // --- systemPrompt block --------------------------------------------------
  const chars = params.systemPrompt.length;
  const projectContextChars = measureRenderedProjectContextChars(params.systemPrompt);
  const nonProjectContextChars = chars - projectContextChars;
  const promptSha256 = sha256Hex(params.systemPrompt);

  // --- injectedWorkspaceFiles[] -------------------------------------------
  const injectedWorkspaceFiles: SystemPromptReport["injectedWorkspaceFiles"] = params.bootstrapFiles.map(
    (f) => {
      // Truncation predicate tolerates a 1-char delta to absorb the
      // bootstrap injector's trailing-whitespace strip (260519-rrm
      // deviation H). See `isFileTruncated` for rationale.
      const truncated = isFileTruncated(f);
      const sha256 = !f.missing && f.rawContent !== undefined ? sha256Hex(f.rawContent) : undefined;
      return {
        name: f.name,
        missing: f.missing,
        truncated,
        rawChars: f.rawChars,
        injectedChars: f.injectedChars,
        sha256,
      };
    },
  );

  // --- tools block ---------------------------------------------------------
  const policyFiltered = params.policyFilteredToolNames ?? new Set<string>();
  let totalSchemaChars = 0;
  const toolEntries: SystemPromptReport["tools"]["entries"] = params.tools.map((t) => {
    const meta = getOrComputeToolEntry(t);
    totalSchemaChars += meta.schemaChars;
    return {
      name: t.name,
      propertiesCount: meta.propertiesCount,
      schemaChars: meta.schemaChars,
      callable: !policyFiltered.has(t.name),
    };
  });

  // --- skills block --------------------------------------------------------
  const skills = params.skillsPrompt ?? { entries: [], promptChars: 0 };

  // --- bootstrap truncation summary ---------------------------------------
  const bootstrapTruncation =
    params.bootstrapTruncation ?? summarizeBootstrapTruncation(params.bootstrapFiles);

  // --- assembled report ----------------------------------------------------
  const ctx = params.context ?? {};
  const report: SystemPromptReport = {
    traceSchema: "comis-system-prompt-report",
    schemaVersion: 1,
    source: params.source,
    generatedAt: params.generatedAt,
    traceId: ctx.traceId,
    agentId: params.agentId,
    tenantId: ctx.tenantId,
    sessionId: params.sessionId,
    sessionKey: ctx.sessionKey,
    runId: ctx.runId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceDir: ctx.workspaceDir,
    systemPrompt: {
      sha256: promptSha256,
      chars,
      projectContextChars,
      nonProjectContextChars,
    },
    // Persist the bootstrap budgets that produced the truncation outcome.
    // `bootstrapMaxChars` is required; `bootstrapTotalMaxChars` is
    // conditionally spread so the field is genuinely absent (rather than
    // serialized as `undefined`) when the caller didn't supply it —
    // matches the optional-field convention used by `traceId`, `runId`, etc.
    bootstrapMaxChars: params.bootstrapMaxChars,
    ...(params.bootstrapTotalMaxChars !== undefined
      ? { bootstrapTotalMaxChars: params.bootstrapTotalMaxChars }
      : {}),
    bootstrapTruncation,
    injectedWorkspaceFiles,
    skills,
    tools: {
      entries: toolEntries,
      totalSchemaChars,
    },
    memoryInjection: params.memoryInjection,
    sandbox: params.sandbox,
  };

  return report;
}
