// SPDX-License-Identifier: Apache-2.0
/**
 * The eight implemented terminal-driver AgentTool factories (spec §5):
 * `terminal_session_create` / `_read` / `_list` / `_kill` (P0, 119-04) and the
 * four P1 interaction tools `_send_text` / `_send_key` / `_resize` / `_wait`
 * (this plan). (`terminal_session_status` is the lone remaining stub →
 * `terminal-tools-stubs.ts`, Phase 124.)
 *
 * `create` is the gate that composes the whole P0 substrate:
 *   1. ALLOWLIST GATE (SEC-01): `matchAllowEntry(command, allowEntries)` — a
 *      command whose canonical binary matches no operator entry is rejected with
 *      `permission_denied` and NEVER reaches the registry (no worker spawn). The
 *      matcher (119-02) enforces realpath + the optional hash pin.
 *   2. FAIL-CLOSED (SEC-16): if `detectProvider()` returns `undefined` there is
 *      no sandbox runtime — `create` rejects rather than spawn an unsandboxed
 *      child. Demonstrated on the Phase-118 stack (G-5).
 *   3. CANONICALIZE (M-1, SEC-14 end-to-end): `buildDirectSpawn(entry, command,
 *      args)` is the SOLE canonicalization site — it resolves the realpath and
 *      prepends the operator's `argsPrefix`. The resulting `{bin,argv}` (NOT the
 *      raw command) is handed to the registry, so the worker spawns the canonical
 *      target verbatim and never re-derives realpath (the argsPrefix guarantee
 *      holds end-to-end).
 *   4. OBSERVABILITY (OPS-07): a successful transition logs INFO + `durationMs` +
 *      emits `terminal:session_state`; a spawn failure logs WARN + `hint` +
 *      `errorKind` + emits `terminal:spawn_failed`, then rethrows.
 *
 * `read` / `list` / `kill` and the four interaction tools (`send_text` /
 * `send_key` / `resize` / `wait`) are thin delegations to the injected registry —
 * they operate on an ALREADY-GATED session (create enforced SEC-01/SEC-16), so
 * they do NOT re-run the allowlist gate and never touch `detectProvider` (the
 * read/list/kill precedent). The registry's forwarding methods (120-03) carry the
 * post-action settled snapshot back; `wait`'s `isComplete:false` survives verbatim.
 *
 * Architecture: this module is daemon-side but lives in `@comis/skills`, so it
 * takes an INJECTED structural logger + event bus (never `getLogger` from
 * `@comis/infra` — the registry mirrors this). The daemon (composition root,
 * 119-04 wiring) passes the real logger + the `TypedEventBus`. Clock is the
 * injected `nowMs` (no raw wall-clock global).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { jsonResult, throwToolError } from "../../../platform-tools/tool-helpers.js";
import { matchAllowEntry, buildDirectSpawn, type AllowEntryLike } from "./allowlist-matcher.js";
import type { SandboxProvider } from "../sandbox/types.js";
import type {
  TerminalSessionRegistry,
  TerminalView,
  SendResult,
  WaitResult,
  SessionListing,
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

/**
 * A structural event-bus surface scoped to the two P0 terminal events. The
 * daemon passes its `TypedEventBus` (structurally compatible); tests pass a
 * capturing fake. Kept structural so the skills layer never value-imports the
 * concrete bus class.
 */
export interface TerminalEventBus {
  emit(event: "terminal:session_state", payload: TerminalStateEvent): unknown;
  emit(event: "terminal:spawn_failed", payload: TerminalSpawnFailedEvent): unknown;
}

/** Dependencies shared by all four implemented tools. */
export interface TerminalToolDeps {
  /** The daemon-side session registry (119-03) that spawns + supervises the worker. */
  readonly registry: TerminalSessionRegistry;
  /** The operator allow-set (parsed config mapped onto `AllowEntryLike`); the SEC-01 trust source. */
  readonly allowEntries: AllowEntryLike[];
  /**
   * Sandbox-provider detector (SEC-16). Injected so the fail-closed test can
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
// create (the gate — SEC-01 / SEC-16 / M-1 / OPS-07)
// ---------------------------------------------------------------------------

/**
 * `terminal_session_create` — gate on the allowlist (SEC-01), fail closed on a
 * missing sandbox provider (SEC-16), canonicalize via the sole `buildDirectSpawn`
 * site (M-1), then register a session and emit the OPS-07 transition.
 */
export function createTerminalSessionCreateTool(deps: TerminalToolDeps): AgentTool<typeof CreateParams> {
  return {
    name: "terminal_session_create",
    label: "Terminal: create session",
    description:
      "Start an interactive terminal session driving an allowlisted binary. Rejected unless the canonical command matches an operator allowlist entry.",
    parameters: CreateParams,

    async execute(_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const allowId = readString(params, "allowId") ?? "";
      const command = readString(params, "command") ?? "";
      const args = readStringArray(params, "args");
      const cols = readInt(params, "cols", DEFAULT_COLS);
      const rows = readInt(params, "rows", DEFAULT_ROWS);

      // (1) ALLOWLIST GATE (SEC-01). matchAllowEntry (119-02) resolves the
      // realpath ONCE + the optional hash pin; a non-match rejects BEFORE any
      // spawn. The result carries the verified `requestedReal` (MR-02) so the
      // hash-checked inode is the exact one threaded to spawn — no second resolve.
      const matched = matchAllowEntry(command, deps.allowEntries);
      if (matched === undefined) {
        throwToolError("permission_denied", `command not allowlisted: ${command}`, {
          hint: "the requested binary does not match any operator allowlist entry's canonical path",
        });
      }

      // (2) FAIL-CLOSED (SEC-16). No sandbox runtime ⇒ refuse — never spawn an
      // unsandboxed child. The bare-metal (bwrap removed) confirmation is VPS-gated.
      const provider = deps.detectProvider();
      if (!provider) {
        throwToolError(
          "permission_denied",
          "no sandbox provider available; refusing unsandboxed terminal (fail-closed)",
          { hint: "install a sandbox runtime (e.g. bubblewrap on Linux) so sessions can be confined" },
        );
      }

      // (3) CANONICALIZE (M-1, SEC-14 end-to-end). buildDirectSpawn consumes the
      // matcher's already-resolved realpath (MR-02 — no second resolution) and
      // prepends the operator's argsPrefix ahead of the agent args. We forward
      // {bin,argv} — NOT the raw command — so the worker spawns the verified
      // canonical inode verbatim.
      const { bin, argv } = buildDirectSpawn(matched.entry, matched.requestedReal, args);

      // (4) REGISTER + OBSERVE (OPS-07). A spawn failure logs hint+errorKind and
      // emits terminal:spawn_failed before rethrowing.
      const start = deps.nowMs();
      let result;
      try {
        result = await deps.registry.create({ allowId, bin, argv, cols, rows });
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
        // execution boundary after recording OPS-07 observability; the SDK catches
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

    async execute(_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const view: TerminalView = await deps.registry.read(sessionId);
      deps.logger.debug({ toolName: "terminal_session_read", sessionId, step: "read" }, "terminal session read");
      // SEC-15 (P3): wrap read output as untrusted external content (a driven CLI
      // can render attacker-controlled text). The wrapExternalContent seam lands
      // in Phase 122; P0 returns the view bare and keeps this seam explicit.
      return jsonResult(view);
    },
  };
}

/** `terminal_session_list` — owner-scoped session listing (P0 single-owner; origin-keying is P4). */
export function createTerminalSessionListTool(deps: TerminalToolDeps): AgentTool<typeof ListParams> {
  return {
    name: "terminal_session_list",
    label: "Terminal: list sessions",
    description: "List the terminal sessions owned by the caller.",
    parameters: ListParams,

    async execute(_id: string, _params: object): Promise<AgentToolResult<unknown>> {
      const rows: SessionListing[] = deps.registry.list();
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

    async execute(_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      // Read the exit code (if the session already exited) BEFORE killing.
      const handle = deps.registry.get(sessionId);
      const exitCode = handle?.exitCode;
      await deps.registry.kill(sessionId);
      deps.logger.info({ toolName: "terminal_session_kill", sessionId, step: "kill" }, "terminal session killed");
      return jsonResult(exitCode === undefined ? { ok: true } : { ok: true, exitCode });
    },
  };
}

// ---------------------------------------------------------------------------
// Interaction tools (send_text / send_key / resize / wait) — TR-03/04/05.
//
// Each is a thin delegation to the matching registry forwarding method (120-03),
// which forwards a frame to the worker handler (120-04) and resolves the
// post-action settled snapshot. These tools do NOT re-gate the allowlist (the
// session was gated at create) and never touch detectProvider — exactly the
// read/list/kill posture. They take the full TerminalToolDeps so the daemon hands
// one sharedDeps to all eight implemented tools.
// ---------------------------------------------------------------------------

/**
 * `terminal_session_send_text` — type `text` into the session; with `submit` the
 * worker settles then writes `\r` (a settle separates text from Enter, TR-04);
 * with `bracketedPaste` the text is paste-wrapped. Returns the post-action
 * `{screen,cursor}`.
 */
export function createTerminalSessionSendTextTool(deps: TerminalToolDeps): AgentTool<typeof SendTextParams> {
  return {
    name: "terminal_session_send_text",
    label: "Terminal: send text",
    description: "Type text into a terminal session (optionally submit with Enter after a settle).",
    parameters: SendTextParams,

    async execute(_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const text = readString(params, "text") ?? "";
      const submit = readBool(params, "submit");
      const bracketedPaste = readBool(params, "bracketedPaste");
      const start = deps.nowMs();
      const out: SendResult = await deps.registry.sendText(sessionId, { text, submit, bracketedPaste });
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

    async execute(_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const keys = readStringArray(params, "keys");
      const start = deps.nowMs();
      const out: SendResult = await deps.registry.sendKey(sessionId, { keys });
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

    async execute(_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      // cols/rows are required by the schema; the readers fall back defensively.
      const cols = readInt(params, "cols", 0);
      const rows = readInt(params, "rows", 0);
      const start = deps.nowMs();
      const out = await deps.registry.resize(sessionId, { cols, rows });
      deps.logger.info(
        { toolName: "terminal_session_resize", sessionId, durationMs: deps.nowMs() - start, step: "resize" },
        "terminal session resized",
      );
      return jsonResult(out);
    },
  };
}

/**
 * `terminal_session_wait` — a bounded in-turn settle on idle/text/exit (TR-05).
 * Returns `{matched,isComplete,reason,screen,cursor}` VERBATIM from the registry —
 * on timeout the load-bearing `isComplete:false` survives (the P5 attention model
 * resumes the turn). This tool is read-only (it observes a settle; it writes
 * nothing), so it logs DEBUG. It NEVER coerces `isComplete`.
 */
export function createTerminalSessionWaitTool(deps: TerminalToolDeps): AgentTool<typeof WaitParams> {
  return {
    name: "terminal_session_wait",
    label: "Terminal: wait",
    description: "Wait for a terminal session to settle (idle, a text match, or exit); bounded by a timeout.",
    parameters: WaitParams,

    async execute(_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const sessionId = readString(params, "sessionId") ?? "";
      const forIdleMs = readOptInt(params, "forIdleMs");
      const forText = readString(params, "forText");
      const forExit = readBool(params, "forExit");
      const timeoutMs = readOptInt(params, "timeoutMs");
      const start = deps.nowMs();
      const out: WaitResult = await deps.registry.wait(sessionId, { forIdleMs, forText, forExit, timeoutMs });
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
