// SPDX-License-Identifier: Apache-2.0
/**
 * Shared dependency contract + small projections for the three in-session
 * expansion-loop `ctx_*` AgentTools (`ctx_search` / `ctx_inspect` /
 * `ctx_expand`).
 *
 * These tools are modeled on the v2.11 terminal-driver blueprint — they are
 * DIRECT-INJECTION, never-export, owner-scoped tools that read the injected
 * core `ContextStorePort` (the agent-to-store cut TYPE). They are NOT the RPC
 * recall path (session-search / memory-search): there is no RPC call, no recall
 * dispatch, and no cross-package memory import anywhere in this directory (the
 * E2/I2 boundary — in-session lossless-store recovery is structurally distinct
 * from cross-session recall).
 *
 * Architecture: the skills package CANNOT import the memory package, so the
 * store arrives as the core `ContextStorePort` TYPE only — the daemon
 * (composition root) injects the concrete LCD store. The logger is a structural
 * `ToolLogger` (NOT `getLogger` from `@comis/infra`), and the clock is the
 * injected `nowMs` (never a raw wall-clock global).
 *
 * @module
 */

import type { ContextStorePort, LcdMessage, LcdMessagePart } from "@comis/core";

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
  /** Per-call session tool-results dir resolver (the exec-tool precedent). `undefined` ⇒ no live session dir. */
  readonly getToolResultsDir: () => string | undefined;
}

/**
 * Cheap token estimate (chars/4 heuristic) — the exact threshold is tunable
 * (RESEARCH A4); the budget guard only needs a stable monotonic proxy so an
 * oversized recovered region spills to a file instead of thrashing the H budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
