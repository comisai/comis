// SPDX-License-Identifier: Apache-2.0
/**
 * The DUR-01 / DUR-02 / LIVE-01 / ENDURE-01 daemon DURABILITY WIRING (165-07 Task 4) — the
 * integration glue that ties the phase's pure siblings + durable stores into the live
 * registry + wake seams. Extracted from `setup-terminal-tools.ts` to keep that file under the
 * 800-line architecture cap; the wiring is exercised by the registry/wake/reaper unit suites
 * + the integration tier (no unit test of its own — it is composition, not logic).
 *
 * Two construction sites:
 *   1. {@link buildAgentTerminalDurability} — PER-AGENT (called from `getOrCreateTerminalRegistry`):
 *      the descriptor store (165-07 Task 1) + the `has-session` probe + the recover/unrecoverable
 *      hooks (→ the registry's `durability` dep, consumed by 165-06's recover-on-boot + the
 *      durable-aware lost gate) + the `isBusy` reaper predicate (165-08's seam, bound to 165-02's
 *      `busyOrHung`). On a re-attach it emits the content-free `terminal:drive_reattached`
 *      (I5 same-allow-entry, I3 ids-only); on a genuinely-gone session it emits the EXISTING
 *      `terminal:session_state(state:"lost")` + a content-free unrecoverable reason (NOTIFY-01
 *      layers the user-facing `failed` downstream).
 *   2. {@link buildWakeDurabilityDeps} — DAEMON-WIDE (spread into `setupTerminalWake`): the
 *      DUR-02 journal store (165-07 Task 1, the persist-on-set + resume-on-re-attach point) +
 *      the LIVE-01 `checkLiveness` (the worker `status` round-trip mapped to a `BusySignal` — a
 *      CLASSIFIER perception, NEVER a screen read, I2) + the `refreshLastActivity` unify (a busy
 *      backstop verdict advances the handle's lastActivity so the idle reaper never evicts a
 *      quiet-but-busy compile, I9).
 *
 * The `isTmuxAlive` probe is the daemon-side `tmux has-session -t comis-<id>` (exit 0 ⇒ alive),
 * resolved against a `tmuxPath` the composition root detects once (`which tmux`). Absent tmux
 * ⇒ the probe is always-false (a durable session degrades to today's lost floor at runtime —
 * §7.1.5's runtime fallback, NOT a config-time hard-require, I1).
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import {
  createSessionDescriptorStore,
  type SessionDescriptorPersistenceDeps,
} from "./terminal-session-descriptor-persistence.js";
import {
  persistDriveJournal,
  loadDriveJournal,
  removeDriveJournal,
} from "./terminal-drive-journal-persistence.js";
import type { DriveJournalStorePort } from "./setup-terminal-wake.js";
import type { LivenessSignal } from "./terminal-wake-types.js";
import {
  busyOrHung,
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
  terminalWorkerDir,
  resolveTmuxSocketPath,
  type TerminalDurabilityDeps,
  type TerminalSessionRegistry,
  type DriveJournal,
  type BusySignal,
} from "@comis/skills/tools";
import type { ComisLogger } from "@comis/infra";

/**
 * The narrow event-bus surface the durability hooks emit onto (a `Pick`-style contract,
 * structurally assignable from the daemon `TypedEventBus`). The skills-side `TerminalEventBus`
 * does NOT model `terminal:drive_reattached` (that event is daemon-side only, events-terminal.ts),
 * and `terminal-tools.ts` is at the 800-line cap, so this local contract carries exactly the two
 * content-free records the recover-on-boot hooks emit — the re-attach + the unrecoverable (lost).
 */
export interface DurabilityEventBus {
  emit(event: "terminal:drive_reattached", payload: { sessionId: string; agentId: string; reason: "tmux_alive"; timestamp: number }): unknown;
  // CR-01 (Phase 166): the genuine-death lost emit now carries the `unrecoverable:true`
  // discriminator + the content-free `reason` (WR-03) so the NOTIFY-01 wake holder maps it to
  // a user-facing `failed` (a transient/recoverable lost — the worker-crash respawn / reaper
  // path — leaves both UNSET, so it is NOT reported failed; I9/I10). Both content-free (I3).
  emit(event: "terminal:session_state", payload: { sessionId: string; agentId: string; state: "lost"; unrecoverable?: boolean; reason?: string; durationMs: number; timestamp: number }): unknown;
}

/** The stamped registry owner for a drive-scoped session — the forcing-use-case owner (I5). */
function driveOwner(agentId: string): { agentId: string; sessionKey: string } {
  return { agentId, sessionKey: "" };
}

/** ISSUE-3 (live VPS 2026-06-16): the session's STAMPED owner — recovered via the registry's
 *  getOwner seam (the worker→event re-publish drops the (userId, sessionKey) for a channel/API
 *  drive), else the forcing-use-case driveOwner. So the LIVE-01 backstop + the ENDURE-01 idle
 *  exclusion resolve a channel/API detached drive's LIVE session instead of misjudging it gone or
 *  idle (cross-owner) and silently stranding / evicting it. */
function resolveStampedOwner(
  registry: { getOwner?(s: string): { agentId: string; sessionKey: string } | undefined } | undefined,
  sessionId: string,
  agentId: string,
): { agentId: string; sessionKey: string } {
  return registry?.getOwner?.(sessionId) ?? driveOwner(agentId);
}

/**
 * Resolve the daemon-side `tmux` binary path (memoized — the resolution is process-stable, so
 * the per-agent durability wiring + the daemon-wide wake backstop share ONE `which tmux`).
 * Mirrors the `which bwrap` probe in `buildTerminalEgressDeps`. `undefined` ⇒ no tmux on this
 * host ⇒ the `isTmuxAlive` probe is always-false (a durable drive degrades to the lost floor at
 * runtime, §7.1.5). The blocking `which` runs at most once; never on the hot path.
 */
let cachedTmuxPath: string | undefined | "unresolved" = "unresolved";
export function resolveDaemonTmuxPath(): string | undefined {
  if (cachedTmuxPath !== "unresolved") return cachedTmuxPath;
  try {
    // eslint-disable-next-line no-restricted-syntax -- one-shot tmux path resolve at daemon startup
    cachedTmuxPath = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    cachedTmuxPath = undefined;
  }
  return cachedTmuxPath;
}

/**
 * Build the daemon-side `has-session` liveness probe: `tmux -S <socket> has-session -t
 * comis-<id>` (exit 0 ⇒ alive). Returns `false` on ANY non-zero exit / throw (the SAFE
 * direction — a probe that cannot confirm alive must never assert it, mirroring 165-01's
 * bias). Absent `tmuxPath` ⇒ always-false (a durable session falls back to the lost floor
 * at runtime, I1).
 *
 * DUR-01: the probe MUST target the SAME `-S` socket the worker binds
 * (`<dataDir>/terminal-worker/tmux.sock`) — NOT tmux's default /tmp socket. systemd
 * `PrivateTmp=yes` privatizes /tmp per daemon start, so a default-socket probe in the
 * restarted daemon would find NOTHING and falsely declare every survived durable session
 * lost. `run` is injected ONLY for the unit test; production keeps the bounded execFileSync.
 */
export function buildIsTmuxAlive(
  tmuxPath: string | undefined,
  socketPath: string,
  run: (bin: string, args: string[]) => void = (bin, args) => {
    // eslint-disable-next-line no-restricted-syntax -- bounded has-session liveness probe (recover-on-boot + backstop)
    execFileSync(bin, args, { stdio: "ignore" });
  },
): (name: string, socket?: string) => boolean {
  if (tmuxPath === undefined) return (): boolean => false;
  // RECUR-03 (option A): the probe takes an OPTIONAL per-session `socket` — the PER-BOOT server
  // the session lives on (`handle.tmuxSocket` / `descriptor.tmuxSocket`). A restart's surviving
  // durable sits on its OWN (prior-boot) socket while a new session is on this boot's socket, so
  // the probe MUST target the session's own server, not one fixed socket. Absent ⇒ `socketPath`
  // (the legacy/default — a pre-RECUR-03 descriptor or a non-per-boot caller).
  return (name: string, socket?: string): boolean => {
    try {
      const [bin, ...args] = buildTmuxHasSessionArgv({ tmuxPath, socketPath: socket ?? socketPath, name });
      run(bin!, args);
      return true; // exit 0 ⇒ the named detached session is alive
    } catch {
      return false; // non-zero exit (gone) / spawn fault ⇒ the SAFE direction is "not alive"
    }
  };
}

/**
 * Deterministically kill a DURABLE session's detached tmux by name (`tmux -S <socket> kill-session
 * -t <name>`) — the sibling of {@link buildIsTmuxAlive}. The registry calls this on evict of a
 * durable session because the worker-IPC "kill" does NOT reliably terminate a detached, per-boot-
 * socket tmux (a never-tasked webhook drive lingered as an idle `claude` after `kill`; a manual
 * kill-session by name reaped it — webhook-claude-cli-tdd-20260701). Best-effort: a non-zero exit
 * (already gone) or spawn fault is swallowed — the session is de-registered regardless. `run` is
 * injected ONLY for the unit test; production keeps the bounded execFileSync.
 */
export function buildKillTmux(
  tmuxPath: string | undefined,
  socketPath: string,
  run: (bin: string, args: string[]) => void = (bin, args) => {
    // eslint-disable-next-line no-restricted-syntax -- bounded kill-session teardown (durable evict backstop)
    execFileSync(bin, args, { stdio: "ignore" });
  },
): (name: string, socket?: string) => void {
  if (tmuxPath === undefined) return (): void => {};
  return (name: string, socket?: string): void => {
    try {
      const [bin, ...args] = buildTmuxKillArgv({ tmuxPath, socketPath: socket ?? socketPath, name });
      run(bin!, args);
    } catch {
      /* already gone / spawn fault — the session is de-registered regardless (best-effort) */
    }
  };
}

/**
 * RECUR-02 (live VPS 2026-06-17) — the stranded-mount-namespace predicate. A durable tmux
 * server kept alive across a daemon restart by `KillMode=process` was forked by the PRIOR
 * daemon generation, so it lives in that generation's mount namespace. systemd `PrivateTmp`/
 * `ProtectHome`/`ProtectSystem` give EVERY daemon START a fresh mount ns, so after a restart the
 * surviving server sits in a now-dismantled ns: its EXISTING sessions keep running (their bwrap
 * was set up when the ns was healthy) but every NEW `bwrap` session it forks dies ~2.5s (mount
 * setup runs in the torn-down ns). PROVEN live: server `mnt:[…294]` ≠ restarted daemon
 * `mnt:[…302]`; a new claude AND a plain `sh` new-session both died while the re-attached durable
 * one survived. `true` ONLY when BOTH ns ids are known AND differ — an unknowable ns (no server /
 * unreadable `/proc`) is the SAFE direction `false` (never needlessly tear down a server).
 */
export function isTmuxServerStranded(serverMntNs: string | undefined, daemonMntNs: string | undefined): boolean {
  if (serverMntNs === undefined || daemonMntNs === undefined) return false;
  return serverMntNs !== daemonMntNs;
}

/** The injectable deps for {@link recreateStrandedTmuxServerOnBoot} (the `/proc` readers + the kill
 *  are seams so the decision is unit-provable without a live tmux server / a real `/proc`). */
export interface RecreateStrandedTmuxDeps {
  /** The durable `-S` socket the surviving server is bound to. */
  readonly socketPath: string;
  /** The resolved tmux binary; `undefined` ⇒ no tmux on this host ⇒ a no-op (durable already degrades). */
  readonly tmuxPath: string | undefined;
  readonly logger: { warn(obj: Record<string, unknown>, msg?: string): void };
  /** Read the surviving server's mount-ns id (default: `tmux display-message -p '#{pid}'` → `/proc/<pid>/ns/mnt`). */
  readServerMntNs?: (socketPath: string) => string | undefined;
  /** Read THIS daemon's mount-ns id (default: `/proc/self/ns/mnt`). */
  readDaemonMntNs?: () => string | undefined;
  /** Tear down the stranded server (default: `tmux -S <socket> kill-server`). */
  killServer?: (socketPath: string) => void;
}

/** Default `/proc`-backed reader for the surviving tmux server's mount-ns id. Returns `undefined` on
 *  ANY fault (no server / unreadable) — the SAFE direction (never assert a strand we cannot confirm). */
function defaultReadServerMntNs(socketPath: string, tmuxPath: string): string | undefined {
  try {
    // eslint-disable-next-line no-restricted-syntax -- one-shot bounded server-pid probe at daemon boot (recover-on-boot strand check)
    const pid = execFileSync(tmuxPath, ["-S", socketPath, "display-message", "-p", "#{pid}"], { encoding: "utf8" }).trim();
    if (pid === "") return undefined;
    return readlinkSync(`/proc/${pid}/ns/mnt`);
  } catch {
    return undefined;
  }
}

/** Default `/proc/self/ns/mnt` reader for THIS daemon's mount-ns id (`undefined` on a non-Linux/unreadable host). */
function defaultReadDaemonMntNs(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/mnt");
  } catch {
    return undefined;
  }
}

/**
 * RECUR-02 — at daemon boot, if the durable tmux server SURVIVED into a stranded prior-generation
 * mount namespace ({@link isTmuxServerStranded}), tear it down (`kill-server`) so the next
 * `new-session` starts a FRESH server in THIS daemon's live ns (where new `bwrap` sessions work).
 * Its surviving durable sessions are intentionally killed — they would otherwise be a half-dead
 * server that accepts NO new work — and the registry's recover-on-boot then finds them gone via
 * `has-session` and flips them `lost` with the journal PRESERVED (the existing `onUnrecoverable`
 * path), so the agent resumes the work on the fresh server. MUST run ONCE before any registry's
 * recover-on-boot probes. A no-op when there is no tmux, no server, or the server is healthy (same
 * ns) — so a normal first boot and a restart with no live durable both leave the server untouched.
 */
export function recreateStrandedTmuxServerOnBoot(deps: RecreateStrandedTmuxDeps): { stranded: boolean; killed: boolean } {
  const { socketPath, tmuxPath, logger } = deps;
  // No tmux on this host → there is no durable server to strand (durable already degrades to the
  // lost floor at runtime, §7.1.5). Nothing to recreate.
  if (tmuxPath === undefined) return { stranded: false, killed: false };
  const readServerMntNs = deps.readServerMntNs ?? ((s: string) => defaultReadServerMntNs(s, tmuxPath));
  const readDaemonMntNs = deps.readDaemonMntNs ?? defaultReadDaemonMntNs;
  const killServer =
    deps.killServer ??
    ((s: string): void => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- one-shot bounded kill-server at daemon boot (tear down the stranded prior-generation server)
        execFileSync(tmuxPath, ["-S", s, "kill-server"], { stdio: "ignore" });
      } catch {
        /* best-effort: a kill of an already-gone/unreachable server is a no-op, never a boot crash */
      }
    });

  const serverMntNs = readServerMntNs(socketPath);
  const daemonMntNs = readDaemonMntNs();
  if (!isTmuxServerStranded(serverMntNs, daemonMntNs)) return { stranded: false, killed: false };

  killServer(socketPath);
  // §2.7: load-bearing boot record (INFO-equivalent WARN) — an operator must see WHY durable
  // sessions were reset on this boot (the stranded-ns strand) without a debugger / live repro.
  logger.warn(
    {
      step: "tmux_server_stranded_recreate",
      errorKind: "dependency" as const,
      serverMntNs,
      daemonMntNs,
      hint: "durable tmux server survived the restart in the PRIOR daemon's dismantled mount namespace (PrivateTmp/ProtectHome give each start a fresh ns; KillMode=process kept the old server) — new bwrap sessions in it fail, so it was torn down; surviving durable sessions flip lost with the journal preserved and resume on a fresh server in the live ns",
    },
    "terminal durable tmux server recreated on boot (stranded mount namespace)",
  );
  return { stranded: true, killed: true };
}

/**
 * RECUR-02 — the dataDir-bound boot step the composition root calls ONCE before any registry's
 * recover-on-boot. Resolves the daemon tmux path + the durable `-S` socket (the SAME derivation
 * the liveness probe uses) and delegates to {@link recreateStrandedTmuxServerOnBoot}. Thin
 * composition (no logic of its own — the decision is unit-tested on the delegate), mirroring the
 * other dataDir-bound builders in this module.
 */
export function recreateStrandedTmuxServerForDataDir(
  dataDir: string,
  logger: { warn(obj: Record<string, unknown>, msg?: string): void },
): { stranded: boolean; killed: boolean } {
  return recreateStrandedTmuxServerOnBoot({
    socketPath: resolveTmuxSocketPath(terminalWorkerDir(dataDir)),
    tmuxPath: resolveDaemonTmuxPath(),
    logger,
  });
}

/** Inputs for the per-agent durability + reaper-isBusy wiring. */
export interface AgentTerminalDurabilityInputs {
  readonly dataDir: string;
  readonly agentId: string;
  /** The daemon's typed event bus (the re-attach / unrecoverable hooks emit the content-free records). */
  readonly eventBus: DurabilityEventBus;
  readonly logger: ComisLogger;
  /** The per-agent registries map (the isBusy predicate resolves the live handle by sessionId). */
  readonly registries: ReadonlyMap<string, TerminalSessionRegistry>;
  /** The operator `worker.stuckMs` window the busy-vs-hung verdict compares against. */
  readonly workerStuckMs: number;
  readonly nowMs: () => number;
}

/**
 * Build the per-agent registry `durability` dep + the reaper `isBusy` predicate.
 *
 * `durability` (→ `createTerminalSessionRegistry`): the descriptor store + the `has-session`
 * probe + the two content-free hooks. `onReattached` → `terminal:drive_reattached` (I5 — the
 * re-attach runs under the SAME persisted allow-entry; the emit carries ids only). On a
 * genuinely-gone durable session `onUnrecoverable` → the EXISTING `terminal:session_state(
 * state:"lost")` + a content-free unrecoverable reason (NO `failed` member; NOTIFY-01 layers it).
 *
 * `isBusy` (→ the reaper, 165-08's seam): bound to 165-02's `busyOrHung` over the session's
 * `alive` (the handle is still `running` AND, for a durable session, its tmux is alive) + the
 * progress window (`nowMs - lastActivity`, which the LIVE-01 backstop keeps fresh for a
 * genuinely-busy compile via `checkLiveness`/`refreshLastActivity`). So a quiet-but-busy
 * multi-hour build is excluded from idle eviction (I9), while a genuinely-idle session is not.
 */
export function buildAgentTerminalDurability(i: AgentTerminalDurabilityInputs): {
  durability: TerminalDurabilityDeps;
  isBusy: (s: { sessionId: string; lastActivity: number }) => boolean;
} {
  const tmuxSocketPath = resolveTmuxSocketPath(terminalWorkerDir(i.dataDir));
  const isTmuxAlive = buildIsTmuxAlive(resolveDaemonTmuxPath(), tmuxSocketPath);
  const killTmuxSession = buildKillTmux(resolveDaemonTmuxPath(), tmuxSocketPath);
  const storeDeps: SessionDescriptorPersistenceDeps = { dataDir: i.dataDir, agentId: i.agentId };
  const descriptorStore = createSessionDescriptorStore(storeDeps);

  const durability: TerminalDurabilityDeps = {
    descriptorStore,
    isTmuxAlive,
    killTmuxSession,
    onReattached: ({ sessionId, agentId }) => {
      // DUR-01 (I5/I3): the re-attach ran under the SAME persisted allow-entry; the content-free
      // record carries ids only (the screen the drive resumed on rides the detached tmux, never the bus).
      //
      // ME-01 (165-REVIEW) — observability note: this fires from the registry's recover-on-boot,
      // which can run DURING the FLOOR-01 boot sweep BEFORE setupTerminalWake subscribes
      // terminal:drive_reattached (the boot race). So the BUS event may be lost on the boot path
      // (BL-02's lazy-seed makes RESUME independent of it). `terminal:drive_reattached` is also NOT
      // in observability's TRAJECTORY_BRIDGE_MAPPING (no trajectory record). Therefore the
      // AUTHORITATIVE §9 "reconstruct a 40h drive's restart via comis explain" record is the INFO
      // log BELOW (it fires here regardless of any subscriber), NOT the bus event — by design.
      i.eventBus.emit("terminal:drive_reattached", { sessionId, agentId, reason: "tmux_alive", timestamp: i.nowMs() });
      i.logger.info({ sessionId, agentId, step: "drive_reattached" }, "terminal durable drive re-attached on recover-on-boot");
    },
    onUnrecoverable: ({ sessionId, agentId, reason }) => {
      // DUR-02 (I10): a genuinely-gone durable session → the EXISTING lost state + a content-free
      // unrecoverable reason (the journal is PRESERVED by the holder; NOTIFY-01 layers `failed`).
      // errorKind is the literal "dependency" (a gone backend) — the closed-union invariant
      // requires a literal here, not the forwarded payload field (which is always "dependency").
      //
      // CR-01 (Phase 166): stamp `unrecoverable:true` + thread the content-free `reason` (e.g.
      // "tmux_session_gone") onto the lost emit. This is the ONLY emit site that marks the lost
      // genuine — the worker-crash respawn (setup-terminal-tools.ts:321) + the reaper's plain
      // lost (setup-terminal-tools.ts:243) deliberately leave both UNSET, so NOTIFY-01 reports
      // `failed` ONLY for THIS genuine death (I9/I10). The reason rides the user-facing `failed`
      // outcome + the §2.7 WARN so `comis explain` names the actual cause (WR-03), not a generic
      // "session_lost".
      i.eventBus.emit("terminal:session_state", { sessionId, agentId, state: "lost", unrecoverable: true, reason, durationMs: 0, timestamp: i.nowMs() });
      i.logger.warn(
        { sessionId, agentId, reason, hint: `a durable terminal drive could not be re-attached (${reason}); flipped lost with the journal preserved for a fresh drive`, errorKind: "dependency" as const, step: "drive_unrecoverable" },
        "terminal durable drive unrecoverable on recover-on-boot",
      );
    },
  };

  // ENDURE-01 / I9 (165-08's seam): the reaper idle-exclusion predicate, bound to 165-02's
  // busyOrHung. A durable session whose detached tmux is alive is alive regardless of the
  // worker; a non-durable running session is alive while the handle is running. The progress
  // window is `nowMs - lastActivity` — kept fresh for a genuinely-busy compile by the LIVE-01
  // backstop (checkLiveness's status round-trip + refreshLastActivity), so a quiet-but-busy
  // build reads `busy` and is excluded from idle eviction; a genuinely-idle session reads `hung`.
  const isBusy = (s: { sessionId: string; lastActivity: number }): boolean => {
    const reg = i.registries.get(i.agentId);
    const handle = reg?.get(s.sessionId, resolveStampedOwner(reg, s.sessionId, i.agentId));
    if (handle === undefined) return false; // gone → not busy (let the sweep do its thing)
    const alive = handle.status === "running" && (handle.durable !== true || (handle.tmuxName !== undefined && isTmuxAlive(handle.tmuxName, handle.tmuxSocket)));
    const signal: BusySignal = { alive, noProgressMs: Math.max(0, i.nowMs() - s.lastActivity), stuckMs: i.workerStuckMs };
    return busyOrHung(signal) === "busy";
  };

  return { durability, isBusy };
}

/** Inputs for the daemon-wide wake durability deps (the journal store + the LIVE-01 probes). */
export interface WakeDurabilityInputs {
  readonly dataDir: string;
  readonly registries: ReadonlyMap<string, TerminalSessionRegistry>;
  /** The operator `worker.stuckMs` the busy-vs-hung verdict compares against. */
  readonly workerStuckMs: number;
  readonly nowMs: () => number;
}

/** The default-agent terminal config the wake-durability bundle reads its operator caps from. */
export interface WakeDurabilityConfig {
  readonly drive?: {
    readonly heartbeatMs?: number;
    readonly maxCostUsd?: number | null;
    // NOTIFY-01 / NOTIFY-02 (166-03): the user-facing notification policy + the coarse heartbeat
    // cadence (`drive.notify` / `drive.heartbeatNotifyMs`, schema-skills.ts) — resolved here so
    // the wake holder gets them in the same bundle as heartbeatMs/maxCostUsd.
    readonly notify?: "terminal" | "all" | "none";
    readonly heartbeatNotifyMs?: number;
  };
  readonly worker?: { readonly stuckMs?: number };
}

/**
 * Build the COMPLETE daemon-wide wake durability bundle the composition root spreads into
 * `setupTerminalWake` — the {@link buildWakeDurabilityDeps} trio PLUS the operator drive caps
 * (`heartbeatMs` / `maxCostUsd`) resolved from the default agent's `drive` block. The wake-FSM
 * is one-per-daemon (like its hop caps), so these resolve from the default agent — the forcing
 * use case is the default agent driving its own session. Kept here (not inlined at the
 * `setup-tools.ts` call site) to keep that file under the 800-line architecture cap.
 */
export function buildTerminalWakeDurability(i: {
  readonly dataDir: string;
  readonly registries: ReadonlyMap<string, TerminalSessionRegistry>;
  readonly nowMs: () => number;
  readonly config: WakeDurabilityConfig | undefined;
}): ReturnType<typeof buildWakeDurabilityDeps> & {
  heartbeatMs: number;
  maxCostUsd: number | null;
  // NOTIFY-01 / NOTIFY-02 (166-03): the resolved user-facing notification policy + heartbeat
  // cadence, spread into setupTerminalWake (the daemon aliases `notify` → `notifyPolicy`).
  notifyPolicy: "terminal" | "all" | "none";
  heartbeatNotifyMs: number;
} {
  return {
    ...buildWakeDurabilityDeps({
      dataDir: i.dataDir,
      registries: i.registries,
      workerStuckMs: i.config?.worker?.stuckMs ?? 0,
      nowMs: i.nowMs,
    }),
    heartbeatMs: i.config?.drive?.heartbeatMs ?? 90_000,
    maxCostUsd: i.config?.drive?.maxCostUsd ?? null,
    // NOTIFY-01 (166-03): default "terminal" (today's intent — done/failed fire, the escalation
    // always fires); NOTIFY-02: default 1h (a coarse spam-free user heartbeat; 0 = terminal-only).
    notifyPolicy: i.config?.drive?.notify ?? "terminal",
    heartbeatNotifyMs: i.config?.drive?.heartbeatNotifyMs ?? 3_600_000,
  };
}

/**
 * Build the daemon-wide DUR-02 journal store + the LIVE-01 `checkLiveness`/`refreshLastActivity`
 * the wake holder consumes (spread into `setupTerminalWake`).
 *
 * - `driveJournalStore`: a thin `DriveJournalStorePort` wrapping the 165-04 fs-safe module
 *   functions bound to `dataDir` (persist-on-set + recover/load on re-attach + the explicit-only
 *   remove). Best-effort/total throughout (the module swallows faults).
 * - `checkLiveness(sessionId, agentId)`: the LIVE-01 single liveness check — the registry
 *   `status` round-trip (the worker's CLASSIFIER perception — `working`/`stuck`/`exited` — NOT a
 *   screen read, I2) mapped to a `BusySignal`. A `stuck` classifier verdict → `noProgressMs >
 *   stuckMs` → hung; `working`/`awaiting-input` → busy; `exited`/gone → not alive → hung. The
 *   `status` round-trip ALSO stamps the handle's `lastActivity` as a side effect (the registry's
 *   status method) — that IS the ENDURE-01 idle-reaper unify (I9): a busy verdict's liveness
 *   check refreshes lastActivity, so the idle sweep never evicts a quiet-but-busy compile. No
 *   SEPARATE refresh hook is needed (165-REVIEW LO-03 removed the redundant `refreshLastActivity`
 *   dep that double-stamped what `status` already does).
 */
export function buildWakeDurabilityDeps(i: WakeDurabilityInputs): {
  driveJournalStore: DriveJournalStorePort;
  checkLiveness: (sessionId: string, agentId: string) => Promise<LivenessSignal | undefined>;
} {
  const isTmuxAlive = buildIsTmuxAlive(
    resolveDaemonTmuxPath(),
    resolveTmuxSocketPath(terminalWorkerDir(i.dataDir)),
  );

  const driveJournalStore: DriveJournalStorePort = {
    persist: (agentId, sessionId, journal) => persistDriveJournal({ dataDir: i.dataDir }, agentId, sessionId, journal),
    // The resume read is per-session lazy (165-REVIEW BL-02/ME-03) — NO bulk recover.
    load: (agentId, sessionId): DriveJournal | undefined => loadDriveJournal({ dataDir: i.dataDir }, agentId, sessionId),
    remove: (agentId, sessionId) => removeDriveJournal({ dataDir: i.dataDir }, agentId, sessionId),
  };

  const checkLiveness = async (sessionId: string, agentId: string): Promise<LivenessSignal | undefined> => {
    const registry = i.registries.get(agentId);
    if (registry === undefined) return undefined; // no registry for the agent → gone
    const owner = resolveStampedOwner(registry, sessionId, agentId); // ISSUE-3: the live channel/API session's stamped owner
    const handle = registry.get(sessionId, owner);
    if (handle === undefined) return undefined; // gone → the backstop skips it
    // LINGER-01 (webhook-claude-cli-tdd-20260701-backstop): capture the idle clock BEFORE the probe.
    // The `status` round-trip below stamps `lastActivity = now` (the LO-03 I9 unify — keeps a
    // quiet-but-busy compile fresh so the reaper never false-evicts it). But an UNATTENDED
    // (webhook/cron, owner sessionKey "") drive that has cleanly SETTLED (awaiting-input) is
    // classified BUSY, so that same passive stamp keeps a FINISHED drive warm forever → the
    // ENDURE-01 idle reaper's `now - lastActivity > idleTtlMs` cap can never fire and the idle drive
    // lingers until clean-restart. For that one case we restore the pre-probe value below so the
    // reaper measures idleness from the drive's last REAL activity. (An interactive drive is left
    // warm — a human owns its lifecycle; a working/stuck drive is untouched — never a false-evict.)
    const idleClockBeforeProbe = handle.lastActivity;
    const isUnattended = owner.sessionKey === "";
    // The SINGLE liveness check: the worker `status` round-trip (CLASSIFIER perception, NOT a
    // screen read — I2). It also refreshes the handle's lastActivity as a side effect.
    const status = await registry.status(sessionId, owner);
    const stuckMs = i.workerStuckMs;
    if (status.state === "exited") return { alive: false, noProgressMs: 0, stuckMs };
    // For a durable session also require the detached tmux to be alive (a wedged-but-present
    // worker whose tmux died is hung). `stuck` from the classifier → past the no-progress window.
    const tmuxOk = handle.durable !== true || (handle.tmuxName !== undefined && isTmuxAlive(handle.tmuxName, handle.tmuxSocket));
    if (!tmuxOk) return { alive: false, noProgressMs: 0, stuckMs };
    if (status.state === "stuck") return { alive: true, noProgressMs: stuckMs + 1, stuckMs };
    // working / awaiting-input → busy (recent progress; the classifier did not flag no-progress).
    // DELIVER-01 (#2): surface `awaiting-input` (a settled prompt — a backgrounded drive that
    // finished its current work and is idle at its prompt) so the backstop can deliver a one-time
    // "finished — waiting for input" notification. A backgrounded drive emits no fd3 attention
    // once promoted, so without this the completion is never delivered. Purely additive — the
    // busy verdict is unchanged (awaiting-input is busy, never hung).
    if (status.state === "awaiting-input") {
      // LINGER-01: a SETTLED unattended drive made no progress — do NOT let the passive probe's
      // stamp refresh its idle clock, or the reaper's idleTtlMs cap can never evict the finished
      // drive. Restoring the pre-probe value keeps the completion signal (below) intact while
      // letting idleness accrue from the last real activity. Interactive drives keep the warm stamp.
      if (isUnattended) handle.lastActivity = idleClockBeforeProbe;
      return { alive: true, noProgressMs: 0, stuckMs, awaitingInput: true };
    }
    return { alive: true, noProgressMs: 0, stuckMs };
  };

  // LO-03 (165-REVIEW): NO separate refreshLastActivity — checkLiveness's `registry.status`
  // round-trip already stamps the handle's lastActivity (the registry's status side effect), so
  // a busy backstop verdict's liveness check IS the ENDURE-01 idle-reaper unify (I9). A separate
  // refresh hook double-stamped what status already does (dead weight) and is removed.

  return { driveJournalStore, checkLiveness };
}
