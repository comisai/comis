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

import {
  validateUrl,
  shouldMaterialize,
  systemNowMs,
  wrapExternalContent,
  parseFormattedSessionKey,
  toSafeErrorLogString,
  type AgentCapability,
  type DeliveryOrigin,
  type ResultRef,
  type DurableRunPort,
  type DurableRunRecord,
  type DurableRootBudget,
  type UserTrustLevel,
} from "@comis/core";
import { fetchPinned, extractReadableContent, sanitizeMcpToolResult } from "@comis/skills/tools";
import { qualifyToolName, type McpClientManager } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";

/** The validated lease projection the dispatch hands the executor (no secret). */
export interface ToolInvokeLease {
  leaseId: string;
  agentId: string;
  caps: readonly AgentCapability[];
  sessionKey: string;
  deliveryOrigin?: DeliveryOrigin;
  /** Exact trust from the validated server-held capability lease. */
  trustLevel: UserTrustLevel;
  /**
   * The tree-stable run identity. Threaded so the
   * `budgetHook` can charge the cost-bearing web call against the right root-run
   * meter (`boundedAutonomy.reserveBudget(rootRunId, …)`). Optional so the
   * deny-matrix / executor unit tests can construct a lease without it (the
   * budgetHook is then a no-op for that call).
   */
  rootRunId?: string;
  /** Unique execution checkpoint authorized by this lease. */
  checkpointId?: string;
}

/** Context handed to an injected file-builtin core — the agent's workspace dir. */
export interface FileExecutorContext {
  /** The agent's resolved workspace root; the builtin scopes every path under it. */
  workspaceDir: string;
  /** Exact execution checkpoint/root identity used by mutating run-scoped cores. */
  runId?: string;
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
    /** Run-scoped, run-ephemeral write confined to results/writes (safePath; surface-gated, the first mutating builtin). */
    write: FileExecutor;
  };
  /** The injected daemon-side web-search core. */
  webSearch: WebSearchExecutor;
  /** The budget seam for cost-bearing web calls (optional; absent ⇒ no-op). */
  budgetHook?: BudgetHook;
  /** The ResultRef writer (over-threshold returns offload to it). */
  materialize?: MaterializeWriter;
  /** Web-fetch timeout in ms (default 30s). */
  webTimeoutMs?: number;
  /**
   * The daemon-wide MCP client manager — `case "mcp"` dispatches through
   * `callTool(qualifyToolName(server,tool))` on the DAEMON's network (the jail
   * stays `--unshare-net`, exactly like web_fetch). OPTIONAL: absent ⇒ `executeMcp`
   * honest-degrades to an "MCP not available" error-result (an un-wired daemon is
   * safe, never crashy — defense-in-depth beside the boot-required
   * `CapabilityLayerDeps.mcpClientManager`).
   */
  mcpClientManager?: McpClientManager;
  /**
   * The per-agent inbound MCP allowlist — the layer-2 default-deny gate consulted
   * BEFORE any dispatch (232-02 `permitsMcpTool`, resolved per-agent at boot from
   * that agent's `autonomy.mcp.allow`). OPTIONAL: absent ⇒ every mcp call denies
   * (deny-by-absence). A deny is an audited error-result — `callTool` is never reached.
   */
  mcpAllowlist?: { permits(agentId: string, server: string, tool: string): boolean };
  /**
   * The per-agent WRITE-SURFACE gate — the default-OFF surface toggle consulted
   * BEFORE the `write` dispatch. `orch:write` is a FLOOR cap (held by every
   * standard/unattended/max agent), but the TYPED write surface must be an
   * explicit opt-in (`autonomy.write`), so a default agent that HOLDS orch:write
   * still cannot reach the write tool. Resolved per-agent at boot from that
   * agent's `autonomy.write === true`. OPTIONAL: absent ⇒ the write surface is
   * OFF (deny-by-absence, fail-closed — mirrors {@link mcpAllowlist}). A deny is a
   * content-free error-result; `executeFileBuiltin("write", …)` is never reached.
   */
  writeSurfaceEnabled?: (agentId: string) => boolean;
  /**
   * The per-agent RESUME-SURFACE gate — the default-OFF durability toggle
   * (`autonomy.durability.orchestrateResume`) consulted BEFORE any checkpoint/resume
   * dispatch. checkpoint→orch:write and resume→orch:read reuse the FLOOR caps, so
   * the cap the lease holds is NOT enough — this surface is the AUTHORITATIVE gate
   * (deny-by-absence, fail-closed — mirrors {@link writeSurfaceEnabled}). Resolved
   * per-agentId at boot from that agent's `autonomy.durability.orchestrateResume ===
   * true`. OPTIONAL: absent/false ⇒ BOTH arms deny with a content-free error-result
   * (no materialize, no durable read/write) — even though the lease holds the floor cap.
   */
  orchestrateResumeEnabled?: (agentId: string) => boolean;
  /**
   * The durable-run store (RESUME-01). checkpoint persists the checkpoint
   * ResultRef id onto the run's row (`upsertCheckpoint`, COALESCE-preserve so ONLY
   * checkpointRef is set — NEVER `outward_step`); resume reads the last
   * checkpointRef back (`getByCheckpoint`). Only these two methods are used. OPTIONAL:
   * absent ⇒ checkpoint honest-degrades to an error-result / resume to null.
   */
  durableRuns?: Pick<DurableRunPort, "upsertCheckpoint" | "getByCheckpoint">;
  /** Absolute tree-wide meter state persisted with every checkpoint. */
  durableBudgetState?: (rootRunId: string) => DurableRootBudget;
  /**
   * Materialize a checkpoint state blob as a distinguished, LONGER-TTL kind:"json"
   * ResultRef keyed on `lease.rootRunId` (DISTINCT from {@link materialize}: a
   * longer TTL that outlives a full run + a resume window, and a rootRunId-scoped
   * on-disk run so resume finds it after a restart). Returns the ref, or `undefined`
   * when the store REFUSED (over the per-file cap) or the write failed — the
   * executor then refuses the checkpoint content-free (T-WS4-02). OPTIONAL: absent ⇒
   * checkpoint honest-degrades.
   */
  materializeCheckpoint?: (stateJson: string, lease: ToolInvokeLease) => Promise<ResultRef | undefined>;
  /**
   * Load a previously-materialized checkpoint blob back by its `ResultRef.ref`
   * (workspace-confined read). `undefined` when the ref/file is absent (expired /
   * GC'd / never written) — resume then returns null. OPTIONAL: absent ⇒ resume
   * degrades to null.
   */
  loadCheckpoint?: (ref: string, lease: ToolInvokeLease) => Promise<string | undefined>;
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
 * The closed, content-free enum of daemon-side SURFACE gates that can deny an
 * authorized (`orch:*`-held) `tool.invoke` AFTER the cap chokepoint allowed the
 * capability — the per-agent MCP inbound allowlist, the `orch:write` write
 * surface, and the `orchestrateResume` checkpoint/resume surface. A gate NAME
 * only — never a server/tool/arg/body (INV-5/V7).
 */
export type CapabilityDenyGate = "mcp_allowlist" | "write_surface" | "resume_surface";

/**
 * Non-enumerable marker riding a surface-gate deny's error-result. `handleToolInvoke`
 * reads it IN-PROCESS (via {@link capabilityDenyReason}) to emit
 * `capability:audited {decision:"deny"}` instead of `allow`, so an in-jail
 * surface-gate denial is visible in `explain.orchestrate` + the durable audit —
 * not just the WARN log. Non-enumerable + a Symbol key ⇒ `JSON.stringify` drops
 * it, so the marker NEVER reaches the jailed script (which still sees `{ error }`).
 */
const CAPABILITY_DENY_GATE = Symbol("capabilityDenyGate");

/** An error-result whose surface-gate deny is audited (the cap was held; THIS gate denied). */
export function deniedResult(error: string, gate: CapabilityDenyGate): { error: string } {
  const result: { error: string } = { error };
  Object.defineProperty(result, CAPABILITY_DENY_GATE, { value: gate, enumerable: false });
  return result;
}

/**
 * Read the surface-gate deny marker off an executor result — the CLOSED gate enum
 * when the result is a surface-gate deny, else `undefined`. Pure (no I/O, no
 * throw); the chokepoint calls it to decide the audited decision.
 */
export function capabilityDenyReason(result: unknown): CapabilityDenyGate | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  // The key is a module-private compile-time constant Symbol — not a string and
  // not attacker-derivable (a jailed script cannot forge a Symbol identity), so
  // this is categorically not an injection sink.
  // eslint-disable-next-line security/detect-object-injection
  return (result as Record<symbol, unknown>)[CAPABILITY_DENY_GATE] as CapabilityDenyGate | undefined;
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

  /**
   * The daemon-side MCP dispatch (MCP-01/02/03). The whole path is `web_fetch`
   * with a different daemon-side callee: gate on the per-agent inbound allowlist →
   * `callTool(qualifyToolName(server,tool))` on the DAEMON's network (the jail
   * stays `--unshare-net`) → sanitize + `wrapExternalContent(source:"mcp_tool")`
   * (INV-5, data-not-control) → `shouldMaterialize("mcp")` ResultRef offload.
   *
   * NEVER throws for a tool failure — a transport error (`!res.ok`) or a tool-level
   * `isError` honest-degrades to an error-SHAPED result (the module-doc contract).
   * The `{server,tool}` ride INSIDE `args` and are COMPOSED into the qualified name;
   * they are NEVER treated as an RPC method (no path to `mcp.connect`/`mcp.oauth_login`).
   * The allowlist deny is a content-free audited error-result (the log carries the
   * tool-NAME `"mcp"` + the decision, NEVER the `{server,tool,args}` — INV-5/V7).
   */
  async function executeMcp(
    args: Record<string, unknown>,
    lease: ToolInvokeLease,
  ): Promise<unknown> {
    const started = systemNowMs();
    const server = typeof args.server === "string" ? args.server : "";
    const tool = typeof args.tool === "string" ? args.tool : "";
    const inner =
      args.args !== null && typeof args.args === "object"
        ? (args.args as Record<string, unknown>)
        : {};
    if (server === "" || tool === "") {
      log?.warn(
        { errorKind: "validation" as const, hint: "mcp called without string `server`/`tool`", toolName: "mcp" },
        "tool.invoke mcp missing server/tool",
      );
      return errorResult("mcp requires string `server` and `tool`");
    }

    // (a) INBOUND GATE — the layer-2 per-agent allowlist (deny by absence, 232-02
    // permitsMcpTool). A deny short-circuits BEFORE any dispatch — callTool is NEVER
    // reached — and emits a content-free audited deny (NO {server,tool,args} — INV-5/V7).
    if (!deps.mcpAllowlist?.permits(lease.agentId, server, tool)) {
      log?.warn(
        { errorKind: "auth" as const, toolName: "mcp", decision: "deny", hint: "MCP tool not on the agent's inbound allowlist" },
        "tool.invoke mcp denied (allowlist)",
      );
      return deniedResult("MCP tool not permitted for this agent", "mcp_allowlist");
    }
    // Guard the manager present — an un-wired daemon honest-degrades (never crashes).
    if (!deps.mcpClientManager) {
      log?.warn(
        { errorKind: "config" as const, toolName: "mcp", hint: "no MCP client manager wired into the tool.invoke executor" },
        "tool.invoke mcp unavailable",
      );
      return errorResult("MCP not available");
    }

    // (b) DAEMON net call — COMPOSE the qualified name "mcp:{server}/{tool}" (never
    // an RPC method). callTool owns the connection lifecycle / breaker / timeouts.
    log?.debug({ step: "mcp-dispatch", toolName: "mcp" }, "tool.invoke mcp dispatching (daemon-side)");
    const res = await deps.mcpClientManager.callTool(qualifyToolName(server, tool), inner);
    if (!res.ok) {
      log?.warn(
        { err: res.error, errorKind: "network" as const, toolName: "mcp", hint: "MCP callTool failed (transport/timeout)" },
        "tool.invoke mcp call failed",
      );
      return errorResult(`MCP tool error: ${res.error.message}`); // honest-degrade, NOT a throw
    }
    if (res.value.isError) {
      log?.warn(
        { errorKind: "dependency" as const, toolName: "mcp", hint: "the MCP server returned a tool-level error result" },
        "tool.invoke mcp tool-level error",
      );
      return errorResult("MCP tool reported an error");
    }

    // (c) sanitize (NFKC + invisible strip) + wrap as UNTRUSTED external content
    // (INV-5) — the return is DATA the jailed script reads; only its stdout ever
    // re-enters model context. Replicated from mcp-tool-bridge (the daemon executor
    // is a FRESH call site — the wrap is NOT shared).
    let text = res.value.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text ?? "")
      .join("\n");
    // Fallback for an ALL-non-text result (image/data/embedded-resource only):
    // this path is text-only (like the in-process bridge), so without a marker the
    // jailed script would receive an opaque wrapper around empty — no signal that
    // content was present but dropped. Mirror mcp-tool-bridge's fallback so the
    // result stays legible (a diagnosability fix, not a content change).
    if (text === "") {
      text = "MCP tool returned no text content";
    }
    text = sanitizeMcpToolResult(text);
    text = wrapExternalContent(text, { source: "mcp_tool" });

    // (d) over-threshold → offload to a ResultRef (only the handle re-enters
    // context; the in-jail jq/read slices it) — identical to web_fetch's tail.
    const bytes = Buffer.byteLength(text, "utf8");
    if (deps.materialize && shouldMaterialize("mcp", bytes)) {
      log?.debug(
        { step: "materialize", toolName: "mcp", bytes },
        "tool.invoke mcp over threshold — materializing to ResultRef",
      );
      const ref = await deps.materialize(text, "mcp", lease);
      if (ref) {
        log?.info(
          { toolName: "mcp", durationMs: systemNowMs() - started, bytes, materialized: true },
          "tool.invoke mcp complete (ResultRef)",
        );
        return ref;
      }
    }
    log?.info(
      { toolName: "mcp", durationMs: systemNowMs() - started, bytes, materialized: false },
      "tool.invoke mcp complete (inline)",
    );
    return { text };
  }

  /** A file builtin (read/grep/find/ls/jq/sql/jsonpath/write) run under the agent's workspace dir. */
  async function executeFileBuiltin(
    tool: "read" | "grep" | "find" | "ls" | "jq" | "sql" | "jsonpath" | "write",
    args: Record<string, unknown>,
    lease: ToolInvokeLease,
  ): Promise<unknown> {
    const started = systemNowMs();
    const workspaceDir = deps.resolveWorkspace(lease.agentId);
    const runId = lease.checkpointId ?? lease.rootRunId;
    if (tool === "write" && (runId === undefined || runId.length === 0)) {
      log?.warn(
        { errorKind: "precondition" as const, hint: "dispatch write only from a validated lease carrying checkpointId or rootRunId", toolName: tool },
        "tool.invoke write missing run identity",
      );
      return { error: "write requires a validated run identity" };
    }
    log?.debug({ step: "file-builtin", toolName: tool, workspaceDir }, "tool.invoke file builtin dispatching");
    const context: FileExecutorContext = runId === undefined
      ? { workspaceDir }
      : { workspaceDir, runId };
    const result = await deps.fileExecutors[tool](args, context);
    log?.info({ toolName: tool, durationMs: systemNowMs() - started }, "tool.invoke file builtin complete");
    return result;
  }

  /**
   * The RESUME surface gate (deny-by-absence, fail-closed) shared by checkpoint +
   * resume. checkpoint→orch:write / resume→orch:read are FLOOR caps, so the cap the
   * lease holds is NOT the gate — the default-OFF `orchestrateResumeEnabled`
   * predicate is (mirrors the write surface). Absent predicate ⇒ deny (T-233-04).
   * Returns a content-free error-result on deny, `undefined` on allow.
   */
  function resumeSurfaceDeny(tool: "checkpoint" | "resume", lease: ToolInvokeLease): { error: string } | undefined {
    if (!deps.orchestrateResumeEnabled?.(lease.agentId)) {
      log?.warn(
        { errorKind: "auth" as const, toolName: tool, decision: "deny", hint: "the orchestrate resume/checkpoint surface is not enabled for this agent (set autonomy.durability.orchestrateResume:true to opt in)" },
        `tool.invoke ${tool} denied (resume surface off)`,
      );
      return deniedResult("orchestrate resume surface not enabled for this agent", "resume_surface");
    }
    return undefined;
  }

  /**
   * checkpoint(stateJson) — the durable SPECIALIZED writing core (RESUME-01/05).
   * Serializes the script-authored state, materializes it as a distinguished,
   * longer-TTL kind:"json" ResultRef (capped like any ResultRef — T-WS4-02), and
   * stamps ONLY the ref onto the run's durable row (COALESCE-preserve; NEVER
   * `outward_step`, so the outward operation-identity ledger is untouched). Surface-gated
   * fail-closed. Honest-degrades to a content-free error on refuse/failure.
   */
  async function executeCheckpoint(args: Record<string, unknown>, lease: ToolInvokeLease): Promise<unknown> {
    const denied = resumeSurfaceDeny("checkpoint", lease);
    if (denied) return denied;
    const rootRunId = lease.rootRunId;
    if (rootRunId === undefined) return errorResult("checkpoint requires a durable run identity");
    const checkpointId = lease.checkpointId;
    if (checkpointId === undefined) return errorResult("checkpoint requires an execution identity");
    const owner = parseFormattedSessionKey(lease.sessionKey);
    if (owner === undefined) return errorResult("checkpoint requires a formatted session identity");
    if (
      lease.deliveryOrigin !== undefined
      && (
        lease.deliveryOrigin.tenantId !== owner.tenantId
        || lease.deliveryOrigin.userId !== owner.userId
      )
    ) return errorResult("checkpoint delivery origin does not match the session owner");
    if (!deps.materializeCheckpoint || !deps.durableRuns) {
      return errorResult("checkpoint is unavailable (durable store not wired)");
    }
    // The state is the script-authored args, serialized to a JSON blob (kind:json).
    const stateJson = JSON.stringify(args ?? {});
    const ref = await deps.materializeCheckpoint(stateJson, lease);
    if (ref === undefined) {
      // Over the per-file cap OR a failed write — refuse content-free, write no row.
      log?.warn(
        { errorKind: "resource" as const, toolName: "checkpoint", rootRunId, hint: "checkpoint state exceeded the per-file cap or the contained write failed — the checkpoint was NOT persisted" },
        "tool.invoke checkpoint refused",
      );
      return errorResult("checkpoint refused (over the per-file cap or the write failed)");
    }
    // Persist ONLY checkpointRef on the run's durable row (keyed on rootRunId,
    // status running). The plan-01 COALESCE-preserve upsert keeps a scriptRef the
    // runner sets, and the store's upsertCheckpoint NEVER writes outward_step — so
    // stepIndex stays the -1 'never-sent' sentinel and the outward ledger is safe.
    const rootBudget = deps.durableBudgetState?.(rootRunId) ?? {
      startedAtMs: systemNowMs(),
      tokensConsumed: 0,
      usdConsumed: 0,
    };
    const record: DurableRunRecord = {
      checkpointId,
      rootRunId,
      agentId: lease.agentId,
      sessionKey: lease.sessionKey,
      ownerTenantId: owner.tenantId,
      ownerUserId: owner.userId,
      deliveryOrigin: lease.deliveryOrigin ?? null,
      spawnTree: [], // a FLAT orchestrate row (not a DAG spawn tree)
      caps: [...lease.caps],
      leaseIds: [lease.leaseId],
      budgetConsumed: rootBudget.usdConsumed,
      rootBudget,
      cronOrigin: null,
      trustLevel: lease.trustLevel,
      status: "running",
      lastHeartbeatAt: systemNowMs(),
      scriptRef: null,
      checkpointRef: ref.ref,
    };
    const upserted = await deps.durableRuns.upsertCheckpoint(record);
    if (!upserted.ok) {
      log?.warn(
        { err: toSafeErrorLogString(upserted.error), errorKind: "internal" as const, toolName: "checkpoint", rootRunId, hint: "the checkpoint blob was materialized but the durable-row upsert failed — resume may not find it" },
        "tool.invoke checkpoint failed to persist the ref",
      );
      return errorResult("checkpoint failed to persist");
    }
    log?.info({ toolName: "checkpoint", rootRunId, ref: ref.ref }, "tool.invoke checkpoint persisted");
    return { ok: true };
  }

  /**
   * resume(): stateJson | null — reads the run's last checkpointRef off the durable
   * row, loads the blob, and returns it WRAPPED as UNTRUSTED external content
   * (T-WS4-01, data-not-control): the checkpoint was script-authored, so on resume
   * it re-enters the NEXT run as DATA the script reads, NEVER as control (it is
   * never eval'd/executed — exactly like the MCP core wraps a tool return). null
   * when there is no prior checkpoint (or the ref's blob is gone). Surface-gated
   * fail-closed.
   */
  async function executeResume(lease: ToolInvokeLease): Promise<unknown> {
    const denied = resumeSurfaceDeny("resume", lease);
    if (denied) return denied;
    const rootRunId = lease.rootRunId;
    if (rootRunId === undefined) return errorResult("resume requires a durable run identity");
    const checkpointId = lease.checkpointId;
    if (checkpointId === undefined) return errorResult("resume requires an execution identity");
    if (!deps.durableRuns || !deps.loadCheckpoint) return null; // no store wired ⇒ no checkpoint
    const row = await deps.durableRuns.getByCheckpoint(checkpointId);
    if (!row.ok) {
      log?.warn(
        { err: row.error, errorKind: "internal" as const, toolName: "resume", rootRunId, hint: "reading the durable run row failed" },
        "tool.invoke resume failed to read the durable run",
      );
      return errorResult("resume failed to read the durable run");
    }
    const checkpointRef = row.value?.checkpointRef;
    if (checkpointRef === undefined || checkpointRef === null) return null; // no prior checkpoint
    const state = await deps.loadCheckpoint(checkpointRef, lease);
    if (state === undefined) return null; // ref recorded but the blob is gone (expired/GC'd)
    // T-WS4-01: wrap-on-read — script-authored state re-enters as DATA, never control.
    log?.info({ toolName: "resume", rootRunId, ref: checkpointRef }, "tool.invoke resume returned the last checkpoint (wrapped)");
    return wrapExternalContent(state, { source: "orchestrate_checkpoint" });
  }

  return async function executeToolInvoke(
    tool: string,
    args: Record<string, unknown>,
    lease: ToolInvokeLease,
  ): Promise<unknown> {
    switch (tool) {
      case "web_fetch":
        return executeWebFetch(args, lease);
      case "mcp":
        // Daemon-side MCP dispatch (net-needing → runs on the daemon like
        // web_fetch; the jail stays --unshare-net). Gate → callTool → wrap → offload.
        return executeMcp(args, lease);
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
      case "write": {
        // `write` is the first MUTATING builtin. The TYPED write surface is
        // default-OFF (NG2): orch:write is a FLOOR cap (the endpoint already
        // required it before dispatch), but the surface itself requires an explicit
        // per-agent opt-in (autonomy.write → writeSurfaceEnabled). So a default
        // standard agent HOLDS orch:write yet cannot reach the write tool without
        // the surface toggle. Deny-by-absence (fail-closed): an absent predicate
        // denies, exactly like the MCP allowlist. The deny is a content-free
        // error-result (never a throw) and the core is NEVER reached — a run cannot
        // mutate even the ephemeral workspace unless the surface is opted in.
        if (!deps.writeSurfaceEnabled?.(lease.agentId)) {
          log?.warn(
            { errorKind: "auth" as const, toolName: "write", decision: "deny", hint: "the write surface is not enabled for this agent (set autonomy.write:true to opt in)" },
            "tool.invoke write denied (surface off)",
          );
          return deniedResult("write surface not enabled for this agent", "write_surface");
        }
        // The injected core is safePath-confined to the run-scoped results/writes
        // root (run-ephemeral). No ResultRef threshold: a write returns a small ack.
        return executeFileBuiltin(tool, args, lease);
      }
      case "checkpoint":
        // The durable SPECIALIZED writing core — a longer-TTL kind:json ResultRef
        // stamped as checkpointRef on the run's durable row. Surface-gated fail-closed.
        return executeCheckpoint(args, lease);
      case "resume":
        // Reads the last checkpoint back WRAPPED (data-not-control, T-WS4-01) or null.
        return executeResume(lease);
      default:
        // Defensive default-deny: the dispatch allow-list (cap-map) already
        // rejects any tool absent from TOOL_CAPABILITY_MAP, and only the 7
        // {kind:"executor"} tools reach here — so this is unreachable in
        // production. Throw rather than return an error-shape (a routing bug).
        throw new Error(`tool.invoke executor: no route for tool "${tool}"`);
    }
  };
}
