// SPDX-License-Identifier: Apache-2.0
// @allow-throw: none — every failure branch returns an error-SHAPED object the
// daemon executor forwards to the jailed client (mirrors web-fetch-tool.ts's
// honest-degrade). The `jq`/`sql`/`jsonpath` binary-absent, rejected-query, and
// non-zero-exit paths return `{ error }`, never throw, so a jailed SDK call
// surfaces a content-free error rather than crashing the executor.
/**
 * `orchestrate-executor-cores` — the SHIPPED in-process tool cores the
 * daemon-side `tool.invoke` executor (Phase 212 Plan 02,
 * `setup-tool-invoke-executor.ts`) routes the 5 file builtins + `web_search` to
 * (Gap 1; v8 §6.2/§6.3). Plan 02 left the cores as INJECTED deps (mocked in its
 * tests); Plan 05's dormancy activation wires the real ones — and they live HERE
 * (skills) so the daemon imports ONE factory over a published subpath rather
 * than reaching into the file-tools / web-search internals it must not depend on.
 *
 * Two core classes:
 *   - FILE builtins (`read`/`grep`/`find`/`ls`): adapt the SHIPPED
 *     `createComis{Read,Grep,Find,Ls}Tool` AgentTools — constructed per call under
 *     the lease's resolved `workspaceDir` (the executor passes it in `ctx`), then
 *     `.execute()`d. Read-only by construction (no `edit`/`write` core surfaced).
 *     The `AgentToolResult` it returns is the value the jailed SDK receives over
 *     the cap socket; high-volume returns are offloaded to a `ResultRef` by the
 *     executor's `materialize` seam (REF-01), not here.
 *   - `jq`/`sql`/`jsonpath` (READ-02 / QRY-01 / QRY-02): the in-jail ResultRef
 *     query engine. The jailed script's `wrapResultRef(...).jq(expr)` /
 *     `.sql(query)` / `.jsonpath(expr)` sends `tool.invoke("jq"|"sql"|"jsonpath",
 *     {path, …})`; each core resolves the workspace-confined file (`safePath`,
 *     AGENTS §2.2 — never `path.join` on a caller-influenced segment) and runs a
 *     daemon-side binary over it (`execFile`, no shell), returning only the
 *     requested slice. `jq` runs the system `jq`; `sql`/`jsonpath` run the system
 *     `duckdb` HARDENED (`--readonly :memory:`, autoload/autoinstall OFF, and the
 *     model query screened by `rejectDangerousSql` — INSTALL/LOAD/ATTACH/COPY/
 *     EXPORT/PRAGMA + http(s)/s3/gcs url-readers are refused BEFORE spawn) so the
 *     un-jailed daemon-side DuckDB can never become an SSRF/exfil/file-write
 *     egress (T-221-QRY-01..06). `jsonpath` does NOT add an eval-based JSONPath
 *     library (those are banned by AGENTS.md §2.2 and have live RCE CVEs); it
 *     compiles the `$`-dot/bracket path into a DuckDB `json_extract` query and
 *     runs it through the SAME hardened `duckdb` invocation as `sql`. A binary
 *     absent, a rejected query, or a non-zero exit honest-degrades to `{ error }`
 *     (never a throw) — `jq`/`duckdb` are host tools the VPS/Linux jail provides
 *     (the docs assume them; the `sql` core honest-degrades with
 *     `errorKind:"precondition"` if `duckdb` is absent, since it is not in
 *     Debian's apt repos and is provisioned as a pinned static binary). The real
 *     in-jail proof is the VPS-deferred `orchestrate-jail.linux.test.ts`.
 *
 * `web_search` (WEB-01): adapts the SHIPPED `createWebSearchTool` (constructed
 * ONCE) — the daemon-side network search the jailed (`--unshare-net`) script
 * cannot run itself. The DNS-pin lives on the `web_fetch` path inside the
 * executor (Plan 02); `web_search` rides the shipped multi-provider tool.
 *
 * @module
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { execFile } from "node:child_process";
import { safePath, systemNowMs, type ComisLogger } from "@comis/core";
import { createComisReadTool } from "../file-tools/read-tool.js";
import { createComisGrepTool } from "../file-tools/grep-tool.js";
import { createComisFindTool } from "../file-tools/find-tool.js";
import { createComisLsTool } from "../file-tools/ls-tool.js";
import { createWebSearchTool } from "../web-search-tool/index.js";
import type { WebSearchConfig } from "../web-search-tool/web-search-providers.js";

/** The workspace ctx the daemon executor hands each file core (its scoped root). */
export interface OrchestrateFileCoreContext {
  /** The lease-resolved workspace root; every path is confined under it. */
  readonly workspaceDir: string;
}

/** A file core the executor calls: `(args, ctx) => result` over the workspace. */
export type OrchestrateFileCore = (
  args: Record<string, unknown>,
  ctx: OrchestrateFileCoreContext,
) => Promise<unknown>;

/**
 * The seven `{kind:"executor"}` file cores: the four read builtins
 * (read/grep/find/ls), and the three ResultRef slicers (jq, plus the QRY query
 * engine `sql`/`jsonpath`). All run DAEMON-side over the run-scoped workspace.
 */
export interface OrchestrateFileCores {
  read: OrchestrateFileCore;
  grep: OrchestrateFileCore;
  find: OrchestrateFileCore;
  ls: OrchestrateFileCore;
  jq: OrchestrateFileCore;
  /** QRY-01: DuckDB SQL over a CSV/JSONL/JSON ResultRef (daemon-side, hardened). */
  sql: OrchestrateFileCore;
  /** QRY-02: precise JSON extraction via DuckDB `json_extract` (NO eval lib). */
  jsonpath: OrchestrateFileCore;
}

/** A daemon-side web-search core: `(args, ctx) => result` (the jail can't fetch). */
export type OrchestrateWebSearchCore = (
  args: Record<string, unknown>,
  ctx: { agentId: string },
) => Promise<unknown>;

/** The shipped cores the daemon executor consumes (file builtins + web search). */
export interface OrchestrateExecutorCores {
  fileExecutors: OrchestrateFileCores;
  webSearch: OrchestrateWebSearchCore;
}

/** Deps for {@link createOrchestrateExecutorCores} (DI — AGENTS §2.4). */
export interface OrchestrateExecutorCoresDeps {
  /** Structured logger — instruments the jq/sql/jsonpath spawn boundary + degrade branches. */
  readonly logger: ComisLogger;
  /** Optional web-search provider config (the shipped tool's config). Absent → keyless/default chain. */
  readonly webSearchConfig?: WebSearchConfig;
  /** Max wall-clock for a single `jq` spawn (ms). Default 10s. */
  readonly jqTimeoutMs?: number;
  /** Max wall-clock for a single `duckdb` spawn (ms, used by sql/jsonpath). Default 10s. */
  readonly sqlTimeoutMs?: number;
}

/** An error-shaped honest-degrade (mirrors web-fetch-tool.ts:218-223). */
function errorResult(error: string): { error: string } {
  return { error };
}

const DEFAULT_JQ_TIMEOUT_MS = 10_000;
/** Bound the captured jq stdout so a huge slice cannot blow the daemon's heap. */
const JQ_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

const DEFAULT_SQL_TIMEOUT_MS = 10_000;
/** Bound the captured duckdb stdout so a huge slice cannot blow the daemon's heap. */
const SQL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Disable DuckDB extension auto-install / auto-load on EVERY `-c` payload. The
 * extension auto-installer is the one path in `--readonly :memory:` that touches
 * the network (a remote extension fetch); turning both off closes it (A2 /
 * Q-QRY-1). Prepended before the model query in `runDuckDb`.
 */
const DUCKDB_HARDENING_PRELUDE =
  "SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; ";

/**
 * Statement keywords that let DuckDB install an extension, load one, attach an
 * external database, or read/write a file/URL outside the confined `results/`
 * input — the daemon-side SSRF / exfil / file-write surface (T-221-QRY-01). The
 * query engine is a read-only slicer; ANY of these in a model-supplied query is
 * refused BEFORE `duckdb` is ever spawned. Matched as whole words, case-insensitive.
 */
const DANGEROUS_SQL_KEYWORDS = [
  "INSTALL",
  "LOAD",
  "ATTACH",
  "DETACH",
  "COPY",
  "EXPORT",
  "IMPORT",
  "PRAGMA",
] as const;

/**
 * URL-reader scheme prefixes DuckDB's `read_*`/httpfs can reach off-host. Even
 * with autoload off + readonly, a literal `http(s)://` / `s3://` / `gcs://` /
 * `azure://` inside a reader is a remote-fetch attempt — refuse it (defense in
 * depth alongside the extension lockdown). Matched as a case-insensitive substring.
 */
const DANGEROUS_URL_SCHEMES = ["http://", "https://", "s3://", "gcs://", "gs://", "azure://"] as const;

/**
 * Screen a model-supplied DuckDB query for the extension / file-write / network
 * verbs and url-readers a read-only slicer must never run (T-221-QRY-01). Pure —
 * returns a human reason on the FIRST hit, or `null` when the query is safe to
 * spawn. Called BEFORE `execFile` so a malicious query NEVER reaches `duckdb`.
 *
 * @param query - The model-supplied SQL (already path-confined at the core).
 * @returns A rejection reason string, or `null` if the query is allowed.
 */
export function rejectDangerousSql(query: string): string | null {
  const upper = query.toUpperCase();
  for (const kw of DANGEROUS_SQL_KEYWORDS) {
    // Whole-word match so `INSTALLED_AT` (a column) does not trip on `INSTALL`.
    // \b handles the surrounding punctuation/space DuckDB statements use.
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return `sql rejected: the \`${kw}\` statement is not allowed on the read-only query surface`;
    }
  }
  const lower = query.toLowerCase();
  for (const scheme of DANGEROUS_URL_SCHEMES) {
    if (lower.includes(scheme)) {
      return `sql rejected: remote url readers (${scheme}…) are not allowed — the query may only read the run-scoped results/ file`;
    }
  }
  return null;
}

/**
 * A safe JSONPath expression for the `jsonpath` core: a `$`-rooted dot/bracket
 * path of identifiers and numeric indices only — e.g. `$.items[0].price`,
 * `$['a']['b']`, `$`. Deliberately conservative: NO wildcards, filters, slices,
 * functions, or quotes-with-metacharacters, so the compiled `json_extract` path
 * literal can never carry SQL/quote injection into the DuckDB statement.
 */
const SAFE_JSONPATH_RE = /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\['[A-Za-z0-9_ -]+'\]|\["[A-Za-z0-9_ -]+"\])*$/;

/**
 * Validate a model-supplied JSONPath expression for the `jsonpath` core. Pure —
 * returns `true` only for the conservative `$`-rooted dot/bracket grammar above.
 * A `false` is honest-degraded to `{ error }` by the core (never a throw). This
 * is the no-eval safety floor: the expression becomes a `json_extract(j, '<expr>')`
 * literal, so it must contain no SQL metacharacters / unmatched quotes.
 *
 * @param expr - The model-supplied JSONPath.
 * @returns `true` if the expression is a safe dot/bracket path, else `false`.
 */
export function isSafeJsonPath(expr: string): boolean {
  return SAFE_JSONPATH_RE.test(expr);
}

/**
 * Build the shipped daemon-side cores for the orchestrate `tool.invoke` executor.
 * See the module doc for the per-core composition + the jq containment.
 */
export function createOrchestrateExecutorCores(
  deps: OrchestrateExecutorCoresDeps,
): OrchestrateExecutorCores {
  const log = deps.logger.child({ submodule: "orchestrate-executor-cores" });
  const jqTimeoutMs = deps.jqTimeoutMs ?? DEFAULT_JQ_TIMEOUT_MS;
  const sqlTimeoutMs = deps.sqlTimeoutMs ?? DEFAULT_SQL_TIMEOUT_MS;

  // The shipped web-search tool is multi-provider + cache-bearing — construct it
  // ONCE (the cache is module-level + factory-shared).
  const webSearchTool = createWebSearchTool(deps.webSearchConfig);

  /**
   * Adapt a SHIPPED file-tool factory into an {@link OrchestrateFileCore}: build
   * the AgentTool under `ctx.workspaceDir` (path-confined by the factory's own
   * `safePath` wrapping) and `.execute()` it. Per-call construction is cheap
   * (no I/O at build) and keeps each call scoped to the lease's workspace.
   */
  function fileCore(
    factory: (workspacePath: string) => AgentTool<never>,
    toolName: string,
  ): OrchestrateFileCore {
    return async (args, ctx) => {
      const started = systemNowMs();
      const tool = factory(ctx.workspaceDir);
      const result: AgentToolResult<unknown> = await tool.execute("tool.invoke", args as never);
      log.debug(
        { step: "file-core", toolName, durationMs: systemNowMs() - started },
        "orchestrate file core executed",
      );
      return result;
    };
  }

  /**
   * The `jq` core (READ-02): resolve the workspace-confined path and run the
   * system `jq` over it (no shell — `execFile`). Returns the parsed slice, or a
   * content-free `{ error }` on a bad path / missing binary / non-zero exit.
   */
  const jq: OrchestrateFileCore = async (args, ctx) => {
    const started = systemNowMs();
    const rawPath = typeof args.path === "string" ? args.path : "";
    const expr = typeof args.expr === "string" ? args.expr : ".";
    if (rawPath === "") {
      log.warn(
        { errorKind: "validation" as const, hint: "jq called without a string `path` to a results/ file", toolName: "jq" },
        "orchestrate jq missing path",
      );
      return errorResult("jq requires a string `path`");
    }
    // Confine the path under the workspace (the ResultRef ref is workspace-relative).
    let absPath: string;
    try {
      absPath = safePath(ctx.workspaceDir, rawPath);
    } catch (err: unknown) {
      log.warn(
        { err, errorKind: "validation" as const, hint: "jq path escaped the workspace — refusing", toolName: "jq" },
        "orchestrate jq path traversal blocked",
      );
      return errorResult("jq path escapes the workspace");
    }
    log.debug({ step: "jq-spawn", toolName: "jq" }, "orchestrate jq spawning");
    return await new Promise<unknown>((resolve) => {
      execFile(
        "jq",
        // `--compact-output` so the slice is line-bounded JSON; `--` ends options
        // so a hostile `expr` cannot be read as a flag. The path is the confined
        // absolute path (validated above), never the caller's raw segment.
        ["--compact-output", "--", expr, absPath],
        { timeout: jqTimeoutMs, maxBuffer: JQ_MAX_BUFFER_BYTES, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const missing = code === "ENOENT";
            log.warn(
              {
                err,
                errorKind: missing ? ("precondition" as const) : ("validation" as const),
                hint: missing
                  ? "the `jq` binary is not installed on the host — install jq to slice ResultRefs in-jail"
                  : "jq exited non-zero (a bad filter or non-JSON input)",
                toolName: "jq",
              },
              "orchestrate jq failed",
            );
            resolve(
              errorResult(
                missing ? "jq is not installed on the host" : `jq error: ${stderr.trim() || "non-zero exit"}`,
              ),
            );
            return;
          }
          log.debug(
            { step: "jq-done", toolName: "jq", durationMs: systemNowMs() - started },
            "orchestrate jq complete",
          );
          // Return the raw compact-JSON text — the in-jail SDK parses it. (We do
          // not JSON.parse here: a jq stream of multiple values is not a single
          // JSON document, so the text slice is the honest return.)
          resolve(stdout);
        },
      );
    });
  };

  /**
   * Run a model-supplied DuckDB query (already screened by `rejectDangerousSql` /
   * `isSafeJsonPath` at the calling core) through the HARDENED CLI and resolve the
   * JSON-rows slice (or a content-free `{ error }`). `--readonly :memory:` (no DB
   * file / no writes), `-json` (rows on stdout), `-c` (one statement) with the
   * autoload-off prelude prepended. A missing `duckdb` binary →
   * `errorKind:"precondition"` (the install prerequisite is unmet); a non-zero
   * exit (bad SQL / non-table input) → `errorKind:"validation"`. Never throws —
   * mirrors the jq ENOENT/non-zero branches.
   */
  function runDuckDb(query: string, toolName: "sql" | "jsonpath", started: number): Promise<unknown> {
    log.debug({ step: "duckdb-spawn", toolName }, "orchestrate duckdb spawning");
    return new Promise<unknown>((resolve) => {
      execFile(
        "duckdb",
        ["--readonly", ":memory:", "-json", "-c", DUCKDB_HARDENING_PRELUDE + query],
        { timeout: sqlTimeoutMs, maxBuffer: SQL_MAX_BUFFER_BYTES, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const missing = code === "ENOENT";
            log.warn(
              {
                err,
                errorKind: missing ? ("precondition" as const) : ("validation" as const),
                hint: missing
                  ? "the `duckdb` binary is not installed on the host — install duckdb (pinned static binary) to run SQL/JSONPath over ResultRefs"
                  : "duckdb exited non-zero (bad SQL or non-table input)",
                toolName,
              },
              "orchestrate duckdb failed",
            );
            resolve(
              errorResult(
                missing
                  ? "duckdb is not installed on the host"
                  : `duckdb error: ${stderr.trim() || "non-zero exit"}`,
              ),
            );
            return;
          }
          log.debug(
            { step: "duckdb-done", toolName, durationMs: systemNowMs() - started },
            "orchestrate duckdb complete",
          );
          // Return the raw `-json` rows text — the in-jail SDK parses it (mirrors jq).
          resolve(stdout);
        },
      );
    });
  }

  /**
   * The `sql` core (QRY-01): run a model-supplied DuckDB query over the
   * workspace-confined ResultRef file. Path-confined (`safePath`), then screened
   * (`rejectDangerousSql` — INSTALL/LOAD/ATTACH/COPY/EXPORT/url-readers refused
   * BEFORE any spawn, the SSRF/exfil floor), then run through the hardened
   * `runDuckDb`. Returns the JSON-rows slice, or a content-free `{ error }`.
   */
  const sql: OrchestrateFileCore = async (args, ctx) => {
    const started = systemNowMs();
    const rawPath = typeof args.path === "string" ? args.path : "";
    const query = typeof args.query === "string" ? args.query : "";
    if (rawPath === "") {
      log.warn(
        { errorKind: "validation" as const, hint: "sql called without a string `path` to a results/ file", toolName: "sql" },
        "orchestrate sql missing path",
      );
      return errorResult("sql requires a string `path`");
    }
    if (query === "") {
      log.warn(
        { errorKind: "validation" as const, hint: "sql called without a string `query`", toolName: "sql" },
        "orchestrate sql missing query",
      );
      return errorResult("sql requires a string `query`");
    }
    // Confine the path under the workspace (the ResultRef ref is workspace-relative).
    try {
      safePath(ctx.workspaceDir, rawPath);
    } catch (err: unknown) {
      log.warn(
        { err, errorKind: "validation" as const, hint: "sql path escaped the workspace — refusing", toolName: "sql" },
        "orchestrate sql path traversal blocked",
      );
      return errorResult("sql path escapes the workspace");
    }
    // Screen the model query for extension / file-write / network verbs + url
    // readers BEFORE spawning duckdb (T-221-QRY-01) — refuse, never spawn, on a hit.
    const rejection = rejectDangerousSql(query);
    if (rejection !== null) {
      log.warn(
        { errorKind: "validation" as const, hint: "sql query contained a disallowed extension/file-write/network verb or url-reader — refusing before spawn", toolName: "sql" },
        "orchestrate sql dangerous query blocked",
      );
      return errorResult(rejection);
    }
    return await runDuckDb(query, "sql", started);
  };

  /**
   * The `jsonpath` core (QRY-02): extract a precise value from a JSON ResultRef
   * via DuckDB `json_extract` — NO eval-based JSONPath library (banned, RCE CVEs).
   * Path-confined (`safePath`), the expr validated to a conservative `$`-dot/bracket
   * grammar (`isSafeJsonPath`) so it carries no SQL/quote injection, then compiled
   * into a `json_extract` query run through the SAME hardened `runDuckDb` as `sql`.
   */
  const jsonpath: OrchestrateFileCore = async (args, ctx) => {
    const started = systemNowMs();
    const rawPath = typeof args.path === "string" ? args.path : "";
    const expr = typeof args.expr === "string" ? args.expr : "";
    if (rawPath === "") {
      log.warn(
        { errorKind: "validation" as const, hint: "jsonpath called without a string `path` to a results/ file", toolName: "jsonpath" },
        "orchestrate jsonpath missing path",
      );
      return errorResult("jsonpath requires a string `path`");
    }
    if (expr === "") {
      log.warn(
        { errorKind: "validation" as const, hint: "jsonpath called without a string `expr`", toolName: "jsonpath" },
        "orchestrate jsonpath missing expr",
      );
      return errorResult("jsonpath requires a string `expr`");
    }
    // Confine the path under the workspace.
    let absPath: string;
    try {
      absPath = safePath(ctx.workspaceDir, rawPath);
    } catch (err: unknown) {
      log.warn(
        { err, errorKind: "validation" as const, hint: "jsonpath path escaped the workspace — refusing", toolName: "jsonpath" },
        "orchestrate jsonpath path traversal blocked",
      );
      return errorResult("jsonpath path escapes the workspace");
    }
    // Validate the JSONPath to the conservative dot/bracket grammar so it cannot
    // inject SQL/quotes into the json_extract literal (the no-eval safety floor,
    // T-221-QRY-03). Refused BEFORE any spawn.
    if (!isSafeJsonPath(expr)) {
      log.warn(
        { errorKind: "validation" as const, hint: "jsonpath expr is not a safe $-rooted dot/bracket path — refusing", toolName: "jsonpath" },
        "orchestrate jsonpath unsafe expr blocked",
      );
      return errorResult(
        "jsonpath expr must be a $-rooted dot/bracket path (e.g. $.items[0].price) — wildcards/filters/functions are not supported",
      );
    }
    // Compile the JSONPath into a DuckDB json_extract query over read_json_auto.
    // The path literal is the safePath-confined absolute path; the expr passed the
    // grammar gate above. read_json_auto yields one row of the doc as `j`.
    const query = `SELECT json_extract(j, '${expr}') AS value FROM read_json_auto('${absPath}') t(j)`;
    return await runDuckDb(query, "jsonpath", started);
  };

  const fileExecutors: OrchestrateFileCores = {
    read: fileCore((w) => createComisReadTool(w) as unknown as AgentTool<never>, "read"),
    grep: fileCore((w) => createComisGrepTool(w) as unknown as AgentTool<never>, "grep"),
    find: fileCore((w) => createComisFindTool(w) as unknown as AgentTool<never>, "find"),
    ls: fileCore((w) => createComisLsTool(w) as unknown as AgentTool<never>, "ls"),
    jq,
    sql,
    jsonpath,
  };

  const webSearch: OrchestrateWebSearchCore = async (args, _ctx) => {
    const started = systemNowMs();
    const result = await webSearchTool.execute("tool.invoke", args as never);
    log.debug(
      { step: "web-search-core", toolName: "web_search", durationMs: systemNowMs() - started },
      "orchestrate web_search core executed",
    );
    return result;
  };

  return { fileExecutors, webSearch };
}
