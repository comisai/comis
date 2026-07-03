// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the executor THROWS only for an unroutable executor tool (a
// defensive default-deny — the dispatch allow-list in setup-capability-endpoint.ts
// is the primary gate, so this branch is unreachable in production). Every tool
// failure (SSRF block, fetch error) is returned as an error-SHAPED object the
// endpoint forwards to the jailed client, NOT thrown.
/**
 * `createToolInvokeExecutor` — the daemon-side executor for the
 * `{kind:"executor"}` tools of the `tool.invoke` surface.
 *
 * The cap-mapped tool surface has two route kinds (`TOOL_ROUTE_MAP`):
 *   - `{kind:"rpc"}` — `memory_*`/`extract_document`/`session_*` map to existing
 *     registered RPC methods; `handleToolInvoke` (setup-capability-endpoint.ts)
 *     strips-then-injects and forwards them to the dispatch sink.
 *   - `{kind:"executor"}` — `read`/`grep`/`find`/`ls`/`jq`/`sql`/`jsonpath`
 *     (in-process AgentTools with NO RPC registration) and `web_search`/`web_fetch`
 *     (daemon-side). These CANNOT be a forged RPC method (would 404 at the sink's
 *     `!handler` throw), so they route HERE — the daemon executing the builtin on
 *     behalf of the jailed (network-isolated) script, over the cap socket.
 *
 * Two execution classes:
 *   - FILE builtins (`read`/`grep`/`find`/`ls`/`jq`/`sql`/`jsonpath`): run under
 *     the agent's resolved workspace dir (NOT the host root). The actual builtin
 *     cores are INJECTED (DI, AGENTS.md §2.4) — the daemon's boot wiring supplies
 *     the shipped `createComisReadTool`/grep/find/ls cores + the sql/jsonpath
 *     DuckDB cores; the executor passes the args plus a workspace ctx. The jail is
 *     for the orchestrate script; these are the daemon servicing a read for it, so
 *     they run daemon-side but workspace-scoped.
 *   - WEB (`web_search`/`web_fetch`): run on the DAEMON's network with the
 *     DNS-PIN. `validateUrl` resolves+classifies the host, then
 *     `fetchPinned(url, validated.ip)` pins the undici connection to the
 *     pre-validated IP — closing the DNS-rebind/TOCTOU window that the in-process
 *     `web-fetch-tool.ts` (which re-resolves DNS at connect time) leaves open.
 *     The autonomous path is undici+pinned (it forgoes the in-process tool's
 *     Chrome-TLS-fingerprinting fetcher; the pin is mandatory for the
 *     unattended path). The in-process web-fetch tool is UNTOUCHED.
 *
 * High-volume returns over the per-tool threshold (`shouldMaterialize`) are
 * offloaded to a `ResultRef` via the injected `materialize` writer (the
 * result-ref-store) — only the handle re-enters context. A `budgetHook`
 * seam is called around the cost-bearing web fetch — the boot wiring supplies
 * the real meter; here it is a no-op callback.
 *
 * @module
 */

import { validateUrl, shouldMaterialize, systemNowMs, type ResultRef } from "@comis/core";
import { fetchPinned, extractReadableContent } from "@comis/skills/tools";
import type { ComisLogger } from "@comis/infra";

/** The validated lease projection the dispatch hands the executor (no secret). */
export interface ToolInvokeLease {
  agentId: string;
  caps: readonly string[];
  /**
   * The tree-stable run identity. Threaded so the
   * `budgetHook` can charge the cost-bearing web call against the right root-run
   * meter (`boundedAutonomy.reserveBudget(rootRunId, …)`). Optional so the
   * deny-matrix / executor unit tests can construct a lease without it (the
   * budgetHook is then a no-op for that call).
   */
  rootRunId?: string;
}

/** Context handed to an injected file-builtin core — the agent's workspace dir. */
export interface FileExecutorContext {
  /** The agent's resolved workspace root; the builtin scopes every path under it. */
  workspaceDir: string;
}

/** An injected file-builtin core (the shipped read/grep/find/ls/jq logic). */
export type FileExecutor = (
  args: Record<string, unknown>,
  ctx: FileExecutorContext,
) => Promise<unknown>;

/** An injected daemon-side web-search core (pinned the same way as web_fetch). */
export type WebSearchExecutor = (
  args: Record<string, unknown>,
  ctx: { agentId: string },
) => Promise<unknown>;

/**
 * A budget seam called before a cost-bearing tool runs. The boot wiring
 * binds it to the real per-root meter for the FLAT web $ charge: it carries the
 * `lease` (the bare `{tool, bytes?}` has no run identity) so the boot
 * hook can charge against `lease.rootRunId` via `boundedAutonomy.reserveBudget`.
 * SCOPE: this hook owns ONLY the flat web limb; the LLM token/wall-clock limbs of
 * a self-spawning loop ride the bridge's per-LLM-call reserve, NOT here.
 */
export type BudgetHook = (
  estimate: { tool: string; bytes?: number },
  lease: ToolInvokeLease,
) => void;

/**
 * The injected ResultRef writer (the `result-ref-store`). Called when a
 * return is over the per-tool threshold; writes the payload to the offloading
 * AGENT's workspace `results/` dir and returns the handle, or `undefined` if it
 * declined. The `lease` is threaded so the writer can resolve the correct
 * per-agent workspace (the store's MaterializeContext needs the
 * workspace path; without the lease the daemon-side writer could not know WHICH
 * agent's `results/` to write to, so the in-jail `jq`/`read` slice over the ref
 * would target the wrong dir).
 */
export type MaterializeWriter = (
  payload: string,
  toolName: string,
  lease: ToolInvokeLease,
) => Promise<ResultRef | undefined>;

/** Deps for {@link createToolInvokeExecutor} (DI — AGENTS.md §2.4). */
export interface ToolInvokeExecutorDeps {
  /** Resolve the agent's workspace root dir (the file builtins run under it). */
  resolveWorkspace: (agentId: string) => string;
  /** The injected file-builtin cores (the in-process builtins). */
  fileExecutors: {
    read: FileExecutor;
    grep: FileExecutor;
    find: FileExecutor;
    ls: FileExecutor;
    jq: FileExecutor;
    /** DuckDB SQL over a ResultRef (daemon-side, hardened). */
    sql: FileExecutor;
    /** JSONPath via DuckDB json_extract over a ResultRef (no eval lib). */
    jsonpath: FileExecutor;
  };
  /** The injected daemon-side web-search core. */
  webSearch: WebSearchExecutor;
  /** The budget seam for cost-bearing web calls (optional; absent ⇒ no-op). */
  budgetHook?: BudgetHook;
  /** The ResultRef writer (over-threshold returns offload to it). */
  materialize?: MaterializeWriter;
  /** Web-fetch timeout in ms (default 30s). */
  webTimeoutMs?: number;
  /** Daemon logger for boundary observability (AGENTS.md §2.7). */
  logger?: ComisLogger;
}

/** The executor entrypoint the dispatch calls for `{kind:"executor"}` tools. */
export type ExecuteToolInvoke = (
  tool: string,
  args: Record<string, unknown>,
  lease: ToolInvokeLease,
) => Promise<unknown>;

const DEFAULT_WEB_TIMEOUT_MS = 30_000;

/** An error-shaped honest-degrade return (mirrors web-fetch-tool.ts:218-223). */
function errorResult(error: string): { error: string } {
  return { error };
}

/**
 * Build the daemon-side executor over the injected builtin cores + web seams.
 * See the module doc for the routing-class split and the DNS-pin rationale.
 */
export function createToolInvokeExecutor(
  deps: ToolInvokeExecutorDeps,
): ExecuteToolInvoke {
  const log = deps.logger?.child({ submodule: "tool-invoke-executor" });
  const webTimeoutMs = deps.webTimeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;

  /**
   * The autonomous web fetch: validateUrl → fetchPinned(url, validated.ip)
   * → extract → over-threshold materialize. Pinned undici, NOT the re-resolving
   * in-process fetcher.
   */
  async function executeWebFetch(
    args: Record<string, unknown>,
    lease: ToolInvokeLease,
  ): Promise<unknown> {
    const started = systemNowMs();
    const url = typeof args.url === "string" ? args.url : "";
    if (url === "") {
      log?.warn(
        { errorKind: "validation" as const, hint: "web_fetch called without a string url", toolName: "web_fetch" },
        "tool.invoke web_fetch missing url",
      );
      return errorResult("web_fetch requires a string `url`");
    }

    // step 1: SSRF resolve + classify. A failure is honest-degrade (no fetch).
    log?.debug({ step: "ssrf-validate", toolName: "web_fetch" }, "tool.invoke web_fetch validating url");
    const validated = await validateUrl(url);
    if (!validated.ok) {
      log?.warn(
        { errorKind: "validation" as const, hint: "url failed SSRF validation — no fetch attempted", toolName: "web_fetch" },
        "tool.invoke web_fetch SSRF blocked",
      );
      return errorResult(`SSRF blocked: ${validated.error.message}`);
    }

    // Budget seam BEFORE the cost-bearing fetch (the wired meter charges the
    // flat web charge against lease.rootRunId).
    deps.budgetHook?.({ tool: "web_fetch" }, lease);

    // step 2: PIN the connection to the pre-validated IP (closes the rebind window;
    // TLS SNI preserved because the original hostname stays in the URL).
    log?.debug({ step: "fetch-pinned", toolName: "web_fetch" }, "tool.invoke web_fetch fetching (DNS-pinned)");
    let res: Awaited<ReturnType<typeof fetchPinned>>;
    try {
      res = await fetchPinned(validated.value.url.toString(), validated.value.ip, {
        method: "GET",
        signal: AbortSignal.timeout(webTimeoutMs),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log?.warn(
        { err, errorKind: "network" as const, hint: "pinned web fetch failed (connect/timeout)", toolName: "web_fetch" },
        "tool.invoke web_fetch fetch failed",
      );
      return errorResult(`Fetch failed: ${message}`);
    }

    // Redirects are blocked for SSRF safety (the pinned agent does not follow them;
    // a 3xx means the server tried to bounce us — refuse rather than re-resolve).
    if (res.status >= 300 && res.status < 400) {
      return errorResult("URL redirected to a different location. Redirects are blocked for security.");
    }
    if (!res.ok) {
      return errorResult(`HTTP ${res.status}: ${res.statusText}`);
    }

    // step 3: extract readable content (the fetch-FREE readability core — NOT the
    // in-process web-fetch tool's fetcher). Non-HTML falls through to the raw body.
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let text = body;
    let title: string | undefined;
    if (contentType.includes("text/html")) {
      log?.debug({ step: "extract", toolName: "web_fetch" }, "tool.invoke web_fetch extracting readable content");
      const readable = await extractReadableContent({ html: body, url, extractMode: "markdown" });
      if (readable?.text) {
        text = readable.text;
        title = readable.title;
      }
    }

    // step 4: over-threshold → materialize to a ResultRef (only the handle
    // re-enters context); under-threshold → inline.
    const byteCount = Buffer.byteLength(text, "utf8");
    if (deps.materialize && shouldMaterialize("web_fetch", byteCount)) {
      log?.debug(
        { step: "materialize", toolName: "web_fetch", bytes: byteCount },
        "tool.invoke web_fetch over threshold — materializing to ResultRef",
      );
      const ref = await deps.materialize(text, "web_fetch", lease);
      if (ref) {
        log?.info(
          { toolName: "web_fetch", durationMs: systemNowMs() - started, bytes: byteCount, materialized: true },
          "tool.invoke web_fetch complete (ResultRef)",
        );
        return ref;
      }
    }

    log?.info(
      { toolName: "web_fetch", durationMs: systemNowMs() - started, bytes: byteCount, materialized: false },
      "tool.invoke web_fetch complete (inline)",
    );
    return { url, text, ...(title !== undefined ? { title } : {}), status: res.status };
  }

  /** A file builtin (read/grep/find/ls/jq/sql/jsonpath) run under the agent's workspace dir. */
  async function executeFileBuiltin(
    tool: "read" | "grep" | "find" | "ls" | "jq" | "sql" | "jsonpath",
    args: Record<string, unknown>,
    lease: ToolInvokeLease,
  ): Promise<unknown> {
    const started = systemNowMs();
    const workspaceDir = deps.resolveWorkspace(lease.agentId);
    log?.debug({ step: "file-builtin", toolName: tool, workspaceDir }, "tool.invoke file builtin dispatching");
    const result = await deps.fileExecutors[tool](args, { workspaceDir });
    log?.info({ toolName: tool, durationMs: systemNowMs() - started }, "tool.invoke file builtin complete");
    return result;
  }

  return async function executeToolInvoke(
    tool: string,
    args: Record<string, unknown>,
    lease: ToolInvokeLease,
  ): Promise<unknown> {
    switch (tool) {
      case "web_fetch":
        return executeWebFetch(args, lease);
      case "web_search": {
        const started = systemNowMs();
        // The daemon-side search core is injected and pinned the same way as
        // web_fetch (the boot wiring supplies it). Budget seam before the
        // cost-bearing call (the flat web charge against lease.rootRunId).
        deps.budgetHook?.({ tool: "web_search" }, lease);
        log?.debug({ step: "web-search", toolName: "web_search" }, "tool.invoke web_search dispatching");
        const result = await deps.webSearch(args, { agentId: lease.agentId });

        // Symmetric with web_fetch — offload an over-threshold result to
        // a ResultRef so the generated SDK's `wrapResultRef(web_search)` decorates
        // a REAL ref (its `.grep/.jq/.read` helpers resolve `path: ref.ref`) and a
        // large search result never re-enters context inline.
        // `RESULT_REF_THRESHOLDS.web_search` (15 KB) gates it. Stringify the
        // structured result so the on-disk artifact is queryable in-jail (`jq`).
        const serialized =
          typeof result === "string" ? result : JSON.stringify(result);
        const byteCount = Buffer.byteLength(serialized, "utf8");
        if (deps.materialize && shouldMaterialize("web_search", byteCount)) {
          log?.debug(
            { step: "materialize", toolName: "web_search", bytes: byteCount },
            "tool.invoke web_search over threshold — materializing to ResultRef",
          );
          const ref = await deps.materialize(serialized, "web_search", lease);
          if (ref) {
            log?.info(
              { toolName: "web_search", durationMs: systemNowMs() - started, bytes: byteCount, materialized: true },
              "tool.invoke web_search complete (ResultRef)",
            );
            return ref;
          }
        }

        log?.info(
          { toolName: "web_search", durationMs: systemNowMs() - started, bytes: byteCount, materialized: false },
          "tool.invoke web_search complete (inline)",
        );
        return result;
      }
      case "read":
      case "grep":
      case "find":
      case "ls":
      case "jq":
      case "sql":
      case "jsonpath":
        return executeFileBuiltin(tool, args, lease);
      default:
        // Defensive default-deny: the dispatch allow-list (cap-map) already
        // rejects any tool absent from TOOL_CAPABILITY_MAP, and only the 7
        // {kind:"executor"} tools reach here — so this is unreachable in
        // production. Throw rather than return an error-shape (a routing bug).
        throw new Error(`tool.invoke executor: no route for tool "${tool}"`);
    }
  };
}
