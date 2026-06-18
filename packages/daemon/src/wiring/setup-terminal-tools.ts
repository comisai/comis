// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-side wiring for the interactive terminal driver.
 *
 * The daemon is the composition root — the only package that may value-import
 * `@comis/infra` — so it constructs the per-agent `TerminalSessionRegistry`
 * (injecting the real logger + the production worker-spawn posture) and pushes
 * the nine terminal tools (eight implemented + one stub [`status`]) into the agent
 * tool set. The eight implemented tools (create/read/list/kill + the four
 * interaction tools send_text/send_key/wait/resize) all share one `sharedDeps`
 * (the injected registry + allow-set + provider + logger/bus/clock); `status` is
 * the lone no-arg stub. All nine are registered
 * `mcpExportPolicy:"never-export"`, so they stay inside Comis's trust
 * boundary and never reach MCP.
 *
 * Extracted from `setup-tools.ts` to keep that file under the 800-line
 * architecture cap. State (the per-agent registry map) lives in the `setupTools`
 * closure and is threaded in here — there is NO module-global mutable state.
 *
 * Fail-closed by construction at this stage: the operator
 * `TerminalDriverConfig.allow[]` is not yet threaded into `PerAgentConfig` (that
 * config-plumbing + the worker process entrypoint are later work), so
 * the wired allow-set is EMPTY — every `terminal_session_create` is rejected by
 * the allowlist gate (`matchAllowEntry` returns undefined) before any worker is
 * spawned. The surface is live + governed; the worker is never spawned until both
 * the allow-set and the worker main land. The seam is clean.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import type { ComisLogger } from "@comis/infra";
// The daemon does not depend on the pi SDK directly — it references the tool
// array type via @comis/skills' PlatformToolProvider (= () => AgentTool[]), the
// same way setup-tools.ts types its `tools` array.
import type { PlatformToolProvider } from "@comis/skills";

/** The daemon tool-assembly array element type (an `AgentTool`), via skills. */
type AgentToolArray = ReturnType<PlatformToolProvider>;

/** The closed `terminal:escalated` reason union (mirrors `events-terminal.ts`). */
type EscalationReason =
  | "destructive"
  | "approval"
  | "auth_login"
  | "loop_detected"
  | "hop_limit"
  | "stuck"
  | "no_safe_match";

/** The runtime allowlist of valid escalation reasons — an off-union frame value falls
 * back to `no_safe_match` (never trusted verbatim onto the closed bus union). */
const ESCALATION_REASONS = new Set<string>([
  "destructive",
  "approval",
  "auth_login",
  "loop_detected",
  "hop_limit",
  "stuck",
  "no_safe_match",
]);
import {
  createTerminalSessionRegistry,
  terminalWorkerDir,
  buildProductionSpawnWorker,
  resolveWorkerMainPath,
  createTerminalEgressProxy,
  prepareAgentTerminalWorkspace,
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionKillTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionWaitTool,
  createTerminalSessionStatusTool,
  createTerminalSessionResizeTool,
  createSessionCaps,
  type TerminalSessionRegistry,
  type TerminalEventBus,
  type TerminalEventFrame,
  type ReaperEvictInfo,
  type AllowEntryLike,
  type TerminalScope,
  type SandboxProvider,
  type SessionCaps,
} from "@comis/skills/tools";
import {
  systemNowMs,
  type TerminalAllowEntry,
  type TerminalDriverConfig,
  type ApprovalGate,
  type EgressControlPort,
  type TimerPort,
} from "@comis/core";
import { buildAgentTerminalDurability, type DurabilityEventBus } from "./terminal-durable-wiring.js";

/** Dependencies the terminal-driver wiring needs from the composition root. */
export interface TerminalWiringDeps {
  /** Base data dir (~/.comis) — scopes the worker's durable-state fs-write. */
  readonly dataDir: string;
  /** Module-bound skills logger (the real `@comis/infra` logger). */
  readonly skillsLogger: ComisLogger;
  /** The daemon's typed event bus (structurally compatible with `TerminalEventBus`). */
  readonly eventBus: TerminalEventBus;
  /**
   * The daemon's once-detected sandbox provider. Detected ONCE at daemon
   * startup (the same value the exec path threads via `sandboxCfg.sandbox`) and
   * reused here — so the create gate's fail-closed branch reads the cached
   * provider instead of re-running the blocking `detectSandboxProvider()`
   * (`spawnSync("bwrap")` smoke test) on every create. `undefined` ⇒ no sandbox
   * runtime ⇒ create fail-closes (the fail-closed posture is unchanged).
   */
  readonly sandboxProvider: SandboxProvider | undefined;
  /**
   * The daemon's operator approval gate. The same `ApprovalGate` the
   * exec path uses (constructed once in `setup-tools.ts`). Threaded into the
   * terminal tools' `sharedDeps` so a `approveOnCreate` entry gates `session_create`
   * on operator consent. Optional: when absent, an `approveOnCreate` entry
   * fail-closes (reject) — it never runs unauthorized.
   */
  readonly approvalGate?: ApprovalGate;
  /**
   * The host-side no-secret allowlist egress proxy, constructed at the
   * composition root (`createTerminalEgressProxy`) and injected here as the
   * {@link EgressControlPort}. Threaded toward the worker path so the worker can
   * call `materialize(scope.hosts)` for `network: listed-hosts` and bind-mount the
   * returned socket. Optional: absent => no `listed-hosts` egress is materialized
   * (the create gate + scope still enforce `none`/`full`); never a silent open.
   */
  readonly egressControl?: EgressControlPort;
  /**
   * The resolved `bwrap` binary path (the daemon detects it ONCE at startup, the
   * same value the sandbox provider resolves via `which bwrap`). Threaded toward
   * the worker path so it can be passed to `buildScopeArgs({ bwrapPath, ... })`
   * (the scope->argv composer needs the explicit path; it is NOT implicit). Made
   * EXPLICIT here — do not leave bwrapPath implicit.
   */
  readonly bwrapPath?: string;
  /**
   * The resolved per-agent workspace dir (see {@link TerminalWiringBaseDeps.agentWorkspaceDir}).
   * Present ⇒ the per-agent registry roots sessions in `<agentWorkspaceDir>/projects`
   * (persistent, agent-scoped) with a no-op cleanup; absent ⇒ the throwaway `/tmp`
   * default. The injected workspace is re-bound RW after the `~/.comis` carve-out by
   * `buildScopeArgs`, so it is writable in the jail while secrets stay masked.
   */
  readonly agentWorkspaceDir?: string;
  /**
   * Reaper caps — the closed `worker.{maxSessions,idleTtlMs,
   * stuckMs}` (schema-skills.ts) + the per-entry `limits.wallClockMs` (default 0
   * while the allow-set is empty). Threaded into the per-agent registry's reaper so
   * the session footprint is bounded (max-sessions overflow on create, idle-TTL +
   * wall-clock-age on the sweep). Optional: absent ⇒ no reaper.
   */
  readonly workerCaps?: { maxSessions: number; idleTtlMs: number; wallClockMs: number; stuckMs: number };
  /**
   * The injected `TimerPort` (the daemon constructs `createSystemTimers()` at the
   * composition root) driving the reaper sweep. Type-only from `@comis/core`; the
   * registry/reaper take it as a port (worker ↛ infra). Absent ⇒ no reaper sweep.
   */
  readonly timers?: TimerPort;
  /**
   * The shared per-agent {@link SessionCaps} instance. Threaded so the
   * registry's `onCapForget` is wired to `caps.forget` — the per-session cap state is
   * dropped on EVERY eviction (idle/wall_clock/max_sessions/max_interactions), not
   * only the tool kill path (no SessionCaps Map leak on the reap path).
   */
  readonly caps?: SessionCaps;
  /**
   * The parsed operator terminal-driver config (124-09 — the WR-01 closure). When present,
   * `config.allow` POPULATES the per-agent allow-set (`config.allow.map(mapAllowEntry)`) so
   * the create gate matches an allowlisted binary + the per-session caps go live; the
   * mapped `scope`/`approveOnCreate`/`limits` ride the create frame, and `autoAnswer`/
   * `hintPatterns`/`backend` are consumed by the wake-FSM woken turn (auto-answer policy)
   * + the worker (backend selection). Absent ⇒ the wired allow-set is EMPTY (every create
   * fail-closes) — the pre-P5 posture.
   */
  readonly config?: TerminalDriverConfig;
}

/**
 * Map a parsed config `TerminalAllowEntry` onto the skills-side `AllowEntryLike`
 * — the SINGLE site config scope becomes an `AllowEntryLike`.
 *
 * Copies `{ id, match, scope }`: the operator-declared scope is carried verbatim so
 * it threads on to the create frame (scope must NOT be dropped
 * at the daemon boundary). The config schema already applied the least-privilege
 * `.default(...)` to every scope sub-field, so this is a pure passthrough — no
 * defaulting / widening here (scope is operator-only, never agent-dialable). When
 * the config-plumbing step lands it does `config.allow.map(mapAllowEntry)` and scope
 * flows automatically; until then the wired allow-set stays empty (fail-closed).
 *
 * The `scope` cast is structural-identity: the config `scope` strictObject and the
 * skills `TerminalScope` are the same closed union (the latter hand-mirrors the
 * former); the daemon bridges the two package types at this composition seam.
 */
export function mapAllowEntry(entry: TerminalAllowEntry): AllowEntryLike {
  return {
    id: entry.id,
    match: entry.match,
    scope: entry.scope as TerminalScope,
    // Carry the operator's approveOnCreate consent flag verbatim (a sibling
    // of scope) so the create tool can gate on it — never dropped at the boundary.
    approveOnCreate: entry.approveOnCreate,
    // Carry the operator's per-entry usage caps verbatim (a sibling of
    // scope/approveOnCreate) so the daemon builds the per-agent SessionCaps from them —
    // never dropped at the boundary (the silent-no-op/security regression class).
    limits: entry.limits,
  };
}

/**
 * Resolve the standalone worker process entry (`terminal-worker-main.js`) that
 * the production worker-spawn posture forks (`node <permission-args> <workerJs>`).
 * Delegates to `@comis/skills`'s own dist-location resolver
 * ({@link resolveWorkerMainPath}) — the entry ships INSIDE the skills package, so
 * its path is computed from that module's URL, correct across install locations
 * (global npm prefix / bundled tarball / dev dist) and NEVER a data-dir
 * placeholder. The worker mkdir's its durable-state dir under `<dataDir>` itself
 * (the daemon injects `COMIS_TERMINAL_DATA_DIR` + scopes `--allow-fs-write` there).
 */
function resolveWorkerJsPath(_dataDir: string): string {
  return resolveWorkerMainPath();
}

/**
 * RECUR-03 (option A, per-generation tmux server): this daemon generation's PER-BOOT tmux `-S`
 * socket — `<dataDir>/terminal-worker/tmux-<daemonPid>.sock`. MEMOIZED so EVERY agent's registry
 * (the descriptor/handle stamp) AND the worker (`COMIS_TERMINAL_TMUX_SOCKET`) share ONE socket per
 * daemon process. Keyed on the daemon PID: stable for the daemon's life (so a worker respawn reuses
 * it), unique per restart (a new daemon PID → a new socket). So a restart's NEW sessions are created
 * on a fresh server in the LIVE mount namespace — a stranded prior-generation ns (PrivateTmp/
 * ProtectHome + KillMode=process, RECUR-02) never breaks new bwrap sessions — while a surviving
 * durable re-attaches from its OWN (prior-boot) socket recorded on its descriptor.
 */
let cachedBootTmuxSocket: string | undefined;
function bootTmuxSocketPath(dataDir: string): string {
  if (cachedBootTmuxSocket === undefined) {
    cachedBootTmuxSocket = `${terminalWorkerDir(dataDir)}/tmux-${process.pid}.sock`;
  }
  return cachedBootTmuxSocket;
}

/**
 * Build the daemon-side reaper eviction hooks for one agent —
 * mirrors the `onSpawnFailed` template. `onEvict` closes the observability loop on
 * EVERY reaped session: it emits `terminal:session_evicted` (the audited reason) +
 * `terminal:session_state` (state→`lost`, the lifecycle transition) + a WARN
 * (`hint` + `errorKind: "resource"`, §2.7) — so a reap is reconstructable from
 * logs+events alone. `onCapForget` is wired to the shared `caps.forget` so the
 * per-session cap state is dropped on the reap path (no SessionCaps Map
 * leak). Exported so the audit wiring is unit-testable in isolation.
 */
export function buildTerminalReaperHooks(
  agentId: string,
  deps: TerminalWiringDeps,
): { onEvict: (info: ReaperEvictInfo) => void; onCapForget: (sessionId: string) => void } {
  return {
    onEvict: ({ sessionId, reason, durationMs }) => {
      const timestamp = systemNowMs();
      deps.eventBus.emit("terminal:session_evicted", { sessionId, agentId, reason, durationMs, timestamp });
      deps.eventBus.emit("terminal:session_state", { sessionId, agentId, state: "lost", durationMs, timestamp });
      deps.skillsLogger.warn(
        { sessionId, agentId, reason, durationMs, hint: "terminal session evicted by reaper", errorKind: "resource" as const },
        "terminal session evicted",
      );
    },
    // Drop the per-session cap state on EVERY eviction (not only the tool kill).
    onCapForget: (sessionId) => deps.caps?.forget(sessionId),
  };
}

/**
 * Build the daemon-side fd3 attention emit hook for one agent (124-09 Task 1; TR-11 /
 * SEC-11/12 / OPS-04) — the 3rd emit-hook site, mirroring {@link buildTerminalReaperHooks}
 * + the `onSpawnFailed` template. The returned `onTerminalEvent` closure is bound on the
 * registry deps (next to `onSpawnFailed`): for each decoded {@link TerminalEventFrame} the
 * worker pushes on fd3 (124-05, the no-poll attention channel), it RE-PUBLISHES the frame
 * onto the daemon's `TypedEventBus` as the matching closed `terminal:*` event — injecting
 * `agentId` (the worker is owner-agnostic) + `timestamp` and copying ONLY the structural
 * fields off `frame.payload`. This is the re-publish seam the wake-FSM (Task 2) subscribes.
 *
 * REDACTION-SAFE BY CONSTRUCTION (T-124-25): the hook copies ONLY the typed structural
 * fields per event (`state`/`reason`/`noProgressMs`) — a `screen`/`text`/`payload` field
 * on the worker frame is NEVER read, so screen text physically cannot cross the bus. The
 * worker frame is already redaction-safe (124-05); this is defense-in-depth.
 *
 * §2.7 observability: a wake (`input_needed`) is an INFO completion-style line (step-
 * tagged); an `escalated` frame is a WARN carrying `hint` + `errorKind` so the next
 * escalation is reconstructable from logs+events alone. An unknown/unmodeled event kind
 * is dropped (no emit, no throw) — the hook never forwards an unmodeled frame.
 *
 * Exported so the re-publish wiring is unit-testable in isolation (Task 1).
 */
export function buildTerminalEventHook(
  agentId: string,
  deps: TerminalWiringDeps,
): { onTerminalEvent: (frame: TerminalEventFrame) => void } {
  return {
    onTerminalEvent: (frame: TerminalEventFrame) => {
      const timestamp = systemNowMs();
      // The worker payload is an unknown structural bag (the IPC frame body); read
      // ONLY the typed structural fields per event — never a screen/text field.
      const p = (frame.payload ?? {}) as Record<string, unknown>;
      switch (frame.event) {
        case "terminal:input_needed": {
          // The attention wake (TR-11). state ∈ {awaiting-input, stuck}; reason is the
          // classifier's structural tag (e.g. "settled_cursor_parked") — never screen text.
          const state = p.state === "stuck" ? "stuck" : "awaiting-input";
          const reason = typeof p.reason === "string" ? p.reason : "input_needed";
          // CLASS-02: the classifier confidence rides the wake event (for the autonomous
          // policy 164–166 + a future `comis explain`). Read DEFENSIVELY off the untrusted
          // frame (T-163-11) — an out-of-enum value falls back to "medium", never raw.
          const confidence = p.confidence === "high" || p.confidence === "medium" ? p.confidence : "medium";
          deps.eventBus.emit("terminal:input_needed", { sessionId: frame.sessionId, agentId, state, reason, confidence, timestamp });
          deps.skillsLogger.info(
            { sessionId: frame.sessionId, agentId, state, reason, confidence, step: "terminal_input_needed" },
            "terminal session needs input (re-published from fd3)",
          );
          break;
        }
        case "terminal:stuck": {
          // Settled, no affordance, no progress past stuckMs (OPS-04) — a duration signal.
          const noProgressMs = typeof p.noProgressMs === "number" ? p.noProgressMs : 0;
          // CLASS-02: stuck now carries the classifier reason + confidence (observability
          // symmetry with input_needed). Both read DEFENSIVELY off the untrusted frame
          // (T-163-11), mirroring the existing noProgressMs narrow — never a raw value.
          const reason = typeof p.reason === "string" ? p.reason : "no_progress";
          const confidence = p.confidence === "high" || p.confidence === "medium" ? p.confidence : "medium";
          deps.eventBus.emit("terminal:stuck", { sessionId: frame.sessionId, agentId, noProgressMs, reason, confidence, timestamp });
          deps.skillsLogger.info(
            { sessionId: frame.sessionId, agentId, noProgressMs, reason, confidence, step: "terminal_stuck" },
            "terminal session stuck (re-published from fd3)",
          );
          break;
        }
        case "terminal:session_state": {
          // A per-session PTY exit (the worker hosts other sessions — this is the signal).
          const state = p.state === "exited" ? "exited" : "lost";
          deps.eventBus.emit("terminal:session_state", { sessionId: frame.sessionId, agentId, state, durationMs: 0, timestamp });
          break;
        }
        case "terminal:escalated": {
          // An escalation audit (SEC-11/12). Typed closed reason ONLY; the prompt rides the LOG.
          const reason = ESCALATION_REASONS.has(p.reason as string) ? (p.reason as EscalationReason) : "no_safe_match";
          deps.eventBus.emit("terminal:escalated", { sessionId: frame.sessionId, agentId, reason, timestamp });
          deps.skillsLogger.warn(
            {
              sessionId: frame.sessionId,
              agentId,
              reason,
              hint: "terminal session escalated to a human (auto-answer declined / loop / hop-limit)",
              errorKind: "precondition" as const,
            },
            "terminal session escalated",
          );
          break;
        }
        case "terminal:auto_answered": {
          // A safe-pattern answer was sent (SEC-12): the matched index + keystroke COUNT only.
          const matchedPatternIndex = typeof p.matchedPatternIndex === "number" ? p.matchedPatternIndex : -1;
          const keystrokeCount = typeof p.keystrokeCount === "number" ? p.keystrokeCount : 0;
          deps.eventBus.emit("terminal:auto_answered", { sessionId: frame.sessionId, agentId, matchedPatternIndex, keystrokeCount, timestamp });
          break;
        }
        default:
          // Unknown/unmodeled event kind — drop it (never forward an unmodeled frame).
          deps.skillsLogger.debug(
            { sessionId: frame.sessionId, agentId, event: frame.event, step: "terminal_event_dropped" },
            "terminal fd3 frame with an unmodeled event kind dropped",
          );
      }
    },
  };
}

/**
 * Get (or lazily create) the per-agent `TerminalSessionRegistry`. The map lives
 * in the `setupTools` closure (passed in) — no module-global state. The registry
 * is constructed with the proven `--permission` worker-spawn posture
 * (`buildProductionSpawnWorker`) scoped to the agent's data dir.
 */
function getOrCreateTerminalRegistry(
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
  caps: SessionCaps,
): TerminalSessionRegistry {
  let registry = registries.get(agentId);
  if (!registry) {
    // Thread the SHARED per-agent caps instance into the reaper hooks so onCapForget
    // forgets the SAME cap-state map the tool deps consume (one instance for both).
    const reaperHooks = buildTerminalReaperHooks(agentId, { ...deps, caps });
    // DUR-01 / ENDURE-01 (165-07): the per-agent durability wiring — the descriptor store +
    // has-session probe + recover/unrecoverable hooks (the registry's recover-on-boot, 165-06)
    // + the reaper isBusy idle-exclusion predicate (165-08's seam, bound to busyOrHung). The
    // isBusy reads the live handle via the registries map (resolved by agentId at sweep time);
    // it is constructed BEFORE the registry but only invoked AFTER it is in the map (the reaper
    // sweep runs on a timer post-construction), so the lazy `registries.get(agentId)` resolves.
    const { durability, isBusy } = buildAgentTerminalDurability({
      dataDir: deps.dataDir,
      agentId,
      // The runtime eventBus is the daemon's full TypedEventBus (it supports
      // terminal:drive_reattached, which the narrow skills-side TerminalEventBus static type
      // omits); bridge to the DurabilityEventBus contract the hooks emit on.
      eventBus: deps.eventBus as unknown as DurabilityEventBus,
      logger: deps.skillsLogger,
      registries,
      workerStuckMs: deps.workerCaps?.stuckMs ?? 0,
      nowMs: systemNowMs,
    });
    // The agent's OWN workspace, captured for the allocator closure (const ⇒ TS narrows
    // it to string inside the arrow). Present ⇒ sessions are PERSISTENT + agent-scoped.
    const agentWs = deps.agentWorkspaceDir;
    registry = createTerminalSessionRegistry({
      spawnWorker: buildProductionSpawnWorker(resolveWorkerJsPath(deps.dataDir), deps.dataDir, bootTmuxSocketPath(deps.dataDir)),
      // RECUR-03: stamp this boot's per-boot socket on durable handles/descriptors (MUST match the
      // worker's COMIS_TERMINAL_TMUX_SOCKET above — both from bootTmuxSocketPath).
      currentTmuxSocket: bootTmuxSocketPath(deps.dataDir),
      logger: deps.skillsLogger,
      nowMs: systemNowMs,
      // The daemon-resolved bwrap path rides the create
      // frame to the worker's fail-closed branch; the live egress port is the
      // daemon->worker-main seam for `listed-hosts`. Both undefined on a no-sandbox
      // host ⇒ the worker fail-closes (no unjailed spawn).
      bwrapPath: deps.bwrapPath,
      egressControl: deps.egressControl,
      // Agent-workspace persistence: root each session in the agent's OWN workspace
      // (`<agentWorkspaceDir>/projects`) with a NO-OP cleanup, so a driven session's
      // work (e.g. a full GSD milestone's app) survives the session end and the agent
      // sees it under its workspace — instead of a throwaway /tmp dir rm'd on kill.
      // `buildScopeArgs` re-binds ONLY this subtree RW after the ~/.comis carve-out,
      // so the agent's secrets + its other workspace files stay masked in the jail.
      // Absent agentWorkspaceDir (test paths) ⇒ the ephemeral mkdtemp default stands.
      ...(agentWs
        ? {
            allocateWorkspace: () => prepareAgentTerminalWorkspace(agentWs),
            cleanupWorkspace: () => {
              /* persistent: never rm the agent's own workspace on session end */
            },
          }
        : {}),
      // Turn a worker backend-spawn failure (an `ok:false` create
      // reply, which the registry uses to flip the session to `lost`) into the
      // `terminal:spawn_failed` bus event. The registry already logged the WARN +
      // flipped the handle; this closes the observability loop on the bus.
      onSpawnFailed: ({ sessionId, error }) => {
        deps.eventBus.emit("terminal:spawn_failed", {
          sessionId,
          agentId,
          hint: error ?? "worker backend spawn failed",
          errorKind: "dependency",
          timestamp: systemNowMs(),
        });
      },
      // 124-09 (TR-11): re-publish each fd3 attention frame (terminal:input_needed /
      // stuck / session_state / escalated / auto_answered) onto the TypedEventBus —
      // the no-poll seam the wake-FSM (setup-terminal-wake.ts) subscribes. The HR-02
      // guard runs BEFORE this; a corrupt frame drops the worker and never reaches it.
      onTerminalEvent: buildTerminalEventHook(agentId, deps).onTerminalEvent,
      // P4 (TR-06/OPS-06): the reaper caps + TimerPort + the audited eviction hooks.
      // worker.{maxSessions,idleTtlMs} + the entry limits.wallClockMs (0 while the
      // allow-set is empty) bound the per-agent session footprint; onCapForget wires
      // caps.forget so the cap-state map is dropped on EVERY reap path.
      maxSessions: deps.workerCaps?.maxSessions,
      idleTtlMs: deps.workerCaps?.idleTtlMs,
      wallClockMs: deps.workerCaps?.wallClockMs,
      timers: deps.timers,
      onEvict: reaperHooks.onEvict,
      onCapForget: reaperHooks.onCapForget,
      // ENDURE-01 / I9 (165-08's seam): the alive-busy idle-exclusion predicate (bound to
      // busyOrHung). A quiet-but-busy multi-hour compile is excluded from idle eviction; the
      // deliberate wall_clock/max_interactions caps still fire (a named bound, not a mystery).
      isBusy,
      // DUR-01 (165-06/165-07): the durability seams — descriptor store + has-session probe +
      // the content-free re-attach / unrecoverable hooks. Recover-on-boot re-attaches a
      // surviving detached tmux session instead of flipping it lost (I10); absent tmux ⇒ the
      // lost floor at runtime (I1). The descriptor is persisted at create-time (Pitfall 6).
      durability,
    });
    registries.set(agentId, registry);
  }
  return registry;
}

/**
 * Construct the per-agent registry + push all nine terminal-driver tools onto
 * the agent's tool array — the single entry point the composition root calls.
 *
 * The eight implemented tools (create/read/list/kill + send_text/send_key/wait/
 * resize) share the injected registry + the (currently empty) operator allow-set
 * + the daemon's once-detected cached `sandboxProvider` (fail-closed when
 * `undefined`) + the real logger/bus; `status` is the lone stub that rejects
 * `not_implemented`. The four interaction tools delegate to the registry's
 * forwarding methods — they do not re-gate the allowlist (the session was
 * gated at create). Mirrors how exec/process/apply-patch join the same array.
 */
/**
 * The net-new egress dimensions, constructed ONCE at the composition root
 * (not per-agent): the host-side no-secret allowlist proxy (the
 * {@link EgressControlPort} impl) + the resolved `bwrap` binary path.
 */
export interface TerminalEgressDeps {
  /** The host-side allowlist egress proxy (materializes `listed-hosts` per session). */
  readonly egressControl: EgressControlPort;
  /** The resolved bwrap path (Linux + provider==bwrap), else undefined (fail-closed downstream). */
  readonly bwrapPath: string | undefined;
}

/**
 * Construct the egress dependencies ONCE for the daemon (the composition
 * root), to inject into every agent's terminal wiring. The proxy materializes
 * `listed-hosts` egress on demand (per session); constructing the port
 * once avoids re-standing-up a server factory per agent/per create. `bwrapPath` is
 * resolved only when the provider IS bwrap (Linux) — matching
 * `BwrapProvider.available()`'s `which bwrap` so the terminal scope composer
 * (`buildScopeArgs`) binds the SAME binary the exec sandbox uses; on
 * macOS/no-sandbox it stays undefined (the create gate already fail-closes there).
 */
export function buildTerminalEgressDeps(
  logger: ComisLogger,
  sandboxProvider: SandboxProvider | undefined,
): TerminalEgressDeps {
  const egressControl = createTerminalEgressProxy({ logger });
  let bwrapPath: string | undefined;
  if (sandboxProvider?.name === "bwrap") {
    try {
      // eslint-disable-next-line no-restricted-syntax -- one-shot bwrap path resolve at daemon startup
      bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
    } catch {
      bwrapPath = undefined; // provider reported bwrap but PATH lost it — fail-closed downstream
    }
  }
  return { egressControl, bwrapPath };
}

/**
 * The base wiring deps the composition root assembles ONCE per daemon (the egress
 * dimensions + the cross-agent ports), BEFORE the per-agent config is read. The
 * per-agent {@link buildTerminalWiringDeps} folds the operator `config` (the allow-set
 * + worker caps) onto this base.
 */
export interface TerminalWiringBaseDeps {
  readonly dataDir: string;
  readonly skillsLogger: ComisLogger;
  readonly eventBus: TerminalEventBus;
  readonly sandboxProvider: SandboxProvider | undefined;
  readonly approvalGate?: ApprovalGate;
  readonly egressControl?: EgressControlPort;
  readonly bwrapPath?: string;
  /** The daemon's injected TimerPort (drives the reaper sweep). */
  readonly timers?: TimerPort;
  /**
   * The resolved per-agent workspace dir (`workspaceDirs.get(agentId) ?? default`,
   * the same dir the agent's read/write/exec tools use). When present, the registry
   * roots each session in `<agentWorkspaceDir>/projects` (PERSISTENT, no-op cleanup)
   * instead of a throwaway `/tmp` dir — so a driven milestone's work survives the
   * session and the agent can see it. Absent ⇒ the ephemeral default (test paths).
   */
  readonly agentWorkspaceDir?: string;
}

/**
 * Fold the per-agent operator terminal config onto the base wiring deps (124-09 — the
 * WR-01 closure call-site helper). Derives `workerCaps` from `config.worker.{maxSessions,
 * idleTtlMs,stuckMs}` (so the reaper composes when `timers` is present + maxSessions > 0)
 * and threads `config` (so `buildTerminalSharedDeps` populates the allow-set + per-session
 * caps). When `config` is absent the result has no `config`/`workerCaps` ⇒ the wiring
 * fail-closes (empty allow-set, no reaper) — the pre-P5 posture for an unconfigured agent.
 *
 * `wallClockMs` is sourced as 0 at the registry/reaper level (the per-ENTRY
 * `limits.wallClockMs` is the operative wall-clock budget, enforced per-send via the caps;
 * the reaper's wall-clock-age sweep stays opt-in via a future worker-level knob). Extracted
 * here (not inlined at the `setup-tools.ts` call site) to keep that file under the 800-line
 * architecture cap.
 */
export function buildTerminalWiringDeps(
  base: TerminalWiringBaseDeps,
  config: TerminalDriverConfig | undefined,
): TerminalWiringDeps {
  const workerCaps = config
    ? {
        maxSessions: config.worker.maxSessions,
        idleTtlMs: config.worker.idleTtlMs,
        wallClockMs: 0,
        stuckMs: config.worker.stuckMs,
      }
    : undefined;
  return {
    dataDir: base.dataDir,
    skillsLogger: base.skillsLogger,
    eventBus: base.eventBus,
    sandboxProvider: base.sandboxProvider,
    ...(base.approvalGate ? { approvalGate: base.approvalGate } : {}),
    ...(base.egressControl ? { egressControl: base.egressControl } : {}),
    ...(base.bwrapPath ? { bwrapPath: base.bwrapPath } : {}),
    ...(base.timers ? { timers: base.timers } : {}),
    ...(base.agentWorkspaceDir ? { agentWorkspaceDir: base.agentWorkspaceDir } : {}),
    ...(workerCaps ? { workerCaps } : {}),
    ...(config ? { config } : {}),
  };
}

/**
 * Build the shared deps object the nine terminal tools receive — the SINGLE seam
 * where the per-agent registry, the operator allow-set, the cached sandbox
 * provider, the approval gate, AND the net-new egress dimensions (the
 * {@link EgressControlPort} impl + the resolved `bwrapPath`) flow toward the
 * worker path. Extracted so the egress wiring is testable in isolation and so
 * the worker has one obvious place to read `egressControl` +
 * `bwrapPath` when composing the `listed-hosts` jail. No module-global state — the
 * registry map is passed in.
 */
export function buildTerminalSharedDeps(
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
) {
  // SEC-01 trust source: the operator allow-set. 124-09 (WR-01 closure) POPULATES it from
  // the threaded `config.allow` via the single `mapAllowEntry` site (the per-entry scope
  // SEC-02 + approveOnCreate SEC-06 + limits OPS-03/06 ride along, no silent drop). Absent
  // config ⇒ EMPTY (every create fail-closes) — the pre-P5 fail-closed posture is preserved.
  const allowEntries: AllowEntryLike[] = deps.config?.allow.map(mapAllowEntry) ?? [];

  // Construct ONE shared per-agent SessionCaps instance, fed into BOTH
  // the tool deps (consume*/startSession/forget) AND the registry onCapForget
  // (caps.forget) so eviction forgets the same cap-state map (no leak; no
  // double-forget). Prefer a composition-root-supplied instance (deps.caps) if present;
  // otherwise construct from the matched single-entry limits (single-entry-per-agent is
  // the forcing use case). The allow-set is EMPTY today, so the limits are undefined (no
  // caps tripped).
  //
  // WIRING NOW LIVE (124-09 — the WR-01 closure; RESEARCH Open Q3 resolved). Two pieces:
  //   1. PER-SESSION caps (consumeRequest/consumeInteraction/checkWallClock): LIVE now the
  //      allow-set is POPULATED from config — `allowEntries[0].limits` feeds
  //      createSessionCaps below (the entry's maxInteractions/maxRequestsPerSession/
  //      wallClockMs go enforceable).
  //   2. The REAPER (idle-TTL / wall-clock-age / max-sessions overflow): LIVE now the
  //      `setup-tools.ts` call site threads `workerCaps` (+ the shared `caps` and `timers`
  //      TimerPort) — `wireRegistryReaper` composes (it needs `timers !== undefined &&
  //      maxSessions > 0`, terminal-reaper.ts). The reaper sweeps the per-agent registry.
  // Both fail-closed when config/workerCaps are absent (empty allow-set ⇒ undefined limits
  // ⇒ no caps tripped; no workerCaps ⇒ no reaper) — the pre-P5 posture for an unconfigured agent.
  const entryLimits = allowEntries[0]?.limits;
  const caps: SessionCaps = deps.caps ?? createSessionCaps(entryLimits, systemNowMs);

  const registry = getOrCreateTerminalRegistry(registries, agentId, deps, caps);

  return {
    registry,
    allowEntries,
    // Reuse the daemon's once-detected cached provider — do NOT re-run the
    // blocking `detectSandboxProvider()` (`spawnSync("bwrap")`) on every create.
    // This mirrors how `setup-tools.ts` feeds `sandboxCfg.sandbox = sandboxProvider`
    // to the exec path. Fail-closed is intact: `undefined` ⇒ the create gate's
    // fail-closed branch rejects (never an unsandboxed spawn).
    detectProvider: () => deps.sandboxProvider,
    logger: deps.skillsLogger,
    eventBus: deps.eventBus,
    nowMs: systemNowMs,
    // Origin-keying: the per-session owner = (tryGetContext().userId ?? agentId,
    // tryGetContext().sessionKey ?? "") — derived PER CALL inside the tool (resolveOwner),
    // so the daemon needs no new owner arg. This agentId is the fallback half of that key.
    agentId,
    // DRIVE-02 (164-04) / DELIVER-02: thread the operator's RAW promotion mode (`drive.mode`, may be
    // undefined). The skills wait tool resolves the EFFECTIVE mode via resolveDriveMode(mode, durable):
    // an explicit mode wins; ABSENT, a DURABLE drive (the default long backgrounded drive) defaults to
    // `detached` (it backgrounds at the first wait → the backstop tracks it → a completion notification
    // fires when the CLI idles), a pty one-shot to `auto` (inline, I1 — byte-identical to today). The
    // skills layer reads no config (layer purity) — it only applies the pure resolver to these
    // daemon-supplied values (`driveMode` + `durable` below). Closes the un-promoted short-build gap.
    driveMode: deps.config?.drive?.mode,
    // READ-01 (164-06): the operator-resolved read mode for the read tool's bounded digest.
    // Same layer-purity posture as driveMode; `?? "digest"` is the schema default (plan 05's
    // drive.readMode) + the safe pre-block posture (the bounded current screen).
    readMode: deps.config?.drive?.readMode ?? "digest",
    // DUR-01 (FINDING-B): drive.durable threaded to the create tool → create stamps req.durable:true → the registry derives the tmux name + selects the tmux backend (the survive-a-daemon-restart drive). DEFAULT-ON (`?? true`): the tmux backend is now both DRIVEABLE (the node-pty `attach` rework) and SURVIVE-A-RESTART (KillMode=process + the data-dir socket), so it is the default working setup. Explicit `drive.durable:false` opts out to the non-durable pty backend; a tmux-less host degrades to pty + a logged WARN (§7.1.5).
    durable: deps.config?.drive?.durable ?? true,
    // The operator approval gate — consulted only when a matched entry sets
    // approveOnCreate (else the create path is unchanged); a demanding entry with no
    // gate fail-closes in the tool.
    approvalGate: deps.approvalGate,
    // The net-new egress dimensions, threaded toward the worker.
    // The PORT impl (the no-secret allowlist proxy) + the resolved bwrap path; the
    // worker calls `egressControl.materialize(scope.hosts)` for
    // `listed-hosts` and passes `bwrapPath` to `buildScopeArgs`. EXPLICIT, not
    // implicit. Today unused by the eight tools — they carry it
    // through the seam so the worker composer has it.
    egressControl: deps.egressControl,
    bwrapPath: deps.bwrapPath,
    // The shared per-agent caps the eight tools consume (the SAME
    // instance the registry onCapForget forgets — one source for consume + forget).
    caps,
  };
}

/**
 * The per-agent attention config the wake-FSM woken turn reads (124-09 Task 2). Derived
 * from the operator terminal config: the `autoAnswer`/`hintPatterns` come from the MATCHED
 * allow-entry (the forcing use case is a single entry per agent — the first entry's policy),
 * and the FSM caps from `worker.maxConcurrentAttentionTurns`. Operator-dialable ONLY (never
 * agent-supplied). Returns `undefined` when the agent has no terminal config or no allow
 * entry ⇒ the woken turn escalates `no_safe_match` (the SAFE default).
 *
 * Hop cap: derived as `maxConcurrentAttentionTurns * 4` (a conservative per-session
 * consecutive-wake ceiling before forced escalation; the spec leaves the exact hop bound to
 * the daemon, bounded by the concurrency knob). No agent input feeds it.
 */
export function deriveTerminalAttentionConfig(
  config: TerminalDriverConfig | undefined,
):
  | { autoAnswer: "none" | "safe-only" | "all"; hintPatterns: readonly string[]; maxHops: number; maxConcurrentAttentionTurns: number }
  | undefined {
  if (!config) return undefined;
  const entry = config.allow[0];
  if (!entry) return undefined;
  const maxConcurrentAttentionTurns = config.worker.maxConcurrentAttentionTurns;
  return {
    autoAnswer: entry.autoAnswer,
    hintPatterns: entry.hintPatterns ?? [],
    maxHops: Math.max(1, maxConcurrentAttentionTurns * 4),
    maxConcurrentAttentionTurns,
  };
}

/**
 * The per-agent terminal-driver wiring entry point the composition root (`setup-tools.ts`)
 * calls — folds the base deps + the operator config into the registry + nine tools in ONE
 * call, keeping `setup-tools.ts` under its 800-line cap. `buildTerminalWiringDeps` folds the
 * operator config (allow-set + caps + reaper + autoAnswer/backend; absent ⇒ empty set + no
 * reaper); the 165-07 durability (descriptor store + has-session probe + isBusy + recover-on-
 * boot hooks) is wired inside `getOrCreateTerminalRegistry`.
 */
export function wireAgentTerminalTools(
  tools: AgentToolArray,
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  base: TerminalWiringBaseDeps,
  config: TerminalDriverConfig | undefined,
): void {
  wireTerminalTools(tools, registries, agentId, buildTerminalWiringDeps(base, config));
}

export function wireTerminalTools(
  tools: AgentToolArray,
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
): void {
  const sharedDeps = buildTerminalSharedDeps(registries, agentId, deps);

  tools.push(
    createTerminalSessionCreateTool(sharedDeps),
    createTerminalSessionReadTool(sharedDeps),
    createTerminalSessionListTool(sharedDeps),
    createTerminalSessionKillTool(sharedDeps),
    createTerminalSessionSendTextTool(sharedDeps),
    createTerminalSessionSendKeyTool(sharedDeps),
    createTerminalSessionWaitTool(sharedDeps),
    createTerminalSessionStatusTool(sharedDeps), // 124-06: the stub is now a deps-taking, classifier-backed tool
    createTerminalSessionResizeTool(sharedDeps),
  );
}
