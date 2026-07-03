// SPDX-License-Identifier: Apache-2.0
/**
 * Shared dependency contract + small projections for the three in-session
 * expansion-loop `ctx_*` AgentTools (`ctx_search` / `ctx_inspect` /
 * `ctx_expand`).
 *
 * These tools follow the terminal-driver pattern — they are
 * DIRECT-INJECTION, never-export, owner-scoped tools that read the injected
 * core `ContextStorePort` (the agent-to-store cut TYPE). They are NOT the RPC
 * recall path (session-search / memory-search): there is no RPC call, no recall
 * dispatch, and no cross-package memory import anywhere in this directory —
 * in-session lossless-store recovery is structurally distinct from
 * cross-session recall.
 *
 * Architecture: the skills package CANNOT import the memory package, so the
 * store arrives as the core `ContextStorePort` TYPE only — the daemon
 * (composition root) injects the concrete LCD store. The logger is a structural
 * `ToolLogger` (NOT `getLogger` from `@comis/infra`), and the clock is the
 * injected `nowMs` (never a raw wall-clock global).
 *
 * @module
 */

import { tryGetContext, type ContextStorePort, type ContextStoreScope, type LcdMessage, type LcdMessagePart } from "@comis/core";
import { throwToolError } from "../../../platform-tools/tool-helpers.js";

/**
 * Minimal pino-compatible structural logger — NOT `getLogger` from
 * `@comis/infra`. Copied verbatim from the terminal-driver blueprint
 * (terminal-tools.ts:85-91) so the skills layer never value-imports a concrete
 * logger; the daemon passes its real `ComisLogger` (structurally assignable).
 */
export interface ToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies shared by all three `ctx_*` tools (mirrors `TerminalToolDeps`). */
export interface ContextToolDeps {
  /**
   * The injected concrete LCD store (the daemon constructs it). TYPE-only here —
   * the skills package must NOT import the memory package (the agent-to-store cut).
   */
  readonly store: ContextStorePort;
  /** Injected structural logger — NOT `getLogger`; the daemon passes the real one. */
  readonly logger: ToolLogger;
  /** Injected clock — no raw wall-clock global (globals.test.ts). */
  readonly nowMs: () => number;
  /** Inline-output cap before `ctx_expand` spills to a file (from `ContextEngineConfig`, default 4000). */
  readonly maxExpandTokens: number;
  /**
   * Tier-gated max BFS hop depth for the `ctx_expand` multi-hop walk
   * (nano1/small2/mid3/frontier4). Resolved at the wiring site from the agent's
   * `ModelProfile` (`RequestContext` carries no `capabilityClass`). A capacity
   * knob, NOT a scope — wiring-time resolution is correct because the per-call
   * scope still comes from `requireCtxScope()`. Absent ⇒ a conservative
   * depth of 1 (single-hop).
   */
  readonly maxExpandDepth?: number;
  /** Per-call session tool-results dir resolver (the exec-tool precedent). `undefined` ⇒ no live session dir. */
  readonly getToolResultsDir: () => string | undefined;
  /**
   * Optional structural event bus for emitting expansion-hit metrics.
   * STRUCTURAL only — skills must NOT import @comis/infra or a concrete
   * TypedEventBus (the agent↛infra cut). The daemon (composition root) passes
   * its real bus, structurally assignable. Absent ⇒ a silent no-op (the `?.`).
   */
  readonly eventBus?: { emit(event: string, data: unknown): void };
}

/**
 * Build the per-call `ContextStoreScope` for a ctx_* tool from the LIVE request
 * context. Reads `tryGetContext()` EVERY call (NOT
 * a wiring-time closure): one wired tool can serve multiple agents per channel,
 * so the agent/tenant scope MUST come from the live turn, never a cached id —
 * a cached id would leak another agent's history within a shared conversation.
 *
 * FAIL CLOSED: throws `permission_denied` when there is no live
 * session OR the agentId/tenantId is absent — a tool running outside a fully
 * scoped session REFUSES rather than reading conversation-wide (which would leak
 * another agent's history within a shared conversation_id). `conversationId` is
 * the live `sessionKey` (its first segment is the tenant); `sessionKey` on the
 * scope is the same value (the store does not filter on the 4th field — it is
 * carried for shape symmetry with the write path).
 */
export function requireCtxScope(): ContextStoreScope {
  const ctx = tryGetContext();
  if (!ctx?.sessionKey || !ctx.agentId || !ctx.tenantId) {
    throwToolError("permission_denied", "ctx_* tools operate only inside a live, fully-scoped session.", {
      hint: "These tools read THIS conversation's compressed history scoped to the live agent; they cannot run outside a session with a resolved agentId + tenantId.",
    });
  }
  return {
    conversationId: ctx.sessionKey,
    agentId: ctx.agentId,
    tenantId: ctx.tenantId,
    sessionKey: ctx.sessionKey,
  };
}

/**
 * Cheap token estimate (chars/4 heuristic) — the exact threshold is tunable;
 * the budget guard only needs a stable monotonic proxy so an oversized
 * recovered region spills to a file instead of thrashing the context budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Emit the content-free `context:dag_expanded` expansion-hit metric, GUARDED
 * so a throwing subscriber can NEVER fail the already-completed recovery.
 *
 * `TypedEventBus.emit` delegates to Node's `EventEmitter.emit`, which invokes
 * every subscriber synchronously and propagates the FIRST subscriber exception
 * back to the emitter. The ctx_* tools emit in the success path of `execute()`,
 * so an unguarded throw (a trajectory writer, a metrics sink, a future dashboard
 * handler) would unwind out of the tool and turn a fully-completed
 * `ctx_search`/`ctx_inspect`/`ctx_expand` recovery into a tool failure the model
 * sees — discarding the recovered content even though the store read succeeded.
 * This mirrors the afterTurn emitters' non-fatal contract
 * (lcd-compaction-trigger.ts / lcd-condense-trigger.ts): observability supplements
 * the recovery, it never aborts it. The swallowed-error WARN is content-free
 * (toolName + a sanitized error message + an actionable hint, AGENTS.md §2.7).
 *
 * `data` is the already-assembled, content-free payload (ids/counts/durationMs/
 * timestamp only — never recovered text); this helper does not read or shape it.
 */
export function emitExpansionMetric(
  deps: Pick<ContextToolDeps, "eventBus" | "logger">,
  toolName: string,
  data: unknown,
): void {
  try {
    deps.eventBus?.emit("context:dag_expanded", data);
  } catch (err) {
    deps.logger.warn(
      {
        toolName,
        err: err instanceof Error ? err.message : String(err),
        hint: "context:dag_expanded subscriber threw; metric dropped, recovery unaffected — inspect the failing event subscriber (trajectory writer / metrics sink)",
        errorKind: "dependency" as const,
      },
      "ctx_* expansion metric emit failed (non-fatal)",
    );
  }
}

/**
 * Emit the `context:script_zero_hit` signal (a clean non-Latin search
 * that returned zero hits), GUARDED so a throwing subscriber can NEVER fail the
 * already-completed search — the exact non-fatal contract of
 * {@link emitExpansionMetric} (a trajectory writer / metrics sink that throws
 * must not unwind out of the tool). The caller fires this ONLY when the search
 * ran cleanly (`!matchErrored`) and the store classified the query as non-Latin
 * (`result.scriptZeroHit` set) — the errored-MATCH branch WARNs instead, so a
 * `safeAll`-swallowed FTS5 syntax error never pollutes the lane-gap signal
 * (signal purity).
 *
 * `data` is the already-assembled, content-free payload (ids + the closed
 * `scriptClass`/`lane` enums + timestamp ONLY — NEVER the query text); this
 * helper does not read or shape it. The swallowed-error WARN is content-free
 * (toolName + a sanitized error message + an actionable hint, AGENTS.md §2.7).
 */
export function emitScriptZeroHit(
  deps: Pick<ContextToolDeps, "eventBus" | "logger">,
  data: unknown,
): void {
  try {
    deps.eventBus?.emit("context:script_zero_hit", data);
  } catch (err) {
    deps.logger.warn(
      {
        toolName: "ctx_search",
        err: err instanceof Error ? err.message : String(err),
        hint: "context:script_zero_hit subscriber threw; signal dropped, search result unaffected — inspect the failing event subscriber (trajectory writer / health-signal sink)",
        errorKind: "dependency" as const,
      },
      "ctx_search script_zero_hit emit failed (non-fatal)",
    );
  }
}

/** JSON.stringify that degrades to `""` on a cycle/throw — never crashes the recovery path. */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Project one message part's human-readable text (verbatim text block + tool name/I/O). */
function renderPartText(part: LcdMessagePart): string {
  const chunks: string[] = [];
  // Text part: the human-readable text rides the verbatim canonical block.
  const raw = part.metadata?.raw;
  if (raw && typeof raw === "object" && "text" in raw) {
    const text = (raw as { text?: unknown }).text;
    if (typeof text === "string") chunks.push(text);
  }
  // Tool I/O is structured JSON — stringify so its detail is recovered.
  if (part.toolName !== undefined) chunks.push(String(part.toolName));
  if (part.toolInput !== undefined) chunks.push(safeStringify(part.toolInput));
  if (part.toolOutput !== undefined) chunks.push(safeStringify(part.toolOutput));
  return chunks.join(" ").trim();
}

/**
 * A thin text projection of a reconstructed message, used by `ctx_expand` to
 * recover the underlying detail of a compressed region. Lives here (not in the
 * memory package's `renderMessageFtsText`) because the skills package cannot
 * import that helper — the projection idea is shared, the code is not.
 */
export function renderMessageText(row: LcdMessage): string {
  const parts = row.parts.map((p) => renderPartText(p)).filter((t) => t.length > 0);
  return parts.join(" ").trim();
}
