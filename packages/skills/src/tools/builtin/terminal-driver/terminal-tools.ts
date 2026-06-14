// SPDX-License-Identifier: Apache-2.0
/**
 * The eight implemented terminal-driver AgentTool factories (spec §5):
 * `terminal_session_create` / `_read` / `_list` / `_kill` and the
 * four interaction tools `_send_text` / `_send_key` / `_resize` / `_wait`.
 * (`terminal_session_status` is the lone remaining stub →
 * `terminal-tools-stubs.ts`.)
 *
 * `create` is the gate that composes the whole substrate:
 *   1. ALLOWLIST GATE: `matchAllowEntry(command, allowEntries)` — a
 *      command whose canonical binary matches no operator entry is rejected with
 *      `permission_denied` and NEVER reaches the registry (no worker spawn). The
 *      matcher enforces realpath + the optional hash pin.
 *   2. FAIL-CLOSED: if `detectProvider()` returns `undefined` there is
 *      no sandbox runtime — `create` rejects rather than spawn an unsandboxed
 *      child.
 *   3. CANONICALIZE (end-to-end): `buildDirectSpawn(entry, command,
 *      args)` is the SOLE canonicalization site — it resolves the realpath and
 *      prepends the operator's `argsPrefix`. The resulting `{bin,argv}` (NOT the
 *      raw command) is handed to the registry, so the worker spawns the canonical
 *      target verbatim and never re-derives realpath (the argsPrefix guarantee
 *      holds end-to-end).
 *   4. OBSERVABILITY: a successful transition logs INFO + `durationMs` +
 *      emits `terminal:session_state`; a spawn failure logs WARN + `hint` +
 *      `errorKind` + emits `terminal:spawn_failed`, then rethrows.
 *
 * `read` / `list` / `kill` and the four interaction tools (`send_text` /
 * `send_key` / `resize` / `wait`) are thin delegations to the injected registry —
 * they operate on an ALREADY-GATED session (create enforced the allowlist + fail-closed
 * checks), so they do NOT re-run the allowlist gate and never touch `detectProvider` (the
 * read/list/kill precedent). The registry's forwarding methods carry the
 * post-action settled snapshot back; `wait`'s `isComplete:false` survives verbatim.
 *
 * Architecture: this module is daemon-side but lives in `@comis/skills`, so it
 * takes an INJECTED structural logger + event bus (never `getLogger` from
 * `@comis/infra` — the registry mirrors this). The daemon (composition root)
 * passes the real logger + the `TypedEventBus`. Clock is the
 * injected `nowMs` (no raw wall-clock global).
 *
 * @module
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  wrapExternalContent,
  scrubSecretsFromText,
  tryGetContext,
  type ApprovalGate,
} from "@comis/core";

import { jsonResult, throwToolError } from "../../../platform-tools/tool-helpers.js";
import type {
  TerminalInputNeededEvent,
  TerminalStuckEvent,
  TerminalEscalatedEvent,
  TerminalAutoAnsweredEvent,
} from "./terminal-events-attention.js";
// Re-export the P5 attention/audit event payloads so consumers (and the daemon
// emit hooks, 124-09) reach them via the tool module alongside TerminalEventBus.
export type {
  TerminalInputNeededEvent,
  TerminalStuckEvent,
  TerminalEscalatedEvent,
  TerminalAutoAnsweredEvent,
} from "./terminal-events-attention.js";
import { matchAllowEntry, buildDirectSpawn, allowedCommandNames, type AllowEntryLike } from "./allowlist-matcher.js";
import type { SessionCaps } from "./terminal-caps.js";
import { enforceSendCapsThenAudit, readDimension } from "./terminal-send-guards.js";
import type { SandboxProvider } from "../sandbox/types.js";
import {
  DEFAULT_SCROLLBACK,
  type TerminalSessionRegistry,
  type TerminalView,
  type SendResult,
  type WaitResult,
  type SessionListing,
  type SessionOwner,
} from "./terminal-session-registry.js";

// ---------------------------------------------------------------------------
// Injected dependency contracts
// ---------------------------------------------------------------------------

/** Minimal pino-compatible structural logger — NOT `getLogger` from `@comis/infra`. */
export interface ToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** The transition-event payload (mirrors core `TerminalEvents["terminal:session_state"]`). */
export interface TerminalStateEvent {
  sessionId: string;
  agentId: string;
  state: "created" | "running" | "exited" | "lost";
  durationMs: number;
  timestamp: number;
}

/** The spawn-failure payload (mirrors core `TerminalEvents["terminal:spawn_failed"]`). */
export interface TerminalSpawnFailedEvent {
  sessionId: string;
  agentId: string;
  hint: string;
  errorKind: string;
  timestamp: number;
}

/** The reaper/cap-trip eviction payload (mirrors core `TerminalEvents["terminal:session_evicted"]`). */
export interface TerminalEvictedEvent {
  sessionId: string;
  agentId: string;
  reason: "idle" | "max_sessions" | "wall_clock" | "max_interactions";
  durationMs: number;
  timestamp: number;
}

/**
 * The keystroke-audit event payload (mirrors core
 * `TerminalEvents["terminal:keystroke"]`). REDACTION-SAFE BY CONSTRUCTION:
 * it carries the counts/ids (`redactions`, `byteLength`) + the typed `outcome` ONLY
 * — there is NO `text`/`keys`/`payload` field, so an emit site cannot leak a
 * keystroke on the bus even by mistake. The scrubSecretsFromText-REDACTED
 * payload rides the structured LOG only; the bus event is the redaction-safe summary.
 * `outcome` is an ATTEMPT tag: `attempted` = forwarded, `rejected` = blocked
 * by a cap breach — never proof of delivery; `sessionId` is caller-asserted.
 */
export interface TerminalKeystrokeEvent {
  sessionId: string;
  agentId: string;
  kind: "text" | "key";
  redactions: number;
  byteLength: number;
  outcome: "attempted" | "rejected";
  timestamp: number;
}

/**
 * A structural event-bus surface scoped to the terminal events the skills layer
 * emits. The daemon passes its `TypedEventBus` (structurally compatible); tests
 * pass a capturing fake. Kept structural so the skills layer never value-imports
 * the concrete bus class.
 */
export interface TerminalEventBus {
  emit(event: "terminal:session_state", payload: TerminalStateEvent): unknown;
  emit(event: "terminal:spawn_failed", payload: TerminalSpawnFailedEvent): unknown;
  // The reaper/cap-trip eviction audit event.
  emit(event: "terminal:session_evicted", payload: TerminalEvictedEvent): unknown;
  // The per-send keystroke audit event.
  emit(event: "terminal:keystroke", payload: TerminalKeystrokeEvent): unknown;
  // P5/124 — the attention + audit overloads (124-02 declared the typed payloads in
  // events-terminal.ts site 1; the emit call sites land in 124-05/07/09):
  emit(event: "terminal:input_needed", payload: TerminalInputNeededEvent): unknown;
  emit(event: "terminal:stuck", payload: TerminalStuckEvent): unknown;
  emit(event: "terminal:escalated", payload: TerminalEscalatedEvent): unknown;
  emit(event: "terminal:auto_answered", payload: TerminalAutoAnsweredEvent): unknown;
}

/** Dependencies shared by all four implemented tools. */
export interface TerminalToolDeps {
  /** The daemon-side session registry that spawns + supervises the worker. */
  readonly registry: TerminalSessionRegistry;
  /** The operator allow-set (parsed config mapped onto `AllowEntryLike`); the allowlist trust source. */
  readonly allowEntries: AllowEntryLike[];
  /**
   * Sandbox-provider detector. Injected so the fail-closed test can
   * force `undefined`. Production passes a closure over the daemon's
   * once-detected provider (or `detectSandboxProvider` itself).
   */
  readonly detectProvider: () => SandboxProvider | undefined;
  /** Injected structural logger (daemon passes the real one). */
  readonly logger: ToolLogger;
  /** Injected event bus (daemon passes its `TypedEventBus`). */
  readonly eventBus: TerminalEventBus;
  /** Clock port — injected `nowMs` (no raw wall-clock global). */
  readonly nowMs: () => number;
  /** The owning agent id — stamped onto every emitted event. */
  readonly agentId: string;
  /**
   * The per-session usage caps. A SHARED per-agent instance
   * the daemon constructs from the matched entry's `limits` AND also threads into the
   * registry's `onCapForget` so eviction forgets the SAME cap-state map.
   * `create` calls `startSession`; each `send_*` calls `consumeRequest` (REJECT on
   * breach — session survives) + `consumeInteraction` / `checkWallClock` (EVICT via
   * `registry.evict` on breach); the explicit kill tool calls `forget`. The evict
   * branches do NOT call `forget` (the registry onCapForget owns that — no double-forget).
   */
  readonly caps: SessionCaps;
  /**
   * The operator approval gate. Injected by the daemon (the existing
   * `ApprovalGate` from setup-tools). Consulted ONLY when the matched entry sets
   * `approveOnCreate` — an entry that demands approval with NO gate wired
   * fail-closes (reject), never silently proceeds. Optional so non-approving
   * deployments + the read/list/kill tools need not supply it.
   */
  readonly approvalGate?: ApprovalGate;
}

// ---------------------------------------------------------------------------
// Defaults (spec §5)
// ---------------------------------------------------------------------------

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

// ---------------------------------------------------------------------------
// Parameter schemas (spec §5 — the final signatures)
// ---------------------------------------------------------------------------

const CreateParams = Type.Object({
  allowId: Type.String({ description: "Allowlist entry id to spawn under" }),
  command: Type.String({ description: "The binary to drive (an absolute/relative path; canonical-matched)" }),
  args: Type.Optional(Type.Array(Type.String(), { description: "Arguments appended after the entry's argsPrefix" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the session" })),
  cols: Type.Optional(Type.Integer({ description: "Terminal columns (default 120)" })),
  rows: Type.Optional(Type.Integer({ description: "Terminal rows (default 40)" })),
  name: Type.Optional(Type.String({ description: "Human-readable session name" })),
  hintPatterns: Type.Optional(Type.Array(Type.String(), { description: "Safe-interaction hint patterns" })),
});

const ReadParams = Type.Object({
  sessionId: Type.String({ description: "Session to read" }),
  format: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("ansi"), Type.Literal("html")], {
      description: "Render format (default text)",
    }),
  ),
  scrollback: Type.Optional(Type.Integer({ description: "Scrollback lines to include (default 0)" })),
  includeAltBuffer: Type.Optional(Type.Boolean({ description: "Include the alternate screen buffer (default true)" })),
});

const ListParams = Type.Object({});

const KillParams = Type.Object({
  sessionId: Type.String({ description: "Session to terminate" }),
  signal: Type.Optional(Type.String({ description: "Signal to send (default SIGTERM)" })),
});

// The four interaction-tool schemas (spec §5 — relocated from the stubs file when
// these tools became real). The surface is unchanged; only the behaviour landed.

const SendTextParams = Type.Object({
  sessionId: Type.String({ description: "Session to send text to" }),
  text: Type.String({ description: "Text to type into the session" }),
  submit: Type.Optional(Type.Boolean({ description: "Press Enter after the text (default false)" })),
  bracketedPaste: Type.Optional(Type.Boolean({ description: "Wrap the text in a bracketed paste (default false)" })),
});

const SendKeyParams = Type.Object({
  sessionId: Type.String({ description: "Session to send keys to" }),
  keys: Type.Array(Type.String(), { description: 'Key chords, e.g. ["C-c"], ["Up","Enter"], ["S-Tab"]' }),
});

const WaitParams = Type.Object({
  sessionId: Type.String({ description: "Session to wait on" }),
  forIdleMs: Type.Optional(Type.Integer({ description: "Settle when idle for this many ms" })),
  forText: Type.Optional(Type.String({ description: "Settle when this text appears on screen" })),
  forExit: Type.Optional(Type.Boolean({ description: "Settle when the session exits" })),
  timeoutMs: Type.Optional(Type.Integer({ description: "Bounded in-turn settle timeout (default 15000, capped)" })),
});

const ResizeParams = Type.Object({
  sessionId: Type.String({ description: "Session to resize" }),
  cols: Type.Integer({ description: "New column count" }),
  rows: Type.Integer({ description: "New row count" }),
});

// ---------------------------------------------------------------------------
// Param readers (typed, local — params arrive as Record<string,unknown>)
// ---------------------------------------------------------------------------

function readString(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

function readInt(p: Record<string, unknown>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readStringArray(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Read an optional boolean param — `undefined` when absent or not a boolean. */
function readBool(p: Record<string, unknown>, key: string): boolean | undefined {
  const v = p[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Read an optional integer param — `undefined` when absent or not a finite number. */
function readOptInt(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Origin-keying: derive the (agentId, sessionKey) owner per call
// ---------------------------------------------------------------------------

/**
 * Derive the calling origin `(agentId, sessionKey)` for the owner-scoped registry
 * calls. Read from the AsyncLocalStorage `RequestContext`
 * (`tryGetContext()`) the SAME way the create approval gate already does
 * (terminal-tools.ts create): `agentId = ctx.userId ?? deps.agentId`, `sessionKey
 * = ctx.sessionKey ?? ""`. Two subagent runs of one parent get distinct owners
 * (each subagent `channelId` is `"sub-agent:<uuid>"`, session-key.ts:78-79), so a
 * subagent sees ONLY its own sessions and siblings are mutually invisible.
 */
export function resolveOwner(deps: TerminalToolDeps): SessionOwner {
  const ctx = tryGetContext();
  return { agentId: ctx?.userId ?? deps.agentId, sessionKey: ctx?.sessionKey ?? "" };
}

/** The degraded `{screen,cursor}` snapshot a send_text/send_key returns when the turn signal already aborted. */
const ABORTED_SEND: SendResult = { screen: "", cursor: { x: 0, y: 0 } };

// ---------------------------------------------------------------------------
// create (the gate — allowlist / fail-closed / canonicalize / observe)
// ---------------------------------------------------------------------------

/**
 * `terminal_session_create` — gate on the allowlist, fail closed on a
 * missing sandbox provider, canonicalize via the sole `buildDirectSpawn`
 * site, then register a session and emit the transition.
 */
export function createTerminalSessionCreateTool(deps: TerminalToolDeps): AgentTool<typeof CreateParams> {
  return {
    name: "terminal_session_create",
    label: "Terminal: create session",
    description:
      "Start an interactive terminal session driving an allowlisted binary. Rejected unless the canonical command matches an operator allowlist entry.",
    parameters: CreateParams,

    // The SDK 4-arg execute — the turn's AbortSignal is arg 3. We OBSERVE it
    // to end the call but abort ends the CALL, NOT the session — never registry.kill.
    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const allowId = readString(params, "allowId") ?? "";
      const command = readString(params, "command") ?? "";
      const args = readStringArray(params, "args");
      const cols = readInt(params, "cols", DEFAULT_COLS);
      const rows = readInt(params, "rows", DEFAULT_ROWS);

      // abort ends the call, NOT the session — never registry.kill here. The
      // turn already aborted, so do NOT spawn a new session (create is the one
      // mutating-but-not-yet-existing tool); return an honest not-created result.
      if (signal?.aborted) {
        return jsonResult({ sessionId: "", allowId, cols, rows, aborted: true });
      }

      // (1) ALLOWLIST GATE. matchAllowEntry resolves the
      // realpath ONCE + the optional hash pin; a non-match rejects BEFORE any
      // spawn. The result carries the verified `requestedReal` so the
      // hash-checked inode is the exact one threaded to spawn — no second resolve.
      const matched = matchAllowEntry(command, deps.allowEntries);
      if (matched === undefined) {
        throwToolError("permission_denied", `command not allowlisted: ${command}`, {
          validValues: allowedCommandNames(deps.allowEntries),
        });
      }

      // (2) FAIL-CLOSED. No sandbox runtime ⇒ refuse — never spawn an
      // unsandboxed child. The bare-metal (bwrap removed) confirmation is VPS-gated.
      const provider = deps.detectProvider();
      if (!provider) {
        throwToolError(
          "permission_denied",
          "no sandbox provider available; refusing unsandboxed terminal (fail-closed)",
          { hint: "install a sandbox runtime (e.g. bubblewrap on Linux) so sessions can be confined" },
        );
      }

      // (2b) CONSENT GATE (§3.7). A high-risk entry (`approveOnCreate`)
      // pauses for the OPERATOR — not the prompt-injectable agent — BEFORE any
      // spawn. Mirrors the exec-tool precedent (exec-shared.ts:410-438): identity
      // from tryGetContext() with the documented fallbacks; params are SECRET-FREE
      // (allowId + command only — `args` may carry secrets, so they are omitted).
      // FAIL-CLOSED: an entry that demands approval with NO gate wired rejects —
      // it must NEVER run unauthorized (no silent-degrade).
      if (matched.entry.approveOnCreate) {
        if (!deps.approvalGate) {
          throwToolError(
            "permission_denied",
            "session_create requires approval but no approval gate is wired (fail-closed)",
            { hint: "wire the daemon ApprovalGate into the terminal tools, or unset approveOnCreate for this entry" },
          );
        }
        const ctx = tryGetContext();
        const resolution = await deps.approvalGate.requestApproval({
          toolName: "terminal_session_create",
          action: `terminal.session_create:${allowId}`,
          params: { allowId, command }, // sanitized — no secrets; args omitted
          agentId: ctx?.userId ?? deps.agentId,
          sessionKey: ctx?.sessionKey ?? "",
          trustLevel: (ctx?.trustLevel ?? "admin") as "admin" | "user" | "guest",
          channelType: ctx?.channelType,
        });
        if (!resolution.approved) {
          throwToolError("permission_denied", "session_create not approved", {
            hint: resolution.reason ?? "the operator denied this terminal session",
          });
        }
      }

      // (3) CANONICALIZE (end-to-end). buildDirectSpawn consumes the
      // matcher's already-resolved realpath (no second resolution) and
      // prepends the operator's argsPrefix ahead of the agent args. We forward
      // {bin,argv} — NOT the raw command — so the worker spawns the verified
      // canonical inode verbatim.
      const { bin, argv } = buildDirectSpawn(matched.entry, matched.requestedReal, args);

      // (4) REGISTER + OBSERVE. A spawn failure logs hint+errorKind and
      // emits terminal:spawn_failed before rethrowing.
      const start = deps.nowMs();
      let result;
      try {
        // Scrollback is NOT an agent-facing param — the create surface
        // exposes only {allowId,command,args,cwd,cols,rows,...} to the model. The
        // per-session emulator's retained-memory ceiling is sourced from
        // DEFAULT_SCROLLBACK (operator config later), so the agent cannot inflate
        // per-session memory. The CreateParams schema is unchanged.
        //
        // The sandbox scope is sourced EXCLUSIVELY from the matched
        // allow entry (operator closed config) — NEVER from `params`. The agent has
        // no `scope` create param (CreateParams is closed), so it cannot set or
        // widen the jail; scope rides the create frame to the worker.
        result = await deps.registry.create(
          {
            allowId,
            bin,
            argv,
            cols,
            rows,
            scrollback: DEFAULT_SCROLLBACK,
            scope: matched.entry.scope,
          },
          // Stamp the origin so this session is visible ONLY to its owner.
          resolveOwner(deps),
        );
      } catch (err) {
        const failedAt = deps.nowMs();
        deps.logger.warn(
          {
            toolName: "terminal_session_create",
            allowId,
            durationMs: failedAt - start,
            hint: "worker spawn failed",
            errorKind: "dependency" as const,
            step: "create",
            err,
          },
          "terminal session spawn failed",
        );
        deps.eventBus.emit("terminal:spawn_failed", {
          sessionId: "",
          agentId: deps.agentId,
          hint: "worker spawn failed",
          errorKind: "dependency",
          timestamp: failedAt,
        });
        // @allow-throw: re-propagate the original spawn error to the AgentTool
        // execution boundary after recording observability; the SDK catches
        // it and marks the tool result isError:true (same boundary as tool-helpers.ts).
        throw err;
      }

      const doneAt = deps.nowMs();
      deps.logger.info(
        {
          toolName: "terminal_session_create",
          sessionId: result.sessionId,
          allowId,
          durationMs: doneAt - start,
          step: "create",
        },
        "terminal session created",
      );
      deps.eventBus.emit("terminal:session_state", {
        sessionId: result.sessionId,
        agentId: deps.agentId,
        state: "created",
        durationMs: doneAt - start,
        timestamp: doneAt,
      });
      // Anchor the session's wall-clock start + request/interaction counters so
      // the per-send caps (consumeRequest/consumeInteraction/checkWallClock) measure
      // from create. Idempotent — a re-call never re-anchors the wall clock.
      deps.caps.startSession(result.sessionId);

      return jsonResult(result);
    },
  };
}

// ---------------------------------------------------------------------------
// read / list / kill (thin delegations)
// ---------------------------------------------------------------------------

/** `terminal_session_read` — return the settled `{screen,cursor,cols,rows,alt,alive}` view. */
export function createTerminalSessionReadTool(deps: TerminalToolDeps): AgentTool<typeof ReadParams> {
  return {
    name: "terminal_session_read",
    label: "Terminal: read session",
    description: "Read the current settled screen + cursor of a terminal session.",
    parameters: ReadParams,

    // 4-arg execute: observe the turn signal (read is read-only — it never
    // kills; the owner-scoped read is the load-bearing change).
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      // Forward the render params to the worker (closing a prior
      // schema-only gap — these were declared but never forwarded). Spec §5
      // defaults: format=text, scrollback=0, includeAltBuffer=true. The schema
      // (TypeBox closed Union) already validated `format`; the worker's render
      // dispatch defaults any unrecognized value to text as a 2nd guard.
      const format = (readString(params, "format") as "text" | "ansi" | "html" | undefined) ?? "text";
      const scrollback = readInt(params, "scrollback", 0);
      const includeAltBuffer = readBool(params, "includeAltBuffer") ?? true;
      // Owner-scoped — a cross-owner read returns the not-found view (alive:false).
      const view: TerminalView = await deps.registry.read(sessionId, resolveOwner(deps), {
        format,
        scrollback,
        includeAltBuffer,
      });
      // §3.6: the driven CLI's screen is a PROMPT-INJECTION vector — it can
      // render attacker-controlled text (a file/web the CLI read) and echo secrets.
      // REDACT secret-shaped values FIRST (so a leaked token never reaches the agent
      // or the wrap), THEN wrap as untrusted external content (random delimiter +
      // injection warning + marker-sanitization) so a hijacked agent sees framed,
      // un-actionable text — never a bare injection payload. Only `screen` is
      // transformed; cursor/cols/rows/alt/alive/diff pass through unchanged.
      const { text: redacted, redactions } = scrubSecretsFromText(view.screen);
      const wrappedScreen = wrapExternalContent(redacted, { source: "unknown" });
      deps.logger.debug(
        { toolName: "terminal_session_read", sessionId, format, scrollback, redactions, step: "read" },
        "terminal session read",
      );
      return jsonResult({ ...view, screen: wrappedScreen });
    },
  };
}

/** `terminal_session_list` — owner-scoped session listing. */
export function createTerminalSessionListTool(deps: TerminalToolDeps): AgentTool<typeof ListParams> {
  return {
    name: "terminal_session_list",
    label: "Terminal: list sessions",
    description: "List the terminal sessions owned by the caller.",
    parameters: ListParams,

    async execute(
      _id: string,
      _params: object,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      // Owner-scoped — the caller sees ONLY its own (agentId, sessionKey) sessions.
      const rows: SessionListing[] = deps.registry.list(resolveOwner(deps));
      deps.logger.debug({ toolName: "terminal_session_list", count: rows.length, step: "list" }, "terminal sessions listed");
      return jsonResult(rows);
    },
  };
}

/** `terminal_session_kill` — terminate a session; the killed id drops from `list`. */
export function createTerminalSessionKillTool(deps: TerminalToolDeps): AgentTool<typeof KillParams> {
  return {
    name: "terminal_session_kill",
    label: "Terminal: kill session",
    description: "Terminate a terminal session (default SIGTERM).",
    parameters: KillParams,

    // 4-arg execute. NOTE: the EXPLICIT kill tool is the agent's intentional
    // terminate — it is NOT the turn abort. The abort-ends-the-call-never-the-session
    // invariant governs the OTHER tools' abort branch; an explicit
    // kill request from the agent stands on its own and is honoured here.
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      // Owner-scoped get+kill — a cross-owner kill is a registry no-op.
      const owner = resolveOwner(deps);
      // Read the exit code (if the session already exited) BEFORE killing.
      const handle = deps.registry.get(sessionId, owner);
      const exitCode = handle?.exitCode;
      await deps.registry.kill(sessionId, owner);
      // The EXPLICIT kill forgets the per-session cap state directly (KEEP this —
      // it complements the reap-path onCapForget so EVERY end-of-life forgets the cap
      // state; the kill tool is the agent's intentional terminate, not an evict).
      deps.caps.forget(sessionId);
      deps.logger.info({ toolName: "terminal_session_kill", sessionId, step: "kill" }, "terminal session killed");
      return jsonResult(exitCode === undefined ? { ok: true } : { ok: true, exitCode });
    },
  };
}

// ---------------------------------------------------------------------------
// Interaction tools (send_text / send_key / resize / wait).
//
// Each is a thin delegation to the matching registry forwarding method,
// which forwards a frame to the worker handler and resolves the
// post-action settled snapshot. These tools do NOT re-gate the allowlist (the
// session was gated at create) and never touch detectProvider — exactly the
// read/list/kill posture. They take the full TerminalToolDeps so the daemon hands
// one sharedDeps to all eight implemented tools.
// ---------------------------------------------------------------------------

/**
 * `terminal_session_send_text` — type `text` into the session; with `submit` the
 * worker settles then writes `\r` (a settle separates text from Enter);
 * with `bracketedPaste` the text is paste-wrapped. Returns the post-action
 * `{screen,cursor}`.
 */
export function createTerminalSessionSendTextTool(deps: TerminalToolDeps): AgentTool<typeof SendTextParams> {
  return {
    name: "terminal_session_send_text",
    label: "Terminal: send text",
    description: "Type text into a terminal session (optionally submit with Enter after a settle).",
    parameters: SendTextParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const owner = resolveOwner(deps);
      // abort ends the call, NOT the session — never registry.kill here. The
      // turn aborted, so end THIS call with the degraded snapshot; the session stays
      // alive in the registry for the next turn (session lifetime ⟂ turn lifetime).
      if (signal?.aborted) return jsonResult(ABORTED_SEND);
      const text = readString(params, "text") ?? "";
      const submit = readBool(params, "submit");
      const bracketedPaste = readBool(params, "bracketedPaste");
      // Enforce the per-session caps, THEN audit
      // EVERY invocation tagged with its outcome — BEFORE the registry forward. A
      // maxRequestsPerSession breach REJECTS (session survives); a maxInteractions /
      // wallClockMs breach EVICTS via registry.evict; either way the attempt is audited
      // (outcome:"rejected") and the rejection re-propagates (the forward is skipped).
      // No breach → audit outcome:"attempted", then forward. The redacted payload rides
      // the LOG only; the bus event carries counts/ids + the outcome (never the raw text).
      await enforceSendCapsThenAudit(deps, sessionId, owner, "terminal_session_send_text", "text", text);
      const start = deps.nowMs();
      const out: SendResult = await deps.registry.sendText(sessionId, owner, { text, submit, bracketedPaste });
      deps.logger.info(
        { toolName: "terminal_session_send_text", sessionId, durationMs: deps.nowMs() - start, step: "send_text" },
        "terminal session text sent",
      );
      return jsonResult(out);
    },
  };
}

/**
 * `terminal_session_send_key` — send named key chords (`["C-c"]`, `["Up","Enter"]`,
 * `["S-Tab"]`); the worker encodes each to its exact xterm bytes (an unknown key is
 * rejected at the worker, nothing written). Returns the post-action `{screen,cursor}`.
 */
export function createTerminalSessionSendKeyTool(deps: TerminalToolDeps): AgentTool<typeof SendKeyParams> {
  return {
    name: "terminal_session_send_key",
    label: "Terminal: send key",
    description: "Send named key chords (e.g. C-c, Up, S-Tab) to a terminal session.",
    parameters: SendKeyParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const owner = resolveOwner(deps);
      // abort ends the call, NOT the session — never registry.kill here.
      if (signal?.aborted) return jsonResult(ABORTED_SEND);
      const keys = readStringArray(params, "keys");
      // Same enforce-then-audit-EVERY-invocation
      // order as send_text. Keys are generally non-secret chords, but EVERY send is
      // audited (join + scrub for consistency) — including a cap-rejected one
      // (outcome:"rejected"); a clean pass audits outcome:"attempted" then forwards.
      await enforceSendCapsThenAudit(deps, sessionId, owner, "terminal_session_send_key", "key", keys.join(" "));
      const start = deps.nowMs();
      const out: SendResult = await deps.registry.sendKey(sessionId, owner, { keys });
      deps.logger.info(
        { toolName: "terminal_session_send_key", sessionId, durationMs: deps.nowMs() - start, step: "send_key" },
        "terminal session keys sent",
      );
      return jsonResult(out);
    },
  };
}

/**
 * `terminal_session_resize` — resize the session geometry (PTY winsize + the ring
 * geometry); the registry also updates the handle's `cols`/`rows` so `list()`/`read`
 * stay coherent. Returns `{ ok }`.
 */
export function createTerminalSessionResizeTool(deps: TerminalToolDeps): AgentTool<typeof ResizeParams> {
  return {
    name: "terminal_session_resize",
    label: "Terminal: resize",
    description: "Resize a terminal session (columns + rows).",
    parameters: ResizeParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const owner = resolveOwner(deps);
      // abort ends the call, NOT the session — never registry.kill here.
      if (signal?.aborted) return jsonResult({ ok: false });
      // cols/rows are schema-typed integers, but VALIDATE the value range here
      // (1..MAX_DIMENSION) and reject a degenerate geometry (0/negative/non-integer/
      // absurd) with a typed invalid_value BEFORE forwarding to the emulator/PTY — the
      // tool must not push a bad winsize into the worker (an aborted call returned above).
      const cols = readDimension(params, "cols");
      const rows = readDimension(params, "rows");
      const start = deps.nowMs();
      const out = await deps.registry.resize(sessionId, owner, { cols, rows });
      deps.logger.info(
        { toolName: "terminal_session_resize", sessionId, durationMs: deps.nowMs() - start, step: "resize" },
        "terminal session resized",
      );
      return jsonResult(out);
    },
  };
}

/**
 * `terminal_session_wait` — a bounded in-turn settle on idle/text/exit.
 * Returns `{matched,isComplete,reason,screen,cursor}` VERBATIM from the registry —
 * on timeout the load-bearing `isComplete:false` survives (the attention model
 * resumes the turn). This tool is read-only (it observes a settle; it writes
 * nothing), so it logs DEBUG. It NEVER coerces `isComplete`.
 */
export function createTerminalSessionWaitTool(deps: TerminalToolDeps): AgentTool<typeof WaitParams> {
  return {
    name: "terminal_session_wait",
    label: "Terminal: wait",
    description: "Wait for a terminal session to settle (idle, a text match, or exit); bounded by a timeout.",
    parameters: WaitParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const owner = resolveOwner(deps);
      // abort ends the call, NOT the session — never registry.kill here.
      // The turn aborted mid-settle: return the honest not-complete shape (NEVER
      // isComplete:true — a false true would strand the agent) and leave the session
      // alive for the next turn to resume the settle.
      if (signal?.aborted) {
        return jsonResult({ matched: false, isComplete: false, reason: "aborted", screen: "", cursor: { x: 0, y: 0 } });
      }
      const forIdleMs = readOptInt(params, "forIdleMs");
      const forText = readString(params, "forText");
      const forExit = readBool(params, "forExit");
      const timeoutMs = readOptInt(params, "timeoutMs");
      const start = deps.nowMs();
      const out: WaitResult = await deps.registry.wait(sessionId, owner, { forIdleMs, forText, forExit, timeoutMs });
      deps.logger.debug(
        {
          toolName: "terminal_session_wait",
          sessionId,
          durationMs: deps.nowMs() - start,
          reason: out.reason,
          isComplete: out.isComplete,
          step: "wait",
        },
        "terminal session settle resolved",
      );
      return jsonResult(out);
    },
  };
}
