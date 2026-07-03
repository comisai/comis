// SPDX-License-Identifier: Apache-2.0
/**
 * Codegen entry point: produces the committed `comis_tools` SDK
 * (`packages/skills/src/tools/builtin/orchestrate/comis_tools.{d.ts,js,py}`)
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
 *   4. Emit the single self-contained `.py` binding: the cap-socket wire
 *      inlined as a stdlib-only preamble (a Python module cannot import the
 *      hyphenated `orchestrate-sdk-runtime` shim, so the wire is inlined here
 *      and the drift gate byte-locks it too) plus one module-level function per
 *      cap-mapped tool. Parity by construction — the SAME sorted cap-map.
 *   5. `writeFileSync` all three into `outDir`, AND return the three strings so
 *      the drift test can compare in-memory == disk without re-reading.
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
export const OUT_PY = resolve(COMMITTED_DIR, "comis_tools.py");

/** Artifact filenames (constant across output dirs; tests redirect via `outDir`). */
const ARTIFACT_DTS = "comis_tools.d.ts";
const ARTIFACT_JS = "comis_tools.js";
const ARTIFACT_PY = "comis_tools.py";

// ---------------------------------------------------------------------------
// Codegen result — returned by runCodegen so the drift test compares the
// in-memory strings against the freshly-written disk bytes.
// ---------------------------------------------------------------------------

export interface SdkCodegenResult {
  /** The `.d.ts` typed-contract source written to comis_tools.d.ts. */
  readonly dts: string;
  /** The thin `.js` runtime source written to comis_tools.js. */
  readonly js: string;
  /** The single self-contained `.py` binding written to comis_tools.py. */
  readonly py: string;
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
// One worked example per capability GROUP (a distinct value in
// TOOL_CAPABILITY_MAP). Keyed by capability so every tool in a group shares the
// same calling-pattern demo — a small model sees how to CHAIN the tools (a
// ResultRef sliced in-jail), not just each method's signature. A capability
// absent here falls back to a generic line, so adding a cap never breaks the
// build. String-only values keep the emitted JSON a valid Python literal too.
// ---------------------------------------------------------------------------

const CAPABILITY_GROUP_EXAMPLES: Record<string, string> = {
  "orch:read":
    "const ref = await comis_tools.grep({ path: 'logs/app.jsonl', pattern: 'ERROR' }); const rows = await ref.jq('.[0:20]'); const head = await ref.read(0, 40);",
  "orch:web":
    "const hits = await comis_tools.web_search({ query: 'site reliability' }); const top3 = await hits.jq('.[0:3]'); const page = await comis_tools.web_fetch({ url: top3[0].url }); const text = await page.read(0, 200);",
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

/** The worked calling-pattern example for the discovery surface, keyed by capability group. */
function exampleFor(capability: string): string {
  return CAPABILITY_GROUP_EXAMPLES[capability] ?? `See describe() for a ${capability} tool.`;
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
  /** A worked calling-pattern example for the tool's capability group. */
  readonly example: string;
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
    methodLines.push(`  /** ${summary} (capability: ${capability}) Example: ${exampleFor(capability)} */`);
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
    return { name: tool, capability, summary: summaryFor(tool, capability), example: exampleFor(capability) };
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
// Python emitter. The `.py` is a SINGLE self-contained file: a Python module
// cannot import the hyphenated `orchestrate-sdk-runtime` shim the JS SDK
// delegates to, so the invariant cap-socket wire is inlined here as a fixed
// stdlib-only preamble (which means the drift gate byte-locks the wire too),
// with one module-level function per cap-mapped tool. Blocking stdlib `socket`
// is correct for a one-shot jailed script (no event loop), so the API is sync.
// ---------------------------------------------------------------------------

/** The `#`-leader SPDX + AUTOGENERATED header (the Python analog of `header()`). */
function pyHeader(): string {
  return `# SPDX-License-Identifier: Apache-2.0
# AUTOGENERATED — do not edit. Run \`pnpm sdk:generate\`.
`;
}

/**
 * The inlined cap-socket wire — a byte-faithful port of
 * `orchestrate-sdk-runtime.ts` (`callCapSocket` + `invoke`). Stdlib
 * `json`/`os`/`socket` only (the jailed interpreter has no site-packages
 * beyond the RO-bound host stdlib). Newline-delimited JSON, NOT length-prefixed
 * (a framed client would hang the endpoint); `json.dumps(separators=(",",":"))`
 * mirrors `JSON.stringify`; the absent-env error and the malformed/closed-line
 * faults match the JS honesty (a containment fault is never a silent success).
 */
const PY_WIRE_PREAMBLE = `
import json
import os
import socket

_ENV_SOCK = "COMIS_ORCH_SOCKET"
_ENV_LEASE = "COMIS_CAP_LEASE"


def _call_cap_socket(method, params):
    sock_path = os.environ.get(_ENV_SOCK)
    bearer = os.environ.get(_ENV_LEASE)
    if not sock_path or not bearer:
        raise RuntimeError(
            "comis-agent / orchestrate runtime requires "
            "COMIS_ORCH_SOCKET/COMIS_CAP_LEASE — only valid inside an orchestrate jail"
        )
    payload = (
        json.dumps(
            {"bearer": bearer, "method": method, "params": params},
            separators=(",", ":"),
        )
        + "\\n"
    )
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(sock_path)
        sock.sendall(payload.encode("utf-8"))
        buf = b""
        while b"\\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                raise RuntimeError("cap socket closed before a complete response line")
            buf += chunk
    finally:
        sock.close()
    reply = json.loads(buf.split(b"\\n", 1)[0].decode("utf-8"))
    if reply.get("error") is not None:
        err = reply["error"]
        raise RuntimeError(err if isinstance(err, str) else "capability call failed")
    return reply.get("result")


def _invoke(tool, args=None):
    return _call_cap_socket("tool.invoke", {"tool": tool, "args": args or {}})
`;

/**
 * The `ResultRef` class — a port of `wrapResultRef`. The five extraction
 * methods route back over the same wire via `_invoke`, so a big (untrusted)
 * payload stays materialized on disk and only the requested slice re-enters
 * context. `read` omits `offset`/`limit` when `None` (mirrors the JS
 * undefined-drop). `_wrap_result_ref(ref)` returns `ResultRef(ref)`.
 */
const PY_RESULTREF_CLASS = `

class ResultRef:
    """A handle to a high-volume tool return materialized on the jailed workspace.

    The big (untrusted) payload stays on disk as data; only this handle
    re-enters context. Slice it in-jail via grep/jq/sql/jsonpath/read so only
    the requested rows/lines re-enter -- the full payload never does.
    """

    def __init__(self, ref):
        raw = ref if isinstance(ref, dict) else {}
        self.ref = raw.get("ref")
        self.kind = raw.get("kind")
        self.bytes = raw.get("bytes")
        self.rows = raw.get("rows")
        self.schema = raw.get("schema")
        self.preview = raw.get("preview")
        self.expires_at = raw.get("expiresAt")

    def grep(self, pattern):
        return _invoke("grep", {"path": self.ref, "pattern": pattern})

    def jq(self, expr):
        return _invoke("jq", {"path": self.ref, "expr": expr})

    def sql(self, query):
        return _invoke("sql", {"path": self.ref, "query": query})

    def jsonpath(self, expr):
        return _invoke("jsonpath", {"path": self.ref, "expr": expr})

    def read(self, offset=None, limit=None):
        params = {"path": self.ref}
        if offset is not None:
            params["offset"] = offset
        if limit is not None:
            params["limit"] = limit
        return _invoke("read", params)


def _wrap_result_ref(ref):
    return ResultRef(ref)
`;

/**
 * Emit the single self-contained `.py` binding. Reuses the SAME sorted tool
 * list, `returnsResultRef`, `summaryFor`, and `TOOL_SUMMARIES` as the JS/dts
 * emitters (parity by construction). `describe()` renders the SAME
 * `{name,capability,summary}` list via the SAME `JSON.stringify(..., 2)` — all
 * values are strings, so the emitted JSON is also a valid Python literal.
 */
function emitSdkPy(sortedTools: readonly string[]): string {
  // The static discovery list (cap + summary per tool) — the identical shape +
  // 2-space JSON the JS SDK emits; string-only values make it a Python literal.
  const descriptors = sortedTools.map((tool) => {
    const capability = TOOL_CAPABILITY_MAP[tool as keyof typeof TOOL_CAPABILITY_MAP];
    return { name: tool, capability, summary: summaryFor(tool, capability), example: exampleFor(capability) };
  });
  const descriptorsJson = JSON.stringify(descriptors, null, 2);

  // One module-level function per tool; the high-volume set wraps its return in
  // a ResultRef exactly like the JS SDK's wrapResultRef branch.
  const methods: string[] = [];
  for (const tool of sortedTools) {
    const call = returnsResultRef(tool)
      ? `_wrap_result_ref(_invoke(${JSON.stringify(tool)}, args))`
      : `_invoke(${JSON.stringify(tool)}, args)`;
    methods.push(`def ${tool}(args=None):\n    return ${call}`);
  }

  return (
    pyHeader() +
    PY_WIRE_PREAMBLE +
    PY_RESULTREF_CLASS +
    "\nDESCRIPTORS = " +
    descriptorsJson +
    "\n\ndef describe():\n    return DESCRIPTORS\n\n" +
    methods.join("\n\n") +
    "\n"
  );
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

  // 2-4. Emit all three artifacts (POSIX trailing newline already in the templates).
  const dts = emitSdkDts(sortedTools);
  const js = emitSdkJs(sortedTools);
  const py = emitSdkPy(sortedTools);

  // 5. Write all three into outDir. The path is build-tool-internal, not
  //    attacker-controlled — same sanctioned dynamic-fs pattern the web codegen
  //    uses (generate-web-artifact.ts:146,150).
  const outDts = resolve(outDir, ARTIFACT_DTS);
  const outJs = resolve(outDir, ARTIFACT_JS);
  const outPy = resolve(outDir, ARTIFACT_PY);
  writeFileSync(outDts, dts); // eslint-disable-line security/detect-non-literal-fs-filename
  writeFileSync(outJs, js); // eslint-disable-line security/detect-non-literal-fs-filename
  writeFileSync(outPy, py); // eslint-disable-line security/detect-non-literal-fs-filename

  return { dts, js, py };
}

/**
 * CLI entry point. Runs `runCodegen`, prints a one-line summary.
 */
function main(): void {
  runCodegen();
  const n = Object.keys(TOOL_CAPABILITY_MAP).length;
  console.log(
    `Generated comis_tools SDK: ${n} cap-mapped tools → ${ARTIFACT_DTS} + ${ARTIFACT_JS} + ${ARTIFACT_PY}`,
  );
}

// Run when invoked as a script (the typical `npx tsx` / `pnpm sdk:generate`
// path). Avoid running when this module is imported (e.g., by the drift test).
const isMainModule = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isMainModule) {
  main();
}
