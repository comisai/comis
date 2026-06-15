// SPDX-License-Identifier: Apache-2.0
/**
 * The DUR-01 recover-on-boot SCAN orchestrator + the injected descriptor-store port
 * (Phase 165, plan 06; RESEARCH Pattern 1, Pitfall 5). This is the SIBLING that keeps
 * the 772-line registry under the 800-line cap: the registry's recover-on-boot is a
 * thin call into {@link recoverSessionDescriptors}, never an inlined scan loop.
 *
 * WHY THIS EXISTS (the load-bearing DUR-01 gap, framed in terminal-reattach-match.ts).
 * The tmux re-attach MECHANISM already ships (deterministic `comis-<id>` name +
 * `has-session`-gated create-vs-reattach + a linux survival test). The genuine gap is
 * one layer UP: the registry's `sessionId` is an ephemeral `randomUUID()` it never
 * persists, and there is NO recover-on-boot — so on a daemon restart its `sessions`
 * Map starts EMPTY and a healthy 40h drive whose `comis-<old-id>` is STILL alive under
 * tmux is wrongly flipped `lost`. This module is the missing RECONCILIATION: scan the
 * persisted {@link SessionDescriptor}s, run each through 165-01's pure
 * {@link reattachDecision}, and yield a typed list the registry switches on.
 *
 * THE DECISION VOCABULARY (mirrors 165-01, NOT a second copy). Each recovered
 * descriptor maps to exactly one {@link RecoveredAction}:
 *   - `reattach` — durable + the tmux session is LIVE: the registry rehydrates a
 *     `running` handle ({@link rehydrateHandleFromDescriptor}) and issues NO create
 *     frame (I10 — the worker's `has-session`-gated backend re-attaches the surviving
 *     pane on the NEXT read; a fresh create would double-drive). The descriptor's I5
 *     identity (allowId/owner/scope) is carried VERBATIM.
 *   - `failed` — durable but the tmux session is GONE (or the probe was unanswerable):
 *     the registry maps this to the EXISTING `terminal:session_state(state:"lost")` +
 *     a content-free unrecoverable reason and PRESERVES the journal. NOTE the
 *     discriminant keeps 165-01's internal name `failed`, but there is NO `failed`
 *     session_state member — the registry EMITS `lost`; the user-facing `failed`
 *     OUTCOME is layered downstream in Phase 166 NOTIFY-01. This module NEVER touches
 *     the journal (the preserve-on-gone contract is the caller's).
 *   - `fallback_nondurable` — a `durable:false` (spawn) session: SKIPPED here (filtered
 *     out of the result) so the registry's existing lost floor stands unchanged (I1).
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style; mirrors
 * `terminal-reattach-match.ts` / `terminal-drive-journal.ts`):
 *   - PURE via the INJECTED port: free functions, NOT a factory. NO module-global
 *     mutable state, NO clock/timer/env read, NO direct fs. The descriptor STORE
 *     ({@link SessionDescriptorStorePort}) and the `has-session` liveness
 *     (`isTmuxAlive`) are INJECTED — so the scan is provable without a live tmux
 *     server and without any disk. The actual fs write lives in the DAEMON impl of the
 *     port (165-07), NOT here — a testability seam, NOT because skills→observability
 *     is forbidden (it is allowed; this module simply needs no I/O).
 *   - TOTAL / NEVER throws: a corrupt descriptor (165-01's `deserializeDescriptor`
 *     already returns `undefined`, but the store does the deserialize) or a throwing
 *     probe / throwing `store.recover()` yields the SAFE shape (skip + continue),
 *     never an exception — a recover-on-boot scan must never crash daemon startup.
 *   - Infra-free: value-imports NOTHING but the sibling pure decision. {@link
 *     SessionDescriptor} / {@link SessionHandle} / {@link SessionOwner} are TYPE-only.
 *
 * @module
 */

import { reattachDecision, type SessionDescriptor } from "./terminal-reattach-match.js";
import type { SessionOwner } from "./terminal-session-owner.js";
import type { SessionHandle } from "./terminal-session-types.js";

/**
 * The durable descriptor store the registry's recover-on-boot consults. DEFINED here
 * (the consumer side); the DAEMON (165-07) IMPLEMENTS it as a sibling of the DUR-02
 * journal store (the fs-safe write + recover-on-boot scan over the confined durable
 * dir) and INJECTS it onto the registry deps. Unit tests pass a fake (in-memory) port
 * so the scan + decision are provable without any disk.
 *
 * `persist` is callable at create-time BEFORE the tmux session could exist (Pitfall 6
 * — a SIGKILL mid-create must not orphan tmux without a descriptor); `remove` is
 * ENOENT-tolerant (a double-remove on a gone session is a no-op, never a throw).
 */
export interface SessionDescriptorStorePort {
  /** Persist (or overwrite) the descriptor for a durable session. Best-effort; never throws. */
  persist(descriptor: SessionDescriptor): void;
  /**
   * Scan the durable dir and return every well-formed persisted descriptor (a
   * corrupt-after-crash file is a corrupt-SKIP via 165-01's `deserializeDescriptor`).
   * The daemon impl swallows fs faults; this module ALSO defends a throwing impl.
   */
  recover(): SessionDescriptor[];
  /** Remove a descriptor by sessionId. ENOENT-tolerant; never throws. */
  remove(sessionId: string): void;
}

/**
 * One recovered descriptor's resolved action — the closed union the registry switches
 * on. The `fallback_nondurable` arm of {@link reattachDecision} is NOT surfaced here:
 * a non-durable session is filtered out of the scan result (the registry's existing
 * lost floor handles it, I1), so the registry only ever sees `reattach`/`failed`.
 *
 * The `failed` arm carries the `owner` (NOT just the sessionId from 165-01's decision)
 * so the registry can fire its content-free unrecoverable hook with the `agentId`
 * (§2.7 — a failure branch is reconstructable per-agent from the bus alone) WITHOUT a
 * second descriptor lookup. The owner is the persisted I5 identity, never widened.
 */
export type RecoveredAction =
  | { action: "reattach"; descriptor: SessionDescriptor }
  | { action: "failed"; sessionId: string; owner: SessionOwner; reason: "tmux_session_gone" };

/** Dependencies for {@link recoverSessionDescriptors} — the injected store + liveness probe. */
export interface RecoverSessionDescriptorsDeps {
  /** The durable descriptor store (daemon impl in 165-07; a fake in unit tests). */
  store: SessionDescriptorStorePort;
  /** The `has-session` liveness probe (the worker's `has-session`), injected per 165-01. */
  isTmuxAlive: (name: string) => boolean;
}

/**
 * Scan the persisted descriptors and resolve each to a recover-on-boot action via
 * 165-01's pure {@link reattachDecision}. PURE (through the injected port), TOTAL,
 * NEVER throws (RESEARCH Pattern 1).
 *
 * For each descriptor `store.recover()` returns:
 *   - `reattach` (durable + live) → surfaced VERBATIM for the registry to rehydrate.
 *   - `failed` (durable + gone / unanswerable) → surfaced as the genuinely-gone action
 *     (the registry emits `lost` + keeps the journal). The decision's `tmux_session_gone`
 *     reason is carried for the §2.7 content-free hint/errorKind.
 *   - `fallback_nondurable` (non-durable) → SKIPPED (filtered out; today's lost floor).
 *
 * A throwing `store.recover()` (a disk read fault on boot) yields an EMPTY list — a
 * recover scan must never crash daemon startup; the worst case is "no session
 * recovered", identical to today's empty-Map-on-boot behavior (I1).
 *
 * @param deps - The injected descriptor store + the `has-session` liveness probe.
 * @returns The reattach/failed actions, in `store.recover()` order; non-durable skipped.
 */
export function recoverSessionDescriptors(deps: RecoverSessionDescriptorsDeps): RecoveredAction[] {
  let descriptors: SessionDescriptor[];
  try {
    descriptors = deps.store.recover();
  } catch {
    // A throwing store on boot → recover NOTHING (never crash startup). Same end-state
    // as today's empty `sessions` Map; the genuinely-alive tmux servers become orphans
    // the reaper/operator reaps by name (Pitfall 6), never a daemon-boot crash.
    return [];
  }
  if (!Array.isArray(descriptors)) return [];

  const out: RecoveredAction[] = [];
  for (const descriptor of descriptors) {
    // reattachDecision is TOTAL — a throwing probe / degenerate descriptor resolves to
    // `failed` (the SAFE direction, never a wrong `reattach`), so this loop never throws.
    const decision = reattachDecision(descriptor, deps.isTmuxAlive);
    if (decision.action === "reattach") {
      out.push({ action: "reattach", descriptor: decision.descriptor });
    } else if (decision.action === "failed") {
      // Carry the descriptor's owner (the persisted I5 identity) so the registry's
      // content-free unrecoverable hook gets the agentId without a second lookup.
      out.push({ action: "failed", sessionId: decision.sessionId, owner: descriptor.owner, reason: decision.reason });
    }
    // fallback_nondurable → skip (the registry's existing lost floor handles it, I1).
  }
  return out;
}

/**
 * Rebuild a `running` {@link SessionHandle} from a recovered descriptor (I5 — WHERE
 * not WHAT). The bulk lives HERE (not the registry) to protect the 800-line cap: the
 * registry's recover-on-boot just `sessions.set(d.sessionId, rehydrateHandleFromDescriptor(d, nowMs()))`.
 *
 * Identity is carried VERBATIM: `allowId`/`owner`/`cols`/`rows` from the descriptor,
 * plus the two DUR-01 handle fields `durable`/`tmuxName` (the durable marker the
 * durable-aware `markRunningSessionsLost` consults + the re-attach key it probes). The
 * status is `running` (a recovered live session is NOT lost) and NO create frame is
 * issued — the worker's `has-session`-gated backend re-attaches the surviving pane on
 * the next read (I10 — never double-drive).
 *
 * `command` is the descriptor's `allowId` (a display/audit label for `list`): the
 * descriptor persists IDENTITY, not the original `bin` argv — and the re-attach reads
 * the SURVIVING pane, so the original command string is neither needed nor re-spawned.
 * `startedAt` is the descriptor's `createdAt` (the resumed session's wall-clock cap is
 * measured from the ORIGINAL start, so a 40h cap is honored across the restart);
 * `lastActivity` is stamped at recover-time (`nowMs`) so the reaper does not
 * immediately idle-evict a freshly-recovered-but-quiet session.
 *
 * @param d - The recovered descriptor (durable + tmux-live, the `reattach` arm).
 * @param nowMs - The recover-time clock (the registry's injected `nowMs()`).
 */
export function rehydrateHandleFromDescriptor(d: SessionDescriptor, nowMs: number): SessionHandle {
  return {
    sessionId: d.sessionId,
    allowId: d.allowId,
    // The descriptor carries identity, not the bin argv; the allowId is the audit label.
    command: d.allowId,
    status: "running",
    cols: d.cols,
    rows: d.rows,
    lastActivity: nowMs,
    startedAt: d.createdAt,
    owner: d.owner,
    // The two DUR-01 handle fields: the durable marker + the re-attach key the
    // durable-aware markRunningSessionsLost consults (a durable + tmux-alive session
    // is NOT flipped lost on a worker close, Q4).
    durable: true,
    tmuxName: d.tmuxName,
  };
}

/**
 * DUR-01 / Q4 — the durable-aware lost gate (pure). `true` iff `handle` must NOT be
 * flipped `lost` on a worker close/crash: a DURABLE drive whose detached tmux server is
 * still alive outlives the worker (the lazy respawn re-attaches the surviving pane, I10).
 * The `isTmuxAlive(name)===true` gate is the SAFE direction — non-durable / no `tmuxName`
 * / falsy probe ⇒ `false`, falling through to today's lost flip (the documented floor,
 * I1). The registry consults it at BOTH lost sites (the worker-close flip + the
 * crash-flushed create-reply waiter), so a crash cannot re-flip a live durable session.
 */
export function staysRecoverable(
  handle: Pick<SessionHandle, "durable" | "tmuxName">,
  isTmuxAlive: (name: string) => boolean,
): boolean {
  return handle.durable === true && handle.tmuxName !== undefined && isTmuxAlive(handle.tmuxName) === true;
}

/**
 * Flip every still-`running` session in `sessions` to `lost` on a worker close/crash —
 * EXCEPT a durable session whose tmux is still alive ({@link staysRecoverable}, DUR-01 /
 * Q4 — its detached server outlives the worker; the lazy respawn re-attaches the surviving
 * pane on the next read, I10). The registry passes its map + injected probe; the loop body
 * lives here (cap headroom — Pitfall 5). The non-durable / no-probe case keeps today's
 * blanket lost flip (I1).
 */
export function markRunningSessionsLost(
  sessions: Map<string, SessionHandle>,
  isTmuxAlive: (name: string) => boolean,
): void {
  for (const handle of sessions.values()) {
    if (handle.status === "running" && !staysRecoverable(handle, isTmuxAlive)) handle.status = "lost";
  }
}

/** The inputs the registry's `create` has for a durable session (the descriptor source). */
export interface DurableCreateInputs {
  sessionId: string;
  tmuxName?: string;
  allowId: string;
  owner: SessionOwner;
  cols: number;
  rows: number;
  createdAt: number;
  scope?: SessionDescriptor["scope"];
}

/**
 * Build the durable {@link SessionDescriptor} the registry persists at create-time
 * (Pitfall 6 — persist BEFORE the create frame so a SIGKILL mid-create cannot orphan
 * tmux without a record). The tmux name defaults to the deterministic `comis-<id>` the
 * worker derives. Pure; the registry calls `store.persist(buildSessionDescriptor(...))`.
 */
export function buildSessionDescriptor(i: DurableCreateInputs): SessionDescriptor {
  const descriptor: SessionDescriptor = {
    sessionId: i.sessionId,
    tmuxName: i.tmuxName ?? `comis-${i.sessionId}`,
    allowId: i.allowId,
    owner: i.owner,
    cols: i.cols,
    rows: i.rows,
    durable: true,
    createdAt: i.createdAt,
  };
  if (i.scope !== undefined) descriptor.scope = i.scope;
  return descriptor;
}

/**
 * The DUR-01 durability seams the registry bundles as one nested `durability?` dep (so the
 * registry stays under the optional-field-bloat cap) + hands to {@link applyRecoveredSessions}
 * (so its recover-on-boot is a single delegated call). All optional: ABSENT `descriptorStore`
 * ⇒ a no-op (today's empty-Map-on-boot, I1). The hooks are injected (NOT a value-imported bus)
 * so the registry stays infra-decoupled; the fs-safe descriptor write lives in the daemon impl.
 *   - `descriptorStore` — persist-at-create + recover-on-boot (165-07's fs impl).
 *   - `isTmuxAlive` — the `has-session` probe the recover decision + the durable-aware lost gate use.
 *   - `onReattached` — fired ONCE per re-attach → the daemon's content-free `terminal:drive_reattached`.
 *   - `onUnrecoverable` — fired per genuinely-gone session → the daemon's EXISTING
 *     `terminal:session_state(state:"lost")` + a content-free reason (NO `failed` member, Phase-166).
 */
export interface TerminalDurabilityDeps {
  descriptorStore?: SessionDescriptorStorePort;
  isTmuxAlive?: (name: string) => boolean;
  onReattached?: (info: { sessionId: string; agentId: string }) => void;
  onUnrecoverable?: (info: { sessionId: string; agentId: string; reason: string; errorKind: string }) => void;
}

/**
 * The DUR-01 recover-on-boot APPLICATION: scan the persisted descriptors and, for each,
 * either rehydrate a `running` handle into the registry's `sessions` map (a live tmux,
 * NO create frame — I10) firing the content-free re-attach signal, or fire the
 * content-free unrecoverable hook (a genuinely-gone session — the daemon maps it to the
 * EXISTING `terminal:session_state(state:"lost")` + the reason; the journal is PRESERVED,
 * nothing removed here). A non-durable descriptor is skipped (today's lost floor, I1). The
 * `descriptorStore`-absent case is a no-op (I1). The BULK lives here (not the registry) to
 * protect the 800-line cap (Pitfall 5); the registry's recover-on-boot is ONE call.
 *
 * @param deps - The durability seams (descriptorStore + isTmuxAlive + the two hooks).
 * @param sessions - The registry's live session map (a recovered live session is set here).
 * @param nowMs - The registry's injected clock (stamps the rehydrated handle's lastActivity).
 */
export function applyRecoveredSessions(
  deps: TerminalDurabilityDeps,
  sessions: Map<string, SessionHandle>,
  nowMs: () => number,
): void {
  if (deps.descriptorStore === undefined) return; // today's wiring — no recover (I1).
  const isTmuxAlive = deps.isTmuxAlive ?? ((): boolean => false);
  for (const r of recoverSessionDescriptors({ store: deps.descriptorStore, isTmuxAlive })) {
    if (r.action === "reattach") {
      sessions.set(r.descriptor.sessionId, rehydrateHandleFromDescriptor(r.descriptor, nowMs()));
      deps.onReattached?.({ sessionId: r.descriptor.sessionId, agentId: r.descriptor.owner.agentId });
    } else {
      deps.onUnrecoverable?.({ sessionId: r.sessionId, agentId: r.owner.agentId, reason: r.reason, errorKind: "dependency" });
    }
  }
}
