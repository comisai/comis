// SPDX-License-Identifier: Apache-2.0
// @allow-throw: none — every failure branch returns an error-SHAPED object the
// daemon executor forwards to the jailed client (mirrors web-fetch-tool.ts's
// honest-degrade). The `jq` binary-absent / non-zero-exit paths return
// `{ error }`, never throw, so a jailed SDK call surfaces a content-free error
// rather than crashing the executor.
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
 *   - `jq` (READ-02): the in-jail ResultRef slicer. The jailed script's
 *     `wrapResultRef(...).jq(expr)` sends `tool.invoke("jq", {path, expr})`; this
 *     core resolves the workspace-confined file (`safePath`, AGENTS §2.2 — never
 *     `path.join` on a caller-influenced segment) and runs the system `jq` binary
 *     over it (`execFile`, no shell), returning only the requested slice. `jq`
 *     absent or a non-zero exit honest-degrades to `{ error }` (never a throw) —
 *     `jq` is a standard host tool on the VPS/Linux jail (the docs assume it),
 *     and the real in-jail proof is the VPS-deferred `orchestrate-jail.linux.test.ts`.
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

/** The five `{kind:"executor"}` file cores (read/grep/find/ls/jq). */
export interface OrchestrateFileCores {
  read: OrchestrateFileCore;
  grep: OrchestrateFileCore;
  find: OrchestrateFileCore;
  ls: OrchestrateFileCore;
  jq: OrchestrateFileCore;
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
  /** Structured logger — instruments the jq spawn boundary + degrade branches. */
  readonly logger: ComisLogger;
  /** Optional web-search provider config (the shipped tool's config). Absent → keyless/default chain. */
  readonly webSearchConfig?: WebSearchConfig;
  /** Max wall-clock for a single `jq` spawn (ms). Default 10s. */
  readonly jqTimeoutMs?: number;
}

/** An error-shaped honest-degrade (mirrors web-fetch-tool.ts:218-223). */
function errorResult(error: string): { error: string } {
  return { error };
}

const DEFAULT_JQ_TIMEOUT_MS = 10_000;
/** Bound the captured jq stdout so a huge slice cannot blow the daemon's heap. */
const JQ_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Build the shipped daemon-side cores for the orchestrate `tool.invoke` executor.
 * See the module doc for the per-core composition + the jq containment.
 */
export function createOrchestrateExecutorCores(
  deps: OrchestrateExecutorCoresDeps,
): OrchestrateExecutorCores {
  const log = deps.logger.child({ submodule: "orchestrate-executor-cores" });
  const jqTimeoutMs = deps.jqTimeoutMs ?? DEFAULT_JQ_TIMEOUT_MS;

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

  const fileExecutors: OrchestrateFileCores = {
    read: fileCore((w) => createComisReadTool(w) as unknown as AgentTool<never>, "read"),
    grep: fileCore((w) => createComisGrepTool(w) as unknown as AgentTool<never>, "grep"),
    find: fileCore((w) => createComisFindTool(w) as unknown as AgentTool<never>, "find"),
    ls: fileCore((w) => createComisLsTool(w) as unknown as AgentTool<never>, "ls"),
    jq,
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
