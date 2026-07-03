// SPDX-License-Identifier: Apache-2.0
/**
 * Codegen entry point: produces the committed `comis_tools` SDK
 * (`packages/skills/src/tools/builtin/orchestrate/comis_tools.{d.ts,js}`)
 * DETERMINISTICALLY from the single source of truth `TOOL_CAPABILITY_MAP`
 * (+ `TOOL_ROUTE_MAP` / `RESULT_REF_THRESHOLDS`) in `@comis/core`.
 *
 * Because the SDK is emitted from the SAME cap-map as the
 * `tool.invoke` gate, the SDK and the gate CANNOT drift: a hand-edit
 * surfacing a tool the gate denies (or hiding one it allows) fails the
 * byte-identical drift gate (`test/architecture/orchestrate-sdk-drift.test.ts`).
 *
 * Progressive disclosure: the emitted `.d.ts` IS the full typed
 * contract (one async method per cap-mapped tool); the runtime `describe()`
 * is the small discovery surface (tool names + one-line summaries +
 * capability), so an agent can list the surface cheaply and reach for the full
 * per-tool types on demand. The high-volume tools (the `RESULT_REF_THRESHOLDS`
 * set — web fetch/search, document extraction, recursive grep, file read)
 * return a `ResultRef` whose `.grep()/.jq()/.read()` extraction keeps the big
 * (untrusted) payload on disk and out of context.
 *
 * Pipeline:
 *   1. Sort the cap-map tool names (the SINGLE sort point) so the emit is
 *      stable regardless of source declaration order.
 *   2. Emit the `.d.ts` (typed methods + ResultRef + the SDK interface).
 *   3. Emit the thin `.js` runtime (each method delegates to the stable
 *      `./orchestrate-sdk-runtime.js` shim; `describe()`
 *      returns the static discovery list).
 *   4. `writeFileSync` both into `outDir`, AND return the two strings so the
 *      drift test can compare in-memory == disk without re-reading.
 *
 * Determinism rules (mirrors generate-web-artifact.ts:23-27):
 *   - No ambient-clock read, no constructed Date, no UUID, no randomness.
 *   - 2-space indentation; trailing newline (POSIX).
 *   - A single sort point: alphabetical-by-tool-name over `TOOL_CAPABILITY_MAP`.
 *
 * Runtime contract (the generated `.js` depends on it):
 * `packages/skills/src/tools/builtin/orchestrate/orchestrate-sdk-runtime.ts`
 * exports `invoke(tool, args)` (one `tool.invoke` RPC over the cap socket)
 * and `wrapResultRef(handle)` (attaches the in-jail `.grep/.jq/.read`
 * extraction). The generated `.js` imports them by that STABLE name, so the
 * emitted bytes are stable and the runtime module fills the behavior.
 *
 * Usage:
 *   pnpm sdk:generate
 *   # or: npx tsx scripts/orchestrate-sdk/generate-comis-tools-sdk.ts
 *
 * @module
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_CAPABILITY_MAP,
  TOOL_ROUTE_MAP,
  RESULT_REF_THRESHOLDS,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Output paths — anchored to repo root via this script's directory (mirrors
// generate-web-artifact.ts:53-59).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const COMMITTED_DIR = resolve(
  REPO_ROOT,
  "packages",
  "skills",
  "src",
  "tools",
  "builtin",
  "orchestrate",
);

export const OUT_DTS = resolve(COMMITTED_DIR, "comis_tools.d.ts");
export const OUT_JS = resolve(COMMITTED_DIR, "comis_tools.js");

/** Artifact filenames (constant across output dirs; tests redirect via `outDir`). */
const ARTIFACT_DTS = "comis_tools.d.ts";
const ARTIFACT_JS = "comis_tools.js";

// ---------------------------------------------------------------------------
// Codegen result — returned by runCodegen so the drift test compares the
// in-memory strings against the freshly-written disk bytes.
// ---------------------------------------------------------------------------

export interface SdkCodegenResult {
  /** The `.d.ts` typed-contract source written to comis_tools.d.ts. */
  readonly dts: string;
  /** The thin `.js` runtime source written to comis_tools.js. */
  readonly js: string;
}

// ---------------------------------------------------------------------------
// One-line tool summaries for the discovery surface (`describe()`). Keyed by
// tool name; a tool absent here falls back to a generic capability-derived
// line, so adding a cap-map tool never breaks the build — it just gets a
// generic summary until a bespoke one is added.
// ---------------------------------------------------------------------------

const TOOL_SUMMARIES: Record<string, string> = {
  memory_search: "Search the agent's long-term memory (self-tenant).",
  memory_get: "Fetch a specific memory file by id (self-tenant).",
  session_search: "Search across the agent's own session history.",
  extract_document: "Extract readable text from a document (pdf/docx/…).",
  sessions_list: "List the agent's own sessions.",
  session_status: "Read the status of one of the agent's sessions.",
  sessions_history: "Read the message history of the agent's own session.",
  read: "Read a file from the jailed workspace (offset/limit).",
  grep: "Search the jailed workspace for a pattern (recursive).",
  find: "Find files in the jailed workspace by name/glob.",
  ls: "List a directory in the jailed workspace.",
  jq: "Run a jq expression over JSON (a value or a ResultRef).",
  sql: "Run DuckDB SQL over a CSV/JSONL/JSON ResultRef (daemon-side, read-only).",
  jsonpath: "Extract a precise value from a JSON ResultRef via JSONPath (no eval).",
  web_search: "Search the web (daemon-side, DNS-pinned).",
  web_fetch: "Fetch a URL's readable content (daemon-side, DNS-pinned).",
};

// ---------------------------------------------------------------------------
// Pure emitters.
// ---------------------------------------------------------------------------

/** Whether a tool returns a `ResultRef` (the high-volume / materialized set). */
function returnsResultRef(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(RESULT_REF_THRESHOLDS, tool);
}

/** The one-line summary for the discovery surface (bespoke or capability-derived). */
function summaryFor(tool: string, capability: string): string {
  return TOOL_SUMMARIES[tool] ?? `A ${capability} tool.`;
}

/** The shared SPDX + AUTOGENERATED + eslint-disable header (mirrors the web artifact). */
function header(): string {
  return `// SPDX-License-Identifier: Apache-2.0
/* AUTOGENERATED — do not edit. Run \`pnpm sdk:generate\`. */
/* eslint-disable */
`;
}

/**
 * Emit the `.d.ts` typed contract. `sortedTools` is the single-sort-point
 * tool-name list; each tool becomes one typed async method, and the
 * high-volume set is typed to return a `ResultRef`.
 */
function emitSdkDts(sortedTools: readonly string[]): string {
  const resultRefType = `
// ---------------------------------------------------------------------------
// ResultRef — a handle to a high-volume tool return materialized on the jailed
// workspace (v8 §23.9). The big (untrusted) payload stays on disk as DATA;
// only this handle re-enters context. Slice it IN-JAIL via the extraction
// methods so just the relevant rows/lines come back (REF-01/02).
// ---------------------------------------------------------------------------

export interface ResultRef {
  /** Workspace-relative path, e.g. "results/abc.jsonl". */
  readonly ref: string;
  /** The materialized content kind. */
  readonly kind: "jsonl" | "json" | "csv" | "html" | "text" | "binary";
  /** Total materialized size in bytes. */
  readonly bytes: number;
  /** Row count for tabular kinds (jsonl/csv), when known. */
  readonly rows?: number;
  /** Column/field names for tabular kinds, when known. */
  readonly schema?: string[];
  /** A tiny bounded head of the content (rides the handle into context). */
  readonly preview: string;
  /** ISO-8601 expiry — the run-GC evicts the file after this. */
  readonly expiresAt: string;
  /** Grep the materialized file for \`pattern\`; returns the matching lines. */
  grep(pattern: string): Promise<string>;
  /** Run a jq \`expr\` over the materialized JSON/JSONL; returns the result. */
  jq(expr: string): Promise<unknown>;
  /** Run DuckDB SQL over the materialized CSV/JSONL/JSON; returns the row slice. */
  sql(query: string): Promise<unknown>;
  /** Extract a precise value via a JSONPath \`$\`-expr (DuckDB json_extract, no eval). */
  jsonpath(expr: string): Promise<unknown>;
  /** Read a slice of the materialized file (\`offset\`/\`limit\` lines or bytes). */
  read(offset?: number, limit?: number): Promise<string>;
}

/** A discovery entry returned by \`comis_tools.describe()\` (the small surface). */
export interface ToolDescriptor {
  /** The tool name (the method on \`comis_tools\`). */
  readonly name: string;
  /** The capability the tool requires (the cap-map classification). */
  readonly capability: string;
  /** A one-line human summary of what the tool does. */
  readonly summary: string;
}
`;

  // One typed method per tool. High-volume tools → Promise<ResultRef>; the rest
  // → Promise<unknown> (the minimal M1 surface; per-tool result types are an
  // M2 enrichment — the discovery surface + the ResultRef typing are the win).
  const methodLines: string[] = [];
  for (const tool of sortedTools) {
    const capability = TOOL_CAPABILITY_MAP[tool as keyof typeof TOOL_CAPABILITY_MAP];
    const ret = returnsResultRef(tool) ? "Promise<ResultRef>" : "Promise<unknown>";
    const summary = summaryFor(tool, capability);
    methodLines.push(`  /** ${summary} (capability: ${capability}) */`);
    methodLines.push(`  ${tool}(args?: Record<string, unknown>): ${ret};`);
  }

  const iface = `
// ---------------------------------------------------------------------------
// ComisTools — the typed SDK surface. One async method per capability-mapped
// tool (generated from TOOL_CAPABILITY_MAP). \`describe()\` is the progressive-
// disclosure discovery surface (names + summaries + capability).
// ---------------------------------------------------------------------------

export interface ComisTools {
  /**
   * The discovery surface: list every available tool with its capability and a
   * one-line summary, so the surface is cheap to enumerate before reaching for
   * a specific tool's full types.
   */
  describe(): ToolDescriptor[];
${methodLines.join("\n")}
}

/** The singleton typed SDK the jailed script imports. */
export declare const comis_tools: ComisTools;
export default comis_tools;
`;

  return header() + resultRefType + iface;
}

/**
 * Emit the thin `.js` runtime. Each method delegates to the stable
 * `./orchestrate-sdk-runtime.js` shim; high-volume returns are
 * wrapped so the ResultRef carries its `.grep/.jq/.read`. `describe()` returns
 * the static discovery list emitted from the cap-map.
 */
function emitSdkJs(sortedTools: readonly string[]): string {
  const importLine = `import { invoke, wrapResultRef } from "./orchestrate-sdk-runtime.js";\n`;

  // The static discovery list (cap + summary per tool) — 2-space indented JSON.
  const descriptors = sortedTools.map((tool) => {
    const capability = TOOL_CAPABILITY_MAP[tool as keyof typeof TOOL_CAPABILITY_MAP];
    return { name: tool, capability, summary: summaryFor(tool, capability) };
  });
  const descriptorsJson = JSON.stringify(descriptors, null, 2);

  const methodLines: string[] = [];
  for (const tool of sortedTools) {
    if (returnsResultRef(tool)) {
      methodLines.push(
        `  async ${tool}(args) {\n` +
          `    return wrapResultRef(await invoke(${JSON.stringify(tool)}, args));\n` +
          `  },`,
      );
    } else {
      methodLines.push(
        `  async ${tool}(args) {\n` +
          `    return invoke(${JSON.stringify(tool)}, args);\n` +
          `  },`,
      );
    }
  }

  const body = `
// ---------------------------------------------------------------------------
// The discovery surface (progressive disclosure) + one delegating method per
// capability-mapped tool. Each method sends a single \`tool.invoke\` over the
// cap socket via the runtime shim; high-volume returns are wrapped as a
// ResultRef with in-jail extraction.
// ---------------------------------------------------------------------------

const DESCRIPTORS = ${descriptorsJson};

export const comis_tools = {
  describe() {
    return DESCRIPTORS;
  },
${methodLines.join("\n")}
};

export default comis_tools;
`;

  return header() + importLine + body;
}

// ---------------------------------------------------------------------------
// runCodegen — emit + write + return (mirrors generate-web-artifact.ts:102).
// ---------------------------------------------------------------------------

/**
 * Run the SDK codegen against `TOOL_CAPABILITY_MAP` and write the two
 * artifacts. Returns the produced strings so the drift test compares
 * in-memory == disk without re-reading. `outDir` defaults to the committed
 * `packages/skills/.../orchestrate/` directory so the CLI + `pnpm sdk:generate`
 * write the real artifacts; the drift test passes a temp dir to avoid touching
 * (or racing on) the committed files (mirrors the web-contract codegen rationale).
 */
export function runCodegen(outDir: string = COMMITTED_DIR): SdkCodegenResult {
  // 1. THE single sort point — alphabetical over the cap-map tool names so the
  //    emit is stable regardless of source declaration order.
  const sortedTools = Object.keys(TOOL_CAPABILITY_MAP).sort((a, b) => a.localeCompare(b));

  // Cross-check completeness: every cap-mapped tool has a route (the cap-map
  // module-load assertion already guarantees this, but assert here too so a
  // codegen run fails loud rather than emitting a half-surface).
  for (const tool of sortedTools) {
    if (!(tool in TOOL_ROUTE_MAP)) {
      throw new Error(
        `generate-comis-tools-sdk: "${tool}" is in TOOL_CAPABILITY_MAP but missing from TOOL_ROUTE_MAP — ` +
          `the SDK surface and the dispatch routing must stay in lockstep.`,
      );
    }
  }

  // 2-3. Emit both artifacts (POSIX trailing newline already in the templates).
  const dts = emitSdkDts(sortedTools);
  const js = emitSdkJs(sortedTools);

  // 4. Write both into outDir. The path is build-tool-internal, not
  //    attacker-controlled — same sanctioned dynamic-fs pattern the web codegen
  //    uses (generate-web-artifact.ts:146,150).
  const outDts = resolve(outDir, ARTIFACT_DTS);
  const outJs = resolve(outDir, ARTIFACT_JS);
  writeFileSync(outDts, dts); // eslint-disable-line security/detect-non-literal-fs-filename
  writeFileSync(outJs, js); // eslint-disable-line security/detect-non-literal-fs-filename

  return { dts, js };
}

/**
 * CLI entry point. Runs `runCodegen`, prints a one-line summary.
 */
function main(): void {
  runCodegen();
  const n = Object.keys(TOOL_CAPABILITY_MAP).length;
  console.log(
    `Generated comis_tools SDK: ${n} cap-mapped tools → ${ARTIFACT_DTS} + ${ARTIFACT_JS}`,
  );
}

// Run when invoked as a script (the typical `npx tsx` / `pnpm sdk:generate`
// path). Avoid running when this module is imported (e.g., by the drift test).
const isMainModule = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isMainModule) {
  main();
}
