// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-session-types -- the neutral LEAF type-module for the daemon-side
 * registry's shared structural contracts.
 *
 * Extracted from `terminal-session-registry.ts` (124-01) to break the source-level
 * import cycle the worker-supervisor extraction introduced: the registry value-imports
 * `wireWorkerSupervision` FROM `terminal-worker-supervisor.ts`, while the supervisor
 * needed `FakeWorkerChild`/`RegistryLogger`/`SessionHandle` back FROM the registry —
 * a 2-member cycle (the no-cycles architecture gate counts type-only edges). Hoisting
 * the shared types into this leaf lets BOTH the registry and the supervisor import them
 * from here, leaving a single forward edge (registry → supervisor).
 *
 * LEAF + INFRA-FREE: this is a pure type-declaration module. It value-imports NOTHING
 * and type-imports ONLY the `SessionOwner` type from the sibling leaf
 * `terminal-session-owner.ts` — never the registry/supervisor/entry (which would
 * re-introduce a cycle), never @comis/infra or @comis/observability.
 *
 * The registry RE-EXPORTS these types (`export type { … } from "./terminal-session-types.js"`)
 * so every existing `from "./terminal-session-registry.js"` importer (the tool layer, the
 * barrel, the round-trip tests) keeps working with zero call-site churn — a type re-export
 * is compile-time-only, not a runtime dual code path.
 *
 * @module
 */

import type { SessionOwner } from "./terminal-session-owner.js";

/**
 * A structural logger — the minimal `{ info, debug, warn, error }` surface. NOT
 * `getLogger` from `@comis/infra` (the registry must never value-import infra).
 */
export interface RegistryLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The structural shape of the spawned worker child — a subset of
 * `ChildProcess`. The registry writes request frames to `stdin`, reads reply
 * frames off `stdout`, and supervises via `on("error"/"close")`.
 */
export interface FakeWorkerChild {
  pid?: number;
  stdin: { write(chunk: Buffer): boolean } | null;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: string, cb: (arg?: unknown) => void): FakeWorkerChild;
  kill(signal?: string): void;
}

/** The lifecycle status of a terminal session. */
export type SessionStatus = "running" | "exited" | "lost";

/** A daemon-side session record. */
export interface SessionHandle {
  sessionId: string;
  allowId: string;
  /** The canonical command (bin) the session drives — for `list`/audit display. */
  command: string;
  status: SessionStatus;
  cols: number;
  rows: number;
  lastActivity: number;
  /** Session start epoch ms (stamped at `create`) — the reaper's wall-clock-age signal (OPS-06). */
  startedAt: number;
  exitCode?: number;
  /** The registry-allocated per-session jail workspace dir (gap 2), removed best-effort on kill so the throwaway dir does not leak. Set ONLY when the registry allocated it (a caller-supplied workspace is the caller's to clean). */
  workspace?: string;
  /** The origin that owns this session — `(agentId, sessionKey)` (TR-13/TR-09). Stamped at `create`; `list`/`read`/`get`/`kill`/`send*` filter on it (two subagents are mutually invisible). */
  owner: SessionOwner;
}
