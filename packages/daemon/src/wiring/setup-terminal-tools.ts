// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-side wiring for the interactive terminal driver (v2.11, Phase 119 P0 +
 * Phase 120 P1 interaction).
 *
 * The daemon is the composition root — the only package that may value-import
 * `@comis/infra` — so it constructs the per-agent `TerminalSessionRegistry`
 * (injecting the real logger + the production worker-spawn posture) and pushes
 * the nine terminal tools (eight implemented + one stub [`status`]) into the agent
 * tool set. The eight implemented tools (create/read/list/kill + the four
 * interaction tools send_text/send_key/wait/resize) all share one `sharedDeps`
 * (the injected registry + allow-set + provider + logger/bus/clock); `status` is
 * the lone no-arg stub (Phase 124). All nine are registered
 * `mcpExportPolicy:"never-export"` (119-01), so they stay inside Comis's trust
 * boundary and never reach MCP.
 *
 * Extracted from `setup-tools.ts` to keep that file under the 800-line
 * architecture cap. State (the per-agent registry map) lives in the `setupTools`
 * closure and is threaded in here — there is NO module-global mutable state.
 *
 * SEC-01 / SEC-16 fail-closed by construction at this phase: the operator
 * `TerminalDriverConfig.allow[]` is not yet threaded into `PerAgentConfig` (that
 * config-plumbing + the worker process entrypoint are later P0/P-phase work), so
 * the wired allow-set is EMPTY — every `terminal_session_create` is rejected by
 * the allowlist gate (`matchAllowEntry` returns undefined) before any worker is
 * spawned. The surface is live + governed; the worker is never spawned until both
 * the allow-set and the worker main land. The seam is clean.
 *
 * @module
 */

import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ComisLogger } from "@comis/infra";
import { createTerminalEgressProxy } from "./terminal-egress-proxy.js";
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
  buildProductionSpawnWorker,
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
  type ApprovalGate,
  type EgressControlPort,
  type TimerPort,
} from "@comis/core";

/** Dependencies the terminal-driver wiring needs from the composition root. */
export interface TerminalWiringDeps {
  /** Base data dir (~/.comis) — scopes the worker's durable-state fs-write. */
  readonly dataDir: string;
  /** Module-bound skills logger (the real `@comis/infra` logger). */
  readonly skillsLogger: ComisLogger;
  /** The daemon's typed event bus (structurally compatible with `TerminalEventBus`). */
  readonly eventBus: TerminalEventBus;
  /**
   * The daemon's once-detected sandbox provider (MR-03). Detected ONCE at daemon
   * startup (the same value the exec path threads via `sandboxCfg.sandbox`) and
   * reused here — so the create gate's SEC-16 fail-closed branch reads the cached
   * provider instead of re-running the blocking `detectSandboxProvider()`
   * (`spawnSync("bwrap")` smoke test) on every create. `undefined` ⇒ no sandbox
   * runtime ⇒ create fail-closes (the fail-closed posture is unchanged).
   */
  readonly sandboxProvider: SandboxProvider | undefined;
  /**
   * The daemon's operator approval gate (SEC-06). The same `ApprovalGate` the
   * exec path uses (constructed once in `setup-tools.ts`). Threaded into the
   * terminal tools' `sharedDeps` so a `approveOnCreate` entry gates `session_create`
   * on operator consent. Optional: when absent, an `approveOnCreate` entry
   * fail-closes (reject) — it never runs unauthorized.
   */
  readonly approvalGate?: ApprovalGate;
  /**
   * The host-side no-secret allowlist egress proxy (SEC-07), constructed at the
   * composition root (`createTerminalEgressProxy`) and injected here as the
   * {@link EgressControlPort}. Threaded toward the worker path so 122-06 can call
   * `materialize(scope.hosts)` for `network: listed-hosts` and bind-mount the
   * returned socket. Optional: absent => no `listed-hosts` egress is materialized
   * (the create gate + scope still enforce `none`/`full`); never a silent open.
   */
  readonly egressControl?: EgressControlPort;
  /**
   * The resolved `bwrap` binary path (the daemon detects it ONCE at startup, the
   * same value the sandbox provider resolves via `which bwrap`). Threaded toward
   * the worker path so 122-06 can pass it to `buildScopeArgs({ bwrapPath, ... })`
   * (the scope->argv composer needs the explicit path; it is NOT implicit). Made
   * EXPLICIT here per the W1 plan-checker — do not leave bwrapPath implicit.
   */
  readonly bwrapPath?: string;
  /**
   * P4 reaper caps (TR-06/OPS-06) — the closed `worker.{maxSessions,idleTtlMs,
   * stuckMs}` (schema-skills.ts) + the per-entry `limits.wallClockMs` (default 0
   * while the allow-set is empty). Threaded into the per-agent registry's reaper so
   * the session footprint is bounded (max-sessions overflow on create, idle-TTL +
   * wall-clock-age on the sweep). Optional: absent ⇒ no reaper (the pre-P4 posture).
   */
  readonly workerCaps?: { maxSessions: number; idleTtlMs: number; wallClockMs: number; stuckMs: number };
  /**
   * The injected `TimerPort` (the daemon constructs `createSystemTimers()` at the
   * composition root) driving the reaper sweep. Type-only from `@comis/core`; the
   * registry/reaper take it as a port (worker ↛ infra). Absent ⇒ no reaper sweep.
   */
  readonly timers?: TimerPort;
  /**
   * The shared per-agent {@link SessionCaps} instance (Plan 02/05). Threaded so the
   * registry's `onCapForget` is wired to `caps.forget` — the per-session cap state is
   * dropped on EVERY eviction (idle/wall_clock/max_sessions/max_interactions), not
   * only the tool kill path (T-123-17, no SessionCaps Map leak on the reap path).
   */
  readonly caps?: SessionCaps;
}

/**
 * Map a parsed config `TerminalAllowEntry` onto the skills-side `AllowEntryLike`
 * (SEC-02/03) — the SINGLE site config scope becomes an `AllowEntryLike`.
 *
 * Copies `{ id, match, scope }`: the operator-declared scope is carried verbatim so
 * it threads on to the create frame (RESEARCH Pitfall 4 — scope must NOT be dropped
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
    // SEC-06: carry the operator's approveOnCreate consent flag verbatim (a sibling
    // of scope) so the create tool can gate on it — never dropped at the boundary.
    approveOnCreate: entry.approveOnCreate,
    // OPS-03/OPS-06: carry the operator's per-entry usage caps verbatim (a sibling of
    // scope/approveOnCreate) so the daemon builds the per-agent SessionCaps from them —
    // never dropped at the boundary (the silent-no-op/security regression class).
    limits: entry.limits,
  };
}

/**
 * Resolve the worker entry's runtime JS path (the dist sibling of the
 * `terminal-worker-entry` source). The production worker-spawn posture forks
 * `node <permission-args> <workerJs>`; this is never invoked while the allow-set
 * is empty (the gate rejects every create first), but the registry is
 * constructed with the correct posture so a later phase only has to populate the
 * allow-set + ship the worker main.
 */
function resolveWorkerJsPath(dataDir: string): string {
  // Placeholder under the data dir until the standalone worker main lands
  // (the worker is currently an in-process factory; the separate-process entry
  // is wired in a later P0 step). Never spawned while the allow-set is empty.
  return resolve(dataDir, "terminal-worker", "worker-main.js");
}

/**
 * Build the daemon-side reaper eviction hooks for one agent (TR-06/OPS-06) —
 * mirrors the `onSpawnFailed` template. `onEvict` closes the observability loop on
 * EVERY reaped session: it emits `terminal:session_evicted` (the audited reason) +
 * `terminal:session_state` (state→`lost`, the lifecycle transition) + a WARN
 * (`hint` + `errorKind: "resource"`, §2.7) — so a reap is reconstructable from
 * logs+events alone. `onCapForget` is wired to the shared `caps.forget` so the
 * per-session cap state is dropped on the reap path (T-123-17, no SessionCaps Map
 * leak). Exported so the audit wiring is unit-testable in isolation (Test D).
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
    // T-123-17: drop the per-session cap state on EVERY eviction (not only the tool kill).
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
          deps.eventBus.emit("terminal:input_needed", { sessionId: frame.sessionId, agentId, state, reason, timestamp });
          deps.skillsLogger.info(
            { sessionId: frame.sessionId, agentId, state, reason, step: "terminal_input_needed" },
            "terminal session needs input (re-published from fd3)",
          );
          break;
        }
        case "terminal:stuck": {
          // Settled, no affordance, no progress past stuckMs (OPS-04) — a duration signal.
          const noProgressMs = typeof p.noProgressMs === "number" ? p.noProgressMs : 0;
          deps.eventBus.emit("terminal:stuck", { sessionId: frame.sessionId, agentId, noProgressMs, timestamp });
          deps.skillsLogger.info(
            { sessionId: frame.sessionId, agentId, noProgressMs, step: "terminal_stuck" },
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
              errorKind: "policy" as const,
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
 * is constructed with the 118-proven `--permission` worker-spawn posture
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
    registry = createTerminalSessionRegistry({
      spawnWorker: buildProductionSpawnWorker(resolveWorkerJsPath(deps.dataDir), deps.dataDir),
      logger: deps.skillsLogger,
      nowMs: systemNowMs,
      // SEC-16 / SEC-07 (122-06): the daemon-resolved bwrap path rides the create
      // frame to the worker's fail-closed branch; the live egress port is the
      // daemon->worker-main seam for `listed-hosts`. Both undefined on a no-sandbox
      // host ⇒ the worker fail-closes (no unjailed spawn).
      bwrapPath: deps.bwrapPath,
      egressControl: deps.egressControl,
      // HR-03 / OPS-07: turn a worker backend-spawn failure (an `ok:false` create
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
      // caps.forget so the cap-state map is dropped on EVERY reap path (T-123-17).
      maxSessions: deps.workerCaps?.maxSessions,
      idleTtlMs: deps.workerCaps?.idleTtlMs,
      wallClockMs: deps.workerCaps?.wallClockMs,
      timers: deps.timers,
      onEvict: reaperHooks.onEvict,
      onCapForget: reaperHooks.onCapForget,
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
 * forwarding methods (120-03) — they do not re-gate the allowlist (the session was
 * gated at create). Mirrors how exec/process/apply-patch join the same array.
 */
/**
 * The net-new SEC-07 egress dimensions, constructed ONCE at the composition root
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
 * Construct the SEC-07 egress dependencies ONCE for the daemon (the composition
 * root), to inject into every agent's terminal wiring. The proxy materializes
 * `listed-hosts` egress on demand (per session) in 122-06; constructing the port
 * once avoids re-standing-up a server factory per agent/per create. `bwrapPath` is
 * resolved only when the provider IS bwrap (Linux) — matching
 * `BwrapProvider.available()`'s `which bwrap` so the terminal scope composer
 * (122-06 `buildScopeArgs`) binds the SAME binary the exec sandbox uses; on
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
 * Build the shared deps object the nine terminal tools receive — the SINGLE seam
 * where the per-agent registry, the operator allow-set, the cached sandbox
 * provider, the approval gate, AND the net-new egress dimensions (the
 * {@link EgressControlPort} impl + the resolved `bwrapPath`) flow toward the
 * worker path. Extracted so the egress wiring is testable in isolation (122-05
 * Task 3) and so 122-06 has one obvious place to read `egressControl` +
 * `bwrapPath` when composing the `listed-hosts` jail. No module-global state — the
 * registry map is passed in.
 */
export function buildTerminalSharedDeps(
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
) {
  // SEC-01 trust source: the operator allow-set. Empty until the config is
  // threaded into PerAgentConfig (a later step) — so every create fail-closes.
  // When that lands it becomes `config.allow.map(mapAllowEntry)`, so the per-entry
  // scope (SEC-02) rides along via the single mapping site above (no silent drop).
  const allowEntries: AllowEntryLike[] = [];

  // OPS-03/OPS-06: construct ONE shared per-agent SessionCaps instance, fed into BOTH
  // the tool deps (consume*/startSession/forget) AND the registry onCapForget
  // (caps.forget) so eviction forgets the same cap-state map (T-123-17, no leak; no
  // double-forget). Prefer a composition-root-supplied instance (deps.caps) if present;
  // otherwise construct from the matched single-entry limits (single-entry-per-agent is
  // the forcing use case). The allow-set is EMPTY today, so the limits are undefined (no
  // caps tripped).
  //
  // WIRING TO MAKE P4 LIVE (lands with the allow-set/attention work, P5/Phase 124 —
  // deliberately OUT of Phase 123 scope, RESEARCH Open Q3). Two distinct pieces, do NOT
  // conflate them:
  //   1. PER-SESSION caps (consumeRequest/consumeInteraction/checkWallClock): become live
  //      once the allow-set is POPULATED — `allowEntries[0].limits` then feeds
  //      createSessionCaps below. No further wiring beyond populating the allow-set.
  //   2. The REAPER (idle-TTL / wall-clock-age / max-sessions overflow): additionally
  //      requires `workerCaps` (+ the shared `caps` and `timers` TimerPort) to be threaded
  //      at the `wireTerminalTools` call site (setup-tools.ts) — without them
  //      `wireRegistryReaper` never composes a reaper (it needs `timers !== undefined &&
  //      maxSessions > 0`, terminal-reaper.ts). The live caller does NOT pass these today,
  //      so the reaper is intentionally inert. Threading them now would run the reaper over
  //      an empty registry — out of scope until the allow-set lands.
  const entryLimits = allowEntries[0]?.limits;
  const caps: SessionCaps = deps.caps ?? createSessionCaps(entryLimits, systemNowMs);

  const registry = getOrCreateTerminalRegistry(registries, agentId, deps, caps);

  return {
    registry,
    allowEntries,
    // MR-03: reuse the daemon's once-detected cached provider — do NOT re-run the
    // blocking `detectSandboxProvider()` (`spawnSync("bwrap")`) on every create.
    // This mirrors how `setup-tools.ts` feeds `sandboxCfg.sandbox = sandboxProvider`
    // to the exec path. Fail-closed is intact: `undefined` ⇒ the create gate's
    // SEC-16 branch rejects (never an unsandboxed spawn).
    detectProvider: () => deps.sandboxProvider,
    logger: deps.skillsLogger,
    eventBus: deps.eventBus,
    nowMs: systemNowMs,
    // TR-13 origin-keying: the per-session owner = (tryGetContext().userId ?? agentId,
    // tryGetContext().sessionKey ?? "") — derived PER CALL inside the tool (resolveOwner),
    // so the daemon needs no new owner arg. This agentId is the fallback half of that key.
    agentId,
    // SEC-06: the operator approval gate — consulted only when a matched entry sets
    // approveOnCreate (else the create path is unchanged); a demanding entry with no
    // gate fail-closes in the tool.
    approvalGate: deps.approvalGate,
    // SEC-07 (122-05): the net-new egress dimensions, threaded toward the worker.
    // The PORT impl (the no-secret allowlist proxy) + the resolved bwrap path; the
    // worker (122-06) calls `egressControl.materialize(scope.hosts)` for
    // `listed-hosts` and passes `bwrapPath` to `buildScopeArgs`. EXPLICIT, not
    // implicit (W1 plan-checker). Today unused by the eight tools — they carry it
    // through the seam so the worker composer has it.
    egressControl: deps.egressControl,
    bwrapPath: deps.bwrapPath,
    // OPS-03/OPS-06: the shared per-agent caps the eight tools consume (the SAME
    // instance the registry onCapForget forgets — one source for consume + forget).
    caps,
  };
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
