// SPDX-License-Identifier: Apache-2.0
/**
 * LeaseManager — the run-scoped, multi-use, revocable, audience-bound
 * capability lease.
 *
 * A `SessionManager` variant: same factory shape, same length-guarded
 * timing-safe `tokenEquals`, same lazy-TTL reaper — but the lease is the
 * authentication boundary for the jailed script surface, so it diverges in
 * four security-load-bearing ways:
 *   - MULTI-use: a lease is NOT consumed on first use (the jailed child
 *     dispatches many calls per run). The single-use `active=false` flip of
 *     SessionManager is deliberately removed.
 *   - REVOCABLE: a `revoked` flag gates BOTH `validate` AND `renew` (a
 *     compromised agent must not be able to keep renewing after revoke).
 *   - maxExpiresAt-bounded: `renew` clamps the new expiry to a hard ceiling
 *     and refuses once the clock is at/past it (no renew-forever).
 *   - AUDIENCE-bound (RFC 8707): each `validate` derives the required cap from
 *     `HANDLER_CAPABILITY_MAP[method]` and rejects if the lease does not hold
 *     it — a captured lease replayed at a foreign method is denied. Deriving
 *     the audience from the shipped map (not a bespoke audience claim) means
 *     caps and audience cannot drift. The one exception is the
 *     `tool.invoke` dispatch: it is not in `HANDLER_CAPABILITY_MAP`, so its
 *     audience is the INNER tool's cap from `TOOL_CAPABILITY_MAP[innerTool]`
 *     — still derived from a shipped table, so a lease scoped to
 *     `orch:read` cannot `tool.invoke` a `web_fetch` (orch:web).
 *
 * In-memory only (a `Map`, like SessionManager) — in-flight run state is not
 * persisted across restarts. The operator-facing revoke RPC + cascade live in
 * the daemon; this module ships the `revoked` field + the revocation-respecting
 * paths.
 *
 * SECURITY: bearer minted via `generateStrongToken()` (CSPRNG, never
 * `Math.random`); stored as a Buffer for `timingSafeEqual`; the length-guard in
 * `tokenEquals` rejects empty/short/long bearers without throwing.
 *
 * @module
 */
import { timingSafeEqual, randomUUID } from "node:crypto";
import {
  generateStrongToken,
  AGENT_CAPABILITIES,
  HANDLER_CAPABILITY_MAP,
  TOOL_CAPABILITY_MAP,
  SELF_SCOPED_AGENT_READS,
  API_CONTRACTS_ORDERED,
  type ClockPort,
  type AgentCapability,
  type DeliveryOrigin,
  type UserTrustLevel,
} from "@comis/core";

// O(1) membership for the self-scoped-read audience exception. The
// const is the single auditable source in @comis/core; building the Set once at
// module load keeps the per-validate check small.
const SELF_SCOPED_AGENT_READ_SET = new Set<string>(SELF_SCOPED_AGENT_READS);
const AGENT_CAPABILITY_SET = new Set<string>(AGENT_CAPABILITIES);
const ADMIN_SCOPED_RPC_METHODS = new Set(
  API_CONTRACTS_ORDERED
    .filter((contract) => contract.scopes.includes("admin"))
    .map((contract) => contract.method),
);

/** Internal lease entry — not exported. */
interface LeaseEntry {
  tokenBuf: Buffer;
  leaseId: string;
  agentId: string;
  caps: readonly AgentCapability[];
  budgetRef: string;
  sessionKey: string;
  trustLevel: UserTrustLevel;
  deliveryOrigin?: DeliveryOrigin;
  rootRunId: string;
  checkpointId?: string;
  parentLeaseId?: string;
  expiresAtMs: number;
  maxExpiresAtMs: number;
  revoked: boolean;
}

/** Input to mint a new lease. */
export interface MintLeaseInput {
  agentId: string;
  caps: readonly AgentCapability[];
  budgetRef: string;
  sessionKey: string;
  /** Exact framework-authenticated trust captured at the mint boundary. */
  trustLevel: UserTrustLevel;
  /** Immutable requester route captured when this lease is minted. */
  deliveryOrigin?: DeliveryOrigin;
  rootRunId: string;
  /** Unique execution checkpoint authorized by this lease, when applicable. */
  checkpointId?: string;
  parentLeaseId?: string;
  /** Soft TTL — the per-use validity window. Defaults to `defaultTtlMs`. */
  ttlMs?: number;
  /** Hard ceiling — `renew` can never push expiry past `now + maxTtlMs`. */
  maxTtlMs?: number;
}

/** The minted lease handle returned to the broker. */
export interface IssuedLease {
  leaseId: string;
  /** base64url bearer — injected as `COMIS_CAP_LEASE` into the jailed child. */
  bearer: string;
}

/** The validated lease projection handed to the endpoint (no secret material). */
export interface LeaseInfo {
  leaseId: string;
  agentId: string;
  caps: readonly AgentCapability[];
  budgetRef: string;
  sessionKey: string;
  /** Exact framework-authenticated trust captured at the mint boundary. */
  trustLevel: UserTrustLevel;
  /** Immutable requester route used to reconstruct a synthetic request boundary. */
  deliveryOrigin?: DeliveryOrigin;
  rootRunId: string;
  checkpointId?: string;
  parentLeaseId?: string;
}

export interface LeaseManager {
  mintLease(input: MintLeaseInput): IssuedLease;
  /**
   * Timing-safe + not-expired + not-revoked + audience-matched, else null.
   *
   * AUDIENCE (RFC 8707): for every method the required cap is derived from
   * `HANDLER_CAPABILITY_MAP[requestedMethod]`, EXCEPT the `tool.invoke` dispatch
   * — `tool.invoke` is not in that map; its audience is the INNER
   * tool's cap from `TOOL_CAPABILITY_MAP[innerTool]`. So a lease
   * scoped to `orch:read` is in-audience at `tool.invoke({tool:"memory_search"})`
   * (orch:read) and OUT of audience at `tool.invoke({tool:"web_fetch"})`
   * (orch:web) — a captured lease cannot dispatch a tool whose cap it lacks.
   *
   * @param innerTool - The `tool.invoke` inner tool name. REQUIRED when
   *   `requestedMethod === "tool.invoke"` (omitted/undefined → no inner-tool cap
   *   → denied); ignored for every other method (additive, no shim).
   */
  validate(rawBearer: string, requestedMethod: string, innerTool?: string): LeaseInfo | null;
  /** Renew the soft expiry, clamped to maxExpiresAt; null if revoked/at-ceiling/unknown. */
  renew(leaseId: string): { expiresAtMs: number } | null;
  /** Mark the lease revoked — denies the next validate AND renew. Returns the
   * honest count: `{ revoked: 1 }` if the id existed, `{ revoked: 0 }` if unknown. */
  revoke(leaseId: string): { revoked: number };
  /**
   * Cascade-revoke a lease and every descendant reachable via `parentLeaseId`.
   * Reaches grandchildren: revoking a parent revokes its children AND their
   * children. Built on the at-mint `parentLeaseId`→children adjacency (the
   * reverse of `parentLeaseId` does not exist otherwise). A `visited` set guards
   * re-entry; leaseIds never re-mint, so the tree is acyclic and the guard is
   * cheap insurance. The control-plane authority the admin `lease.revoke` /
   * `run.kill` RPC drives.
   */
  cascadeRevoke(leaseId: string, visited?: Set<string>): void;
  /**
   * Revoke EVERY lease of a root-run, cascading each to its
   * descendants. Scans on `rootRunId` and `cascadeRevoke`s each match through
   * ONE shared `visited` set, so the returned `revoked` is the distinct number
   * of leases flipped (a parent + its already-cascaded child are not
   * double-counted). An unknown root is a clean `{ revoked: 0 }` no-op — the
   * daemon RPC handler is the throw boundary, not this fan-out.
   */
  revokeByRootRun(rootRunId: string): { revoked: number };
}

export interface LeaseManagerDeps {
  clock: ClockPort;
  /** Default soft TTL when `mintLease` omits `ttlMs`. Default 15 min. */
  defaultTtlMs?: number;
}

/**
 * Length-guarded timing-safe buffer comparison.
 * MUST check length equality FIRST — timingSafeEqual throws on unequal lengths.
 *
 * Copied verbatim from session-manager.ts — the length-guard is load-bearing.
 */
function tokenEquals(candidate: Buffer, stored: Buffer): boolean {
  if (candidate.length !== stored.length) return false; // length-guard FIRST
  return timingSafeEqual(candidate, stored);
}

export function createLeaseManager(deps: LeaseManagerDeps): LeaseManager {
  const { clock, defaultTtlMs = 15 * 60 * 1000 } = deps;
  const leases = new Map<string, LeaseEntry>();
  // parentLeaseId → child leaseIds, built at MINT. cascadeRevoke reads this
  // reverse index to reach a lease's children/grandchildren; deriving it at
  // revoke time is impossible because parentLeaseId has no reverse index.
  const childrenByParent = new Map<string, Set<string>>();

  /**
   * Cascade-revoke `leaseId` and every descendant via the at-mint adjacency.
   * Recursion base case is the existing per-lease `revoke`; the `visited` set
   * guards re-entry so a double-call (or a contrived cycle) terminates.
   */
  function cascadeRevoke(leaseId: string, visited = new Set<string>()): void {
    if (visited.has(leaseId)) {
      return;
    }
    visited.add(leaseId);
    revokeLease(leaseId); // existing per-lease revoke (base case)
    for (const childId of childrenByParent.get(leaseId) ?? []) {
      cascadeRevoke(childId, visited); // recurse → reaches grandchildren
    }
  }

  /**
   * Per-lease revoke: flag the entry (do NOT delete) so validate denies it.
   * Returns 1 when an entry existed (now revoked), 0 for an UNKNOWN id — so the
   * exposed `revoke` reports an HONEST count to the operator and never a phantom
   * revoke of an id that was never minted.
   */
  function revokeLease(leaseId: string): number {
    // Keep the entry (do NOT delete) so validate's `revoked` check denies it;
    // the lazy-TTL reaper removes it once past maxExpiresAt, by which point
    // the bearer is dead anyway. A randomUUID() id is never reused.
    const entry = leases.get(leaseId);
    if (entry) {
      entry.revoked = true;
      return 1;
    }
    return 0;
  }

  return {
    mintLease(input: MintLeaseInput): IssuedLease {
      const leaseId = randomUUID();
      const bearer = generateStrongToken();
      const tokenBuf = Buffer.from(bearer, "base64url");
      const now = clock.now();
      const maxExpiresAtMs = now + (input.maxTtlMs ?? defaultTtlMs);
      // The soft expiry can never start beyond the hard ceiling.
      const expiresAtMs = Math.min(now + (input.ttlMs ?? defaultTtlMs), maxExpiresAtMs);
      const deliveryOrigin = input.deliveryOrigin === undefined
        ? undefined
        : Object.freeze({ ...input.deliveryOrigin });
      // Mint-time defensive validation + copy: callers retain no mutable
      // reference to the authority held by the lease, and a runtime claim that
      // escaped the TypeScript union is dropped rather than broadened.
      const caps = Object.freeze(
        input.caps.filter((cap): cap is AgentCapability => AGENT_CAPABILITY_SET.has(cap)),
      );
      leases.set(leaseId, {
        tokenBuf,
        leaseId,
        agentId: input.agentId,
        caps,
        budgetRef: input.budgetRef,
        sessionKey: input.sessionKey,
        trustLevel: input.trustLevel,
        ...(deliveryOrigin !== undefined ? { deliveryOrigin } : {}),
        rootRunId: input.rootRunId,
        ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
        ...(input.parentLeaseId !== undefined ? { parentLeaseId: input.parentLeaseId } : {}),
        expiresAtMs,
        maxExpiresAtMs,
        revoked: false,
      });
      // Build the parent→children adjacency at MINT so a later cascadeRevoke can
      // reach this lease from its parent. Deriving the reverse of parentLeaseId
      // at revoke time is impossible.
      if (input.parentLeaseId !== undefined) {
        const siblings = childrenByParent.get(input.parentLeaseId) ?? new Set<string>();
        siblings.add(leaseId);
        childrenByParent.set(input.parentLeaseId, siblings);
      }
      return { leaseId, bearer };
    },

    validate(rawBearer: string, requestedMethod: string, innerTool?: string): LeaseInfo | null {
      // An empty or malformed base64url string produces an empty/short Buffer —
      // the length-guard in tokenEquals rejects it without throwing.
      const candidateBuf = Buffer.from(rawBearer, "base64url");

      for (const [id, entry] of leases) {
        // Lazy hard-TTL eviction: once past the maxExpiresAt ceiling the lease
        // is dead forever (renew cannot revive it) — reap it.
        if (clock.now() > entry.maxExpiresAtMs) {
          leases.delete(id);
          continue;
        }
        // Soft expiry: past the per-use window but still before the ceiling →
        // denied for this use, but a renew can revive it (so do NOT delete).
        if (clock.now() > entry.expiresAtMs) {
          continue;
        }
        // Revocation gate (multi-use: do NOT flip any field to consume).
        if (entry.revoked) {
          continue;
        }
        if (!tokenEquals(candidateBuf, entry.tokenBuf)) {
          continue;
        }
        // The validated lease projection (no secret material) — handed out by
        // BOTH the self-scoped-read exception below and the cap-audience success
        // branch, so the two return the SAME shape.
        const leaseInfo: LeaseInfo = {
          leaseId: entry.leaseId,
          agentId: entry.agentId,
          caps: Object.freeze([...entry.caps]),
          budgetRef: entry.budgetRef,
          sessionKey: entry.sessionKey,
          trustLevel: entry.trustLevel,
          ...(entry.deliveryOrigin !== undefined ? { deliveryOrigin: entry.deliveryOrigin } : {}),
          rootRunId: entry.rootRunId,
          ...(entry.checkpointId !== undefined ? { checkpointId: entry.checkpointId } : {}),
          ...(entry.parentLeaseId !== undefined ? { parentLeaseId: entry.parentLeaseId } : {}),
        };
        // Self-scoped-read audience exception (whoami/status).
        // The three ungated, scopes:["rpc"], self-_agentId-scoped reads in
        // SELF_SCOPED_AGENT_READS (capabilities.introspect / session.status /
        // session.list) are in-audience for ANY valid lease — the cap-socket
        // whoami/status path. This short-circuits ONLY the orch:* cap-audience
        // deny below, and ONLY here AFTER the bearer/expiry/revoke/tokenEquals
        // authenticity gates (an expired/revoked/forged lease never reaches it).
        // It grants reach to NOTHING else: every gated / deny-by-origin method
        // still flows through the unchanged cap-audience computation. The
        // handlers self-scope to the injected _agentId, so the read reports only
        // the caller's OWN caps/status. The const is sourced beside
        // HANDLER_CAPABILITY_MAP in @comis/core (one auditable table; drift-test
        // pinned), so the exception cannot drift from the classification.
        if (SELF_SCOPED_AGENT_READ_SET.has(requestedMethod)) {
          return leaseInfo;
        }
        // Admin is a trust audience, not an orch:* capability. The endpoint
        // applies its absolute management denylist before this check, while
        // non-management admin RPCs inherit only an exact admin-trust lease.
        if (ADMIN_SCOPED_RPC_METHODS.has(requestedMethod)) {
          return entry.trustLevel === "admin" ? leaseInfo : null;
        }
        // Audience binding (RFC 8707): the requested method's required cap must
        // be one the lease holds. A non-cap method ("deny-by-origin"/"ungated")
        // or an unknown method has no orch:* cap → out of audience → deny.
        //
        // `tool.invoke` is NOT in HANDLER_CAPABILITY_MAP; its audience is the
        // INNER tool's cap from TOOL_CAPABILITY_MAP — derive from the SAME table
        // the dispatch gate reads, so caps and audience cannot drift. An
        // undefined/unmapped inner tool yields no cap → denied here, mirroring
        // the dispatch-layer default-deny (defense-in-depth with
        // requireCapability at the endpoint).
        const requiredCap =
          requestedMethod === "tool.invoke"
            ? innerTool === undefined
              ? undefined
              : TOOL_CAPABILITY_MAP[innerTool as keyof typeof TOOL_CAPABILITY_MAP]
            : HANDLER_CAPABILITY_MAP[requestedMethod as keyof typeof HANDLER_CAPABILITY_MAP];
        if (
          typeof requiredCap !== "string" ||
          !requiredCap.startsWith("orch:") ||
          !entry.caps.includes(requiredCap as AgentCapability)
        ) {
          return null;
        }
        return leaseInfo;
      }

      return null;
    },

    renew(leaseId: string): { expiresAtMs: number } | null {
      const entry = leases.get(leaseId);
      // Revocation gates renew (not only validate) — a revoked lease is dead.
      if (!entry || entry.revoked) {
        return null;
      }
      // Already at/past the hard ceiling → cannot extend.
      if (clock.now() >= entry.maxExpiresAtMs) {
        return null;
      }
      const candidate = clock.now() + defaultTtlMs;
      entry.expiresAtMs = Math.min(candidate, entry.maxExpiresAtMs);
      return { expiresAtMs: entry.expiresAtMs };
    },

    revoke(leaseId: string): { revoked: number } {
      // Honest count: 1 if the lease existed (now revoked), 0 for an unknown id.
      return { revoked: revokeLease(leaseId) };
    },

    cascadeRevoke(leaseId: string, visited = new Set<string>()): void {
      cascadeRevoke(leaseId, visited);
    },

    revokeByRootRun(rootRunId: string): { revoked: number } {
      // ONE shared `visited` set dedupes across the scan so the count is the
      // distinct number of leases revoked (a parent + its already-cascaded child
      // are not double-counted). An unknown root is a clean 0-revoke no-op — the
      // daemon RPC handler is the throw boundary.
      const visited = new Set<string>();
      for (const [id, entry] of leases) {
        if (entry.rootRunId === rootRunId) {
          cascadeRevoke(id, visited);
        }
      }
      return { revoked: visited.size };
    },
  };
}
