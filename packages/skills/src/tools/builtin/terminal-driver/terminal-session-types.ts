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

/** A readable stdio stream slot — the structural `on("data")` surface the registry reads. */
export interface WorkerStdioStream {
  on(event: "data", cb: (chunk: Buffer) => void): void;
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
  /**
   * The 4-fd stdio array (`["pipe","pipe","pipe","pipe"]`, terminal-worker-launch.ts):
   * fd0=stdin, fd1=stdout, fd2=stderr, fd3=the events PUSH channel (124-05). The
   * supervisor reads `stdio[3]` for `TerminalEventFrame`s (the no-poll attention seam,
   * TR-11). Optional + per-slot-nullable so a fake worker without fd3 (or stderr) is valid
   * — the reader is optional-chained.
   */
  stdio?: ReadonlyArray<WorkerStdioStream | null | undefined>;
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
  /**
   * DUR-01 (165-06): `true` iff this is a `drive.durable:true` session backed by a
   * detached tmux server that outlives a worker/daemon close. The durable-aware
   * `markRunningSessionsLost` does NOT flip such a session `lost` while its tmux is
   * alive (Q4); recover-on-boot rehydrates it `running`. ABSENT/false ⇒ today's
   * non-durable spawn session (the documented lost floor on a worker close, I1).
   */
  durable?: boolean;
  /**
   * DUR-01 (165-06): the deterministic `comis-<sessionId>` tmux session name — the
   * re-attach key the durable-aware `markRunningSessionsLost` probes via the injected
   * `isTmuxAlive` (a durable handle with a live tmux name stays recoverable, not
   * `lost`). Present only for a durable session (set at create-time + on rehydrate).
   */
  tmuxName?: string;
  /**
   * RECUR-03 (option A): the explicit `-S` socket path this durable session's tmux server is bound
   * to — the PER-BOOT socket of the daemon generation that created it. The daemon's per-session
   * `isTmuxAlive` probe + the worker's re-attach target THIS socket, so a restart re-attaches the
   * surviving session from its OWN (prior-boot) server while new sessions get a fresh per-boot
   * server in the live mount namespace (RECUR-02). Set at create-time + rehydrated on recover;
   * absent ⇒ the boot socket fallback. Present only for a durable tmux session.
   */
  tmuxSocket?: string;
}
