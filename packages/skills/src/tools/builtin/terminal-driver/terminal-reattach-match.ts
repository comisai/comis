// SPDX-License-Identifier: Apache-2.0
/**
 * The pure re-attach decision + the durable session descriptor.
 *
 * THE FRAMING (why this module exists at this layer). The tmux re-attach
 * MECHANISM already ships: `terminal-tmux-backend.ts` derives the deterministic
 * `comis-<sessionId>` name ({@link tmuxSessionName}), `has-session`-gates create-vs-
 * reattach, and `terminal-tmux-backend.linux.test.ts` proves a detached named session
 * survives a simulated restart. The genuine gap is one layer UP: the registry's
 * `sessionId` is an ephemeral `randomUUID()` it never persists, and there is no
 * recover-on-boot — so on a daemon restart its `sessions` Map starts EMPTY, and a healthy
 * 38h drive whose `comis-<old-id>` is STILL alive under tmux is wrongly flipped `lost`.
 * This module is NOT a tmux rebuild; it is the missing IDENTITY ({@link SessionDescriptor})
 * + the pure DECISION ({@link reattachDecision}) the registry's recover-on-boot
 * consumes to turn "the tmux server survived" into "the registry knows to re-attach."
 *
 * Given a persisted descriptor + a live `has-session` probe, {@link reattachDecision}
 * decides ONE of three actions:
 *   - `reattach` — durable + the tmux session is LIVE: re-attach (a 40h drive
 *     crosses the daemon's lifetime and is never lost). The descriptor (carrying the
 *     authorization identity) is returned VERBATIM for the caller to re-stamp.
 *   - `failed`/`tmux_session_gone` — durable but the tmux session is GONE (or the probe is
 *     unanswerable): a genuine death surfaces. The JOURNAL is preserved SEPARATELY by the
 *     caller (NOT touched here) — never a silent restart, never a double-drive.
 *   - `fallback_nondurable` — a `durable:false` (spawn) session: the plain lost floor.
 *     The probe is NEVER consulted (a non-durable session is not re-attachable).
 *
 * The SAFE direction (the whole point). A false `reattach` would spawn a SECOND CLI
 * against a session whose liveness we could not confirm — a double-drive. So on ANY doubt
 * (a throwing probe, a falsy/missing `tmuxName`, a degenerate descriptor) the decision
 * fails to `failed`/`tmux_session_gone`, NEVER `reattach`. The decision NEVER issues a
 * create frame — it only SIGNALS re-attach; the worker's `has-session`-gated backend does
 * the no-double-create (terminal-tmux-backend.ts:194-201).
 *
 * The identity passthrough (durability changes WHERE, never WHAT). The descriptor
 * carries `allowId`/`owner`/`scope`; the `reattach` action returns the SAME descriptor
 * object UNCHANGED — the decision never derives or widens the allow-entry/jail/uid. The
 * registry re-applies the SAME owner-gate from these carried fields.
 *
 * Architecture invariants (binding — AGENTS.md; mirrors
 * `terminal-drive-journal.ts` / `terminal-drive-promote.ts` / `terminal-dialog-detector.ts`):
 *   - PURE: free functions, NOT a factory. NO module-global mutable state, NO clock/timer
 *     reads, NO env read, NO I/O — the `has-session` liveness is an INJECTED probe
 *     (`isTmuxAlive`), so the decision is provable without a live tmux server.
 *   - TOTAL / NEVER throws: a degenerate descriptor or a faulting probe yields the SAFE
 *     shape (`failed`/`fallback_nondurable`), never an exception and never a wrong
 *     `reattach`. {@link deserializeDescriptor} returns `undefined` on any malformation
 *     (a corrupt-after-crash file is a corrupt-SKIP, mirroring `deserializeJournal`).
 *   - Infra-free: value-imports NOTHING — no platform runtime packages, no observability
 *     egress (the infra-runtime-scope architecture gate; this file names none of them).
 *     {@link SessionOwner} / {@link TerminalScope} are TYPE-only imports (the same identity
 *     shapes the registry/scope already define — never a second copy).
 *
 * @module
 */

import type { ChannelEndpoint } from "@comis/core";

import type { TerminalScope } from "./allowlist-matcher.js";
import type { SessionOwner } from "./terminal-session-owner.js";
import type { TerminalRootProcessIdentity } from "./terminal-managed-binding.js";

// ---------------------------------------------------------------------------
// The durable session descriptor — the persisted IDENTITY that survives a
// restart. Content-free: ids / enums / counts only. Persisting THIS is what
// lets recover-on-boot re-attach instead of flipping `lost`.
// ---------------------------------------------------------------------------

/**
 * The durable per-session record the registry persists for a `drive.durable:true`
 * session and recovers on boot. It carries exactly the identity the registry needs to
 * rebuild a running `SessionHandle` and re-attach to the SAME jail — never more.
 */
export interface SessionDescriptor {
  /**
   * The STABLE worker handle key. The registry mints it as `randomUUID()`; persisting it
   * here (so it survives a restart) is what makes recover-on-boot possible.
   */
  sessionId: string;
  /**
   * `tmuxSessionName(sessionId)` === `comis-<sessionId>` — the deterministic re-attach key.
   * The `has-session` probe is run against THIS name. Never a second naming
   * scheme: it must equal what `terminal-tmux-backend.ts:54` derives.
   */
  tmuxName: string;
  /**
   * ONE tmux server per session: the explicit `-S` socket path this durable session's own tmux
   * server is bound to — `<durableDir>/tmux-<sessionId>.sock`. A create always starts a fresh
   * server, so a NEW session is never placed on a server a prior daemon generation forked (whose
   * mount namespace systemd has since dismantled, killing every new `bwrap` in it). Persisting the
   * socket lets a restart re-attach the SURVIVOR from its own server, including one created on an
   * older build's per-boot socket. OPTIONAL: absent on a descriptor persisted without one (e.g.
   * non-durable), where the caller derives it from the session id. Validated as a non-empty string
   * when present.
   */
  tmuxSocket?: string;
  /** The allow-entry id to re-stamp VERBATIM on re-attach (WHERE not WHAT). */
  allowId: string;
  /** The owning `(agentId, sessionKey)` to re-stamp VERBATIM; type-only import. */
  owner: SessionOwner;
  /**
   * The conversation this drive was created from, persisted so a durable drive re-attached
   * after a daemon restart still reports its outcome to the thread that STARTED it rather
   * than to whichever conversation is most recent. Re-stamped verbatim, like `owner`.
   * OPTIONAL: absent on a descriptor persisted before this field existed, and on a drive
   * created outside a channel turn — both route through the shipped
   * primaryChannel→recent-session chain, unchanged.
   */
  originEndpoint?: ChannelEndpoint;
  /** The SAME jail/uid/credentialPaths scope — never widened; type-only import. */
  scope?: TerminalScope;
  /** Terminal columns of the (resumed) session. */
  cols: number;
  /** Terminal rows of the (resumed) session. */
  rows: number;
  /**
   * `false` ⇒ the {@link reattachDecision} `fallback_nondurable` short-circuit (the
   * plain lost floor for a non-durable spawn session; the probe is never consulted).
   */
  durable: boolean;
  /** Creation wall-clock (ms) — for the resumed session's wall-clock cap. */
  createdAt: number;
  managedRunId?: string;
  workspaceLeaseId?: string;
  serviceInstanceId?: string;
  rootProcessIdentity?: TerminalRootProcessIdentity;
}

/**
 * The re-attach decision — a closed discriminated union the registry switches on.
 * `reattach` carries the descriptor (verbatim, for re-stamping); `failed`/`fallback`
 * carry only the content-free `sessionId` (+ a reason on the genuine-death branch).
 */
export type ReattachDecision =
  | { action: "reattach"; descriptor: SessionDescriptor }
  | { action: "failed"; sessionId: string; reason: "tmux_session_gone" | "managed_root_identity_unavailable" | "managed_root_identity_mismatch" }
  | { action: "fallback_nondurable"; sessionId: string };

/** The content-free sessionId to carry on the failed/fallback branches (never throws). */
function safeSessionId(d: SessionDescriptor | undefined): string {
  return typeof d?.sessionId === "string" ? d.sessionId : "";
}

/**
 * Decide whether a persisted durable session should be re-attached, failed, or skipped as
 * non-durable — PURE, TOTAL, never throws.
 *
 * The decision order:
 *   1. NOT durable (or a degenerate descriptor with no `durable:true`) → `fallback_nondurable`
 *      (the lost-floor short-circuit; `isTmuxAlive` is NEVER consulted).
 *   2. Durable but a falsy/missing `tmuxName` → `failed` (unrecoverable identity; we never
 *      probe a falsy name).
 *   3. Durable + a well-formed name → probe `isTmuxAlive(tmuxName)` inside try/catch:
 *      - the probe THROWS → `failed` (the SAFE direction — never re-attach on doubt).
 *      - the probe returns truthy → continue to managed identity verification.
 *      - the probe returns falsy → `failed`/`tmux_session_gone` (genuinely gone — the
 *        caller preserves the journal SEPARATELY; nothing is deleted here).
 *   4. A managed session must resolve the same pane PID and process-start identity that
 *      the descriptor recorded. Missing or mismatched identity fails closed.
 *
 * NEVER re-attaches on doubt: a false `reattach` double-drives. The decision issues
 * no create frame — it only signals re-attach; the worker backend does the no-double-create.
 *
 * @param d - The persisted descriptor recovered on boot (untrusted after a crash).
 * @param isTmuxAlive - The injected `has-session` liveness probe (exit 0 ⇒ true ⇒ alive).
 * @param resolveTmuxRootProcessIdentity - The injected current pane identity resolver.
 */
export function reattachDecision(
  d: SessionDescriptor,
  isTmuxAlive: (name: string, socket?: string) => boolean,
  resolveTmuxRootProcessIdentity?: (name: string, socket?: string) => TerminalRootProcessIdentity | undefined,
): ReattachDecision {
  const sessionId = safeSessionId(d);

  // (1) Non-durable (or a descriptor that is not affirmatively durable) → the lost-floor
  // short-circuit. The probe is irrelevant for a session that is not re-attachable.
  if (d?.durable !== true) {
    return { action: "fallback_nondurable", sessionId };
  }

  // A managed descriptor is written before the create acknowledgement so a host
  // crash cannot orphan a surviving tmux pane. Until the acknowledgement supplies
  // and persists the root PID/start identity, that descriptor is intentionally
  // incomplete: preserve it for reconciliation, but never claim a safe re-attach.
  const hasManagedBinding = d.managedRunId !== undefined
    || d.workspaceLeaseId !== undefined
    || d.serviceInstanceId !== undefined;
  if (hasManagedBinding && d.rootProcessIdentity === undefined) {
    return { action: "failed", sessionId, reason: "managed_root_identity_unavailable" };
  }

  // (2) Durable but no usable re-attach key → unrecoverable identity. Never probe a falsy
  // name (it cannot match the deterministic `comis-<id>` scheme); fail SAFE.
  const name = d.tmuxName;
  if (typeof name !== "string" || name.length === 0) {
    return { action: "failed", sessionId, reason: "tmux_session_gone" };
  }

  // (3) Probe liveness. A throwing probe is treated as "cannot confirm alive" → the SAFE
  // direction is `failed`, NEVER `reattach` (a false re-attach would double-drive).
  let alive: boolean;
  try {
    // Probe the session's OWN per-boot server (`d.tmuxSocket`) — a survivor sits on its
    // prior-boot socket, not this boot's. Absent socket ⇒ the probe's default.
    alive = isTmuxAlive(name, d.tmuxSocket) === true;
  } catch {
    return { action: "failed", sessionId, reason: "tmux_session_gone" };
  }

  if (!alive) return { action: "failed", sessionId, reason: "tmux_session_gone" };
  if (hasManagedBinding) {
    let currentIdentity: TerminalRootProcessIdentity | undefined;
    try {
      currentIdentity = resolveTmuxRootProcessIdentity?.(name, d.tmuxSocket);
    } catch {
      currentIdentity = undefined;
    }
    if (
      currentIdentity === undefined
      || currentIdentity.pid !== d.rootProcessIdentity?.pid
      || currentIdentity.startIdentity !== d.rootProcessIdentity.startIdentity
    ) {
      return { action: "failed", sessionId, reason: "managed_root_identity_mismatch" };
    }
  }
  return { action: "reattach", descriptor: d };
}

// ---------------------------------------------------------------------------
// (De)serialize — pure, total, defensive. The durable recovery contract: a corrupt-
// after-crash descriptor is a corrupt-SKIP (undefined), never a partially-trusted object
// (mirrors deserializeJournal, terminal-drive-journal.ts:283-318 — but REJECTS on a
// missing/wrong-typed identity field rather than defaulting it, since the descriptor's
// fields are load-bearing identity, not resumable counts).
// ---------------------------------------------------------------------------

/** Serialize a descriptor to a JSON string. Pure; no fs write (the daemon persists it). */
export function serializeDescriptor(d: SessionDescriptor): string {
  return JSON.stringify(d);
}

/** True iff `v` is a non-empty string (every identity string field must be present). */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** True iff `v` is a finite number (cols/rows/createdAt). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** True iff `v` is a well-formed {@link SessionOwner} (both string fields present). */
function isOwner(v: unknown): v is SessionOwner {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // agentId must be a non-empty origin; sessionKey may be "" (a non-subagent origin).
  return isNonEmptyString(o.agentId) && typeof o.sessionKey === "string";
}

/**
 * The closed enum literals {@link TerminalScope} permits — validated structurally so a
 * smuggled-after-crash scope cannot inject an out-of-band filesystem/network/uid posture.
 * The optional `paths`/`hosts` arrays must be string[] when present.
 */
function isScope(v: unknown): v is TerminalScope {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  const fsOk = s.filesystem === "workspace" || s.filesystem === "listed-paths" || s.filesystem === "home" || s.filesystem === "full";
  const netOk = s.network === "none" || s.network === "listed-hosts" || s.network === "full";
  const uidOk = s.uid === "dedicated" || s.uid === "daemon";
  if (!fsOk || !netOk || !uidOk) return false;
  if (!Array.isArray(s.credentialPaths) || !s.credentialPaths.every((p) => typeof p === "string")) return false;
  if (!Array.isArray(s.ephemeralWritablePaths) || !s.ephemeralWritablePaths.every((p) => typeof p === "string" && (p === "~" || p.startsWith("~/") || p.startsWith("/")))) return false;
  if (s.paths !== undefined && !(Array.isArray(s.paths) && s.paths.every((p) => typeof p === "string"))) return false;
  if (s.hosts !== undefined && !(Array.isArray(s.hosts) && s.hosts.every((h) => typeof h === "string"))) return false;
  return true;
}

/**
 * True iff `v` is a well-formed {@link ChannelEndpoint} — the four required strings plus the
 * closed `conversationKind` enum and an optional string `threadId`. Structural only: the
 * notification service re-resolves and cross-checks the endpoint at send time, so this is a
 * shape guard against a corrupt-after-crash value, not an authorization check.
 */
function isChannelEndpoint(v: unknown): v is ChannelEndpoint {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (!isNonEmptyString(e.channelType) || !isNonEmptyString(e.channelInstanceId) || !isNonEmptyString(e.conversationId)) return false;
  if (e.conversationKind !== "direct" && e.conversationKind !== "shared") return false;
  if (e.threadId !== undefined && !isNonEmptyString(e.threadId)) return false;
  return true;
}

/**
 * Defensively map a persisted/parsed value to a {@link SessionDescriptor}, or `undefined`
 * if it is not a well-formed descriptor. PURE; TOTAL; NEVER throws. Accepts either a JSON
 * string (which it parses, treating invalid JSON as "no descriptor") or an already-parsed
 * value (the registry may deserialize once on recover-on-boot).
 *
 * Unlike `deserializeJournal` (which DEFAULTS oddities to a safe resumable shape), this
 * REJECTS any descriptor missing a required identity field or carrying a wrong-typed one —
 * the descriptor's fields are load-bearing AUTHORIZATION identity, not best-effort
 * resumable counts; a half-trusted descriptor must never reach the re-attach decision
 * (a corrupt descriptor is a corrupt-SKIP, like `recoverWakeStates`).
 */
export function deserializeDescriptor(raw: unknown): SessionDescriptor | undefined {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined; // a corrupt-after-crash file → corrupt-skip (never throw)
    }
  }

  // A non-object (null, number, string, array) carries no descriptor fields → skip.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const r = parsed as Record<string, unknown>;

  // Every required field must be present and the right primitive (no defaulting an
  // identity field — a missing tmuxName/allowId/owner is unrecoverable, not resumable).
  if (
    !isNonEmptyString(r.sessionId) ||
    !isNonEmptyString(r.tmuxName) ||
    !isNonEmptyString(r.allowId) ||
    !isOwner(r.owner) ||
    !isFiniteNumber(r.cols) ||
    !isFiniteNumber(r.rows) ||
    typeof r.durable !== "boolean" ||
    !isFiniteNumber(r.createdAt)
  ) {
    return undefined;
  }

  // `scope` is optional, but if present it must be a well-formed TerminalScope (a malformed
  // scope is rejected rather than silently dropped — dropping it would widen to defaults).
  if (r.scope !== undefined && !isScope(r.scope)) {
    return undefined;
  }

  // `tmuxSocket` is optional, but if present it must be a non-empty string — a
  // smuggled-after-crash non-string socket must never reach the per-session has-session probe /
  // attach (it would target the wrong / a degenerate server). A missing one means the caller
  // falls back to the boot socket — it is NOT a rejection.
  if (r.tmuxSocket !== undefined && !isNonEmptyString(r.tmuxSocket)) {
    return undefined;
  }

  const hasManagedIdentity = r.managedRunId !== undefined
    || r.workspaceLeaseId !== undefined
    || r.serviceInstanceId !== undefined
    || r.rootProcessIdentity !== undefined;
  if (hasManagedIdentity) {
    if (
      !isNonEmptyString(r.managedRunId)
      || !isNonEmptyString(r.workspaceLeaseId)
      || !isNonEmptyString(r.serviceInstanceId)
    ) return undefined;
    if (r.rootProcessIdentity !== undefined) {
      if (r.rootProcessIdentity === null || typeof r.rootProcessIdentity !== "object") return undefined;
      const identity = r.rootProcessIdentity as Record<string, unknown>;
      if (!Number.isSafeInteger(identity.pid) || (identity.pid as number) <= 0 || !isNonEmptyString(identity.startIdentity)) {
        return undefined;
      }
    }
  }

  const descriptor: SessionDescriptor = {
    sessionId: r.sessionId,
    tmuxName: r.tmuxName,
    allowId: r.allowId,
    owner: { agentId: r.owner.agentId, sessionKey: r.owner.sessionKey },
    cols: r.cols,
    rows: r.rows,
    durable: r.durable,
    createdAt: r.createdAt,
  };
  if (r.scope !== undefined) {
    descriptor.scope = r.scope as TerminalScope;
  }
  if (r.tmuxSocket !== undefined) {
    descriptor.tmuxSocket = r.tmuxSocket;
  }
  if (hasManagedIdentity) {
    descriptor.managedRunId = r.managedRunId as string;
    descriptor.workspaceLeaseId = r.workspaceLeaseId as string;
    descriptor.serviceInstanceId = r.serviceInstanceId as string;
    if (r.rootProcessIdentity !== undefined) {
      const identity = r.rootProcessIdentity as { pid: number; startIdentity: string };
      descriptor.rootProcessIdentity = { pid: identity.pid, startIdentity: identity.startIdentity };
    }
  }
  // `originEndpoint` is optional AND drop-on-malformed — a deliberate DIVERGENCE from the
  // reject-the-descriptor posture above. `scope`/`tmuxSocket` reject because dropping them
  // would widen the jail or probe the wrong server; a delivery hint grants nothing, so
  // dropping it degrades to the shipped primaryChannel→recent-session chain. Rejecting the
  // whole descriptor over a routing hint would instead flip a LIVE 40h drive to
  // unrecoverable on the next boot — strictly the worse failure. A descriptor written
  // before this field existed simply has none and re-attaches unchanged.
  if (isChannelEndpoint(r.originEndpoint)) {
    descriptor.originEndpoint = r.originEndpoint;
  }
  return descriptor;
}
