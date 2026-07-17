// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { createTTLCache, err, ok, tryCatch } from "@comis/shared";
import type { Result, TTLCache } from "@comis/shared";
import type { TypedEventBus } from "../event-bus/bus.js";
import { emitObservationalEventSafely } from "../event-bus/observational-emission.js";
import {
  ApprovalCallbackOwnerSchema,
  parseSerializedApprovalCacheEntry,
  parseSerializedApprovalRequest,
} from "../domain/approval-request.js";
import type {
  ApprovalCallbackOwner,
  ApprovalRequest,
  ApprovalResolution,
  SerializedApprovalRequest,
  SerializedApprovalCacheEntry,
} from "../domain/approval-request.js";
import { parseFormattedSessionKey } from "../domain/session-key.js";
import type { ClockPort, TimerPort, TimerHandle } from "../ports/index.js";
import { createApprovalHmac, snapshotApprovalParams } from "./approval-fingerprint.js";
import { mintApprovalShortId } from "./approval-short-id.js";

/**
 * Dependencies for the approval gate factory.
 */
export interface ApprovalGateDeps {
  /** TypedEventBus for emitting approval:requested / approval:resolved events */
  readonly eventBus: TypedEventBus;
  /** Returns the default timeout in ms (reads from config.approvals.defaultTimeoutMs) */
  readonly getTimeoutMs: () => number;
  /** Returns the denial cache TTL in ms (reads from config.approvals.denialCacheTtlMs). Defaults to 60000 if not provided. */
  readonly getDenialCacheTtlMs?: () => number;
  /** Returns the batch approval cache TTL in ms (reads from config.approvals.batchApprovalTtlMs). Defaults to 30000 if not provided. Returns 0 to disable. */
  readonly getBatchApprovalTtlMs?: () => number;
  /** Wall-clock + monotonic time reads. */
  readonly clock: ClockPort;
  /** setTimeout/setInterval scheduling. */
  readonly timers: TimerPort;
  /** Stable secret used for domain-separated operation and cache HMACs. */
  readonly fingerprintSecret: string;
  /** Optional logger for cache hit/miss debug logging. Structural type -- no Pino import needed. */
  readonly logger?: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn?(...args: unknown[]): void;
  };
}

/**
 * ApprovalGate: Manages the lifecycle of pending approval requests.
 *
 * When an agent invokes a privileged tool, the gate pauses execution by
 * returning a promise that resolves only when an operator approves, denies,
 * or the configurable timeout expires (auto-deny).
 */
export interface ApprovalGate {
  /** Submit a request for approval. Returns a promise that resolves when approved/denied/timed-out. */
  requestApproval(
    req: Omit<ApprovalRequest, "requestId" | "shortId" | "createdAt" | "timeoutMs"> & {
      fingerprintParams: Record<string, unknown>;
    },
  ): Promise<ApprovalResolution>;

  /** Resolve (approve or deny) a pending request. */
  resolveApproval(
    requestId: string,
    approved: boolean,
    approvedBy: string,
    reason?: string,
  ): void;

  /** Get all pending (unresolved) requests. */
  pending(): ApprovalRequest[];

  /** Get a single pending request by ID, or undefined. */
  getRequest(requestId: string): ApprovalRequest | undefined;

  /**
   * Resolve a minted `shortId` to its pending request, or undefined.
   * Returns undefined once the request is resolved/disposed — the removal is the
   * router's replay guard. The orchestrator's InteractiveCallbackRouter is the sole
   * consumer; channels never call the gate.
   */
  getRequestByShortId(shortId: string): ApprovalRequest | undefined;

  /** Get all pending requests whose `sessionKey` matches (the plain-text router branch). */
  pendingForSession(sessionKey: string): ApprovalRequest[];

  /** Clear denial cache entries. If sessionKey is provided, clears entries for that session only. If omitted, clears all entries. */
  clearDenialCache(sessionKey?: string): void;

  /** Clear approval cache entries. If sessionKey is provided, clears entries for that session only. If omitted, clears all entries. */
  clearApprovalCache(sessionKey?: string): void;

  /** Serialize all pending requests to plain objects (for restart persistence). */
  serializePending(): SerializedApprovalRequest[];

  /** Restore pending requests from serialized records. Skips expired records. Returns count restored. */
  restorePending(records: readonly unknown[]): number;

  /** Serialize all approval cache entries to plain objects (for restart persistence). Skips expired entries. */
  serializeApprovalCache(): SerializedApprovalCacheEntry[];

  /** Restore approval cache entries from serialized records. Skips expired entries. Returns count restored. */
  restoreApprovalCache(entries: readonly unknown[]): number;

  /** Clean up all timers (for shutdown). */
  dispose(): void;
}

/**
 * Internal entry in the pending map.
 * Holds the request, the promise resolve callback, and the timeout handle.
 */
interface PendingEntry {
  readonly request: ApprovalRequest;
  readonly cacheKey: string;
  readonly resolve: (resolution: ApprovalResolution) => void;
  readonly timer: TimerHandle;
}

interface CachedApproval {
  readonly resolution: ApprovalResolution & { readonly approved: true };
  readonly expiresAt: number;
}

/** Prefix that keeps cache clearing by session exact and delimiter-safe. */
function cacheSessionPrefix(sessionKey: string): string {
  return `h1:${sessionKey.length}:${sessionKey}:`;
}

/**
 * Build a content-free cache key for one exact approval principal and action.
 * Parameters are canonicalized before hashing so object insertion order does
 * not split identical decisions, while parameter values never enter logs or
 * persisted cache keys.
 */
function createApprovalCacheKey(
  request: Pick<ApprovalRequest, "toolName" | "action" | "agentId" | "sessionKey" | "trustLevel" | "callbackOwner">,
  canonicalParams: string,
  secret: string,
): Result<string, Error> {
  if (
    typeof request.toolName !== "string"
    || request.toolName.length === 0
    || typeof request.action !== "string"
    || request.action.length === 0
    || typeof request.agentId !== "string"
    || request.agentId.length === 0
    || typeof request.sessionKey !== "string"
    || request.sessionKey.length === 0
    || !["admin", "user", "guest"].includes(request.trustLevel)
  ) {
    return err(new Error("Approval request identity is incomplete"));
  }

  const owner = request.callbackOwner;
  const digest = createApprovalHmac(secret, "cache", JSON.stringify([
      request.agentId,
      request.trustLevel,
      request.toolName,
      request.action,
      owner.tenantId,
      owner.userId,
      owner.channelType,
      owner.channelKey,
      owner.threadId ?? null,
      canonicalParams,
    ]));
  return digest.ok
    ? ok(`${cacheSessionPrefix(request.sessionKey)}${digest.value}`)
    : digest;
}

function snapshotCallbackOwner(
  raw: unknown,
  sessionKey: string,
): Result<ApprovalCallbackOwner, Error> {
  const parsedOwner = tryCatch(() => ApprovalCallbackOwnerSchema.safeParse(raw));
  if (!parsedOwner.ok || !parsedOwner.value.success) {
    return err(new Error("Approval callback owner is invalid"));
  }
  const session = parseFormattedSessionKey(sessionKey);
  const owner = parsedOwner.value.data;
  if (
    session === undefined
    || session.tenantId !== owner.tenantId
    || session.userId !== owner.userId
    || session.channelId !== owner.channelKey
    || session.threadId !== owner.threadId
  ) {
    return err(new Error("Approval callback owner conflicts with the session"));
  }
  return ok(Object.freeze({ ...owner }));
}

function isApprovalCacheKey(cacheKey: string): boolean {
  if (!cacheKey.startsWith("h1:")) return false;
  const lengthStart = 3;
  const lengthEnd = cacheKey.indexOf(":", lengthStart);
  if (lengthEnd <= lengthStart) return false;
  const sessionLength = Number(cacheKey.slice(lengthStart, lengthEnd));
  if (!Number.isSafeInteger(sessionLength) || sessionLength <= 0) return false;
  const digestStart = lengthEnd + 1 + sessionLength;
  return cacheKey.charAt(digestStart) === ":"
    && /^[0-9a-f]{64}$/.test(cacheKey.slice(digestStart + 1));
}

/**
 * Create an ApprovalGate instance.
 *
 * The gate manages an in-memory map of pending approval requests. Each request
 * creates a Promise that blocks the calling tool execution until an operator
 * resolves it or the timeout fires an auto-deny.
 *
 * @param deps - EventBus and config accessor
 * @returns ApprovalGate interface
 */
export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  const pendingMap = new Map<string, PendingEntry>();

  /**
   * Secondary index: minted `shortId → requestId`. Lets the InteractiveCallbackRouter
   * resolve an attacker-supplied shortId to a server-side requestId/sessionKey.
   * INVARIANT: mutated symmetrically with `pendingMap` at EVERY
   * set/delete/clear site — a stale entry would defeat replay rejection, since the
   * pending-table removal IS the router's replay guard.
   */
  const shortIdIndex = new Map<string, string>();

  /** Denial cache: keyed by exact session, principal, tool, action, and parameter digest. */
  const denialCache: TTLCache<ApprovalResolution> = createTTLCache<ApprovalResolution>({
    ttlMs: deps.getDenialCacheTtlMs?.() ?? 60_000,
    nowMs: () => deps.clock.now(),
  });

  /** Approval cache: keyed by exact session, principal, tool, action, and parameter digest. */
  const approvalCache: TTLCache<CachedApproval> = createTTLCache<CachedApproval>({
    ttlMs: deps.getBatchApprovalTtlMs?.() ?? 30_000,
    nowMs: () => deps.clock.now(),
  });

  /** Batch followers keyed by the same exact identity used by the caches. */
  const batchFollowers = new Map<string, Array<(res: ApprovalResolution) => void>>();

  function resolveApproval(
    requestId: string,
    approved: boolean,
    approvedBy: string,
    reason?: string,
  ): void {
    const entry = pendingMap.get(requestId);
    if (!entry) {
      // Already resolved (timeout vs manual race) — idempotent, return silently.
      return;
    }

    // Clear the timeout timer to prevent double-resolution.
    entry.timer.cancel();

    const resolution: ApprovalResolution = {
      requestId,
      approved,
      approvedBy,
      reason,
      resolvedAt: deps.clock.now(),
    };

    // Claim the authoritative resolution before any synchronous observer can
    // re-enter this gate. Promise callbacks still resume on a later microtask.
    pendingMap.delete(requestId);
    shortIdIndex.delete(entry.request.shortId);
    const followers = batchFollowers.get(entry.cacheKey);
    batchFollowers.delete(entry.cacheKey);

    // Approval/denial cache management with mutual invalidation.
    const { cacheKey } = entry;

    if (approved) {
      // Populate approval cache (only for explicit user approvals, NOT for system:cached-approval)
      if (approvedBy !== "system:cached-approval") {
        const ttl = deps.getBatchApprovalTtlMs?.() ?? 30_000;
        if (ttl > 0) {
          const cachedResolution = {
            requestId,
            approved: true as const,
            approvedBy,
            reason,
            resolvedAt: resolution.resolvedAt,
          };
          approvalCache.set(cacheKey, {
            resolution: cachedResolution,
            expiresAt: resolution.resolvedAt + ttl,
          }, ttl);
        }
      }
      // Mutual invalidation: approval clears stale denial for exact key
      denialCache.delete(cacheKey);
    } else {
      // Denial path: differentiate by approvedBy source
      if (approvedBy === "system:shutdown") {
        // Shutdown denials do NOT clear the approval cache — they are mechanical,
        // not user intent. They also do NOT populate the denial cache.
      } else if (approvedBy === "system:timeout") {
        // Timeout-denials DO clear the approval cache: a cached approval is stale
        // once its follow-up request times out.
        approvalCache.delete(cacheKey);
        // Timeout denials do NOT populate the denial cache.
      } else {
        // Explicit user denial (/deny command): populate the denial cache.
        denialCache.set(cacheKey, { requestId, approved, approvedBy, reason, resolvedAt: deps.clock.now() });
        // Mutual invalidation: denial clears the stale approval for the exact key
        // (denial always wins).
        approvalCache.delete(cacheKey);
      }
    }

    // Resolve the exact claimed decision before observational fan-out. Awaiting
    // callers cannot resume until this synchronous stack has completed.
    entry.resolve(resolution);
    if (followers) {
      for (const followerResolve of followers) followerResolve(resolution);
    }

    emitObservationalEventSafely(deps, "approval:resolved", {
      requestId,
      approved,
      approvedBy,
      reason,
      resolvedAt: resolution.resolvedAt,
    });

  }

  function requestApproval(
    req: Omit<ApprovalRequest, "requestId" | "shortId" | "createdAt" | "timeoutMs"> & {
      fingerprintParams: Record<string, unknown>;
    },
  ): Promise<ApprovalResolution> {
    const captured = tryCatch(() => ({
      toolName: req.toolName,
      action: req.action,
      params: req.params,
      fingerprintParams: req.fingerprintParams,
      agentId: req.agentId,
      sessionKey: req.sessionKey,
      trustLevel: req.trustLevel,
      callbackOwner: req.callbackOwner,
    }));
    const summary = captured.ok
      ? snapshotApprovalParams(captured.value.params)
      : err(new Error("Approval request could not be inspected"));
    const fingerprintParams = captured.ok
      ? snapshotApprovalParams(captured.value.fingerprintParams)
      : err(new Error("Approval request could not be inspected"));
    const callbackOwner = captured.ok
      ? snapshotCallbackOwner(captured.value.callbackOwner, captured.value.sessionKey)
      : err(new Error("Approval request could not be inspected"));
    const operationFingerprint = fingerprintParams.ok
      ? createApprovalHmac(
          deps.fingerprintSecret,
          "operation",
          fingerprintParams.value.canonical,
        )
      : fingerprintParams;
    const displayParams = summary.ok && operationFingerprint.ok
      ? snapshotApprovalParams({
          ...summary.value.value,
          operationFingerprint: operationFingerprint.value,
        })
      : err(new Error("Approval parameters could not be inspected"));
    const cacheKeyResult = captured.ok && callbackOwner.ok && displayParams.ok
      ? createApprovalCacheKey({
          toolName: captured.value.toolName,
          action: captured.value.action,
          agentId: captured.value.agentId,
          sessionKey: captured.value.sessionKey,
          trustLevel: captured.value.trustLevel,
          callbackOwner: callbackOwner.value,
        }, displayParams.value.canonical, deps.fingerprintSecret)
      : err(new Error("Approval request identity is invalid"));
    if (
      !captured.ok
      || !callbackOwner.ok
      || !cacheKeyResult.ok
      || !displayParams.ok
    ) {
      const resolution: ApprovalResolution = {
        requestId: randomUUID(),
        approved: false,
        approvedBy: "system:invalid-request",
        reason: "Approval request identity or parameters are invalid",
        resolvedAt: deps.clock.now(),
      };
      emitObservationalEventSafely(deps, "approval:resolved", { ...resolution });
      return Promise.resolve(resolution);
    }
    const cacheKey = cacheKeyResult.value;
    const requestInput = captured.value;

    // Check approval cache BEFORE denial cache: a recent approval overrides an older denial.
    const ttlMs = deps.getBatchApprovalTtlMs?.() ?? 30_000;
    if (ttlMs > 0) {
      if (approvalCache.get(cacheKey)) {
        // Log cache hit
        deps.logger?.debug({ cacheKey, action: requestInput.action }, "Approval cache hit");
        // Return cached approval immediately with a new requestId
        const resolution: ApprovalResolution = {
          requestId: randomUUID(),
          approved: true,
          approvedBy: "system:cached-approval",
          reason: `Auto-approved: prior approval for ${requestInput.action} still active`,
          resolvedAt: deps.clock.now(),
        };
        emitObservationalEventSafely(deps, "approval:resolved", { ...resolution });
        return Promise.resolve(resolution);
      }
    }

    // Check denial cache before creating a new pending entry.
    // TTLCache.get() returns undefined for expired entries (auto-evicts).
    const cachedDenial = denialCache.get(cacheKey);
    if (cachedDenial) {
      // Return cached denial immediately with a new requestId
      const resolution: ApprovalResolution = {
        requestId: randomUUID(),
        approved: false,
        approvedBy: "system:cached-denial",
        reason: `Auto-denied: prior denial for ${requestInput.action} still active`,
        resolvedAt: deps.clock.now(),
      };
      emitObservationalEventSafely(deps, "approval:resolved", { ...resolution });
      return Promise.resolve(resolution);
    }

    // Batch parallel requests only when the complete approval identity matches;
    // a matching pending request gets one follower instead of another prompt.
    for (const entry of pendingMap.values()) {
      if (entry.cacheKey === cacheKey) {
        return new Promise<ApprovalResolution>((resolve) => {
          let arr = batchFollowers.get(cacheKey);
          if (!arr) {
            arr = [];
            batchFollowers.set(cacheKey, arr);
          }
          arr.push(resolve);
        });
      }
    }

    const requestId = randomUUID();
    // Mint the callback-safe short id. The gate is the sole minter;
    // callers never supply it (it is Omit-ted from the requestApproval input).
    const shortId = mintApprovalShortId();
    const timeoutMs = deps.getTimeoutMs();
    const createdAt = deps.clock.now();

    const request: ApprovalRequest = Object.freeze({
      requestId,
      shortId,
      toolName: requestInput.toolName,
      action: requestInput.action,
      params: displayParams.value.value,
      agentId: requestInput.agentId,
      sessionKey: requestInput.sessionKey,
      trustLevel: requestInput.trustLevel,
      callbackOwner: callbackOwner.value,
      createdAt,
      timeoutMs,
    });

    const promise = new Promise<ApprovalResolution>((resolve) => {
      const timer = deps.timers.setTimeout(() => {
        resolveApproval(requestId, false, "system:timeout", "Approval request timed out");
      }, timeoutMs);

      // Prevent the timer from keeping the process alive during shutdown.
      // .unref() preserved per the TimerHandle cancel-safety contract.
      timer.unref();

      pendingMap.set(requestId, { request, cacheKey, resolve, timer });
      // Populate the secondary index with the freshly minted shortId.
      shortIdIndex.set(shortId, requestId);
    });

    // Params are a deeply frozen snapshot; subscribers cannot mutate pending state.
    emitObservationalEventSafely(deps, "approval:requested", {
      requestId,
      shortId: request.shortId,
      toolName: request.toolName,
      action: request.action,
      params: request.params,
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      trustLevel: request.trustLevel,
      createdAt: request.createdAt,
      timeoutMs: request.timeoutMs,
      channelType: request.callbackOwner.channelType,
    });

    return promise;
  }

  function pending(): ApprovalRequest[] {
    return Array.from(pendingMap.values()).map((e) => e.request);
  }

  function getRequest(requestId: string): ApprovalRequest | undefined {
    return pendingMap.get(requestId)?.request;
  }

  function getRequestByShortId(shortId: string): ApprovalRequest | undefined {
    const requestId = shortIdIndex.get(shortId);
    return requestId === undefined ? undefined : pendingMap.get(requestId)?.request;
  }

  function pendingForSession(sessionKey: string): ApprovalRequest[] {
    return Array.from(pendingMap.values())
      .map((e) => e.request)
      .filter((r) => r.sessionKey === sessionKey);
  }

  function clearDenialCache(sessionKey?: string): void {
    if (sessionKey === undefined) {
      denialCache.clear();
    } else {
      const prefix = cacheSessionPrefix(sessionKey);
      for (const [key] of denialCache.entries()) {
        if (key.startsWith(prefix)) {
          denialCache.delete(key);
        }
      }
    }
  }

  function clearApprovalCache(sessionKey?: string): void {
    if (sessionKey === undefined) {
      approvalCache.clear();
    } else {
      const prefix = cacheSessionPrefix(sessionKey);
      for (const [key] of approvalCache.entries()) {
        if (key.startsWith(prefix)) {
          approvalCache.delete(key);
        }
      }
    }
  }

  function dispose(): void {
    for (const entry of pendingMap.values()) {
      entry.timer.cancel();
      const resolution: ApprovalResolution = {
        requestId: entry.request.requestId,
        approved: false,
        approvedBy: "system:shutdown",
        reason: "Daemon shutting down",
        resolvedAt: deps.clock.now(),
      };
      entry.resolve(resolution);
      const followers = batchFollowers.get(entry.cacheKey);
      if (followers) {
        for (const followerResolve of followers) {
          followerResolve(resolution);
        }
        batchFollowers.delete(entry.cacheKey);
      }
    }
    pendingMap.clear();
    shortIdIndex.clear();
    denialCache.clear();
    approvalCache.clear();
    batchFollowers.clear();
  }

  function serializePending(): SerializedApprovalRequest[] {
    return Array.from(pendingMap.values()).map((e) => ({
      requestId: e.request.requestId,
      shortId: e.request.shortId,
      toolName: e.request.toolName,
      action: e.request.action,
      params: { ...e.request.params },
      agentId: e.request.agentId,
      sessionKey: e.request.sessionKey,
      trustLevel: e.request.trustLevel,
      callbackOwner: { ...e.request.callbackOwner },
      createdAt: e.request.createdAt,
      timeoutMs: e.request.timeoutMs,
    }));
  }

  function serializeApprovalCache(): SerializedApprovalCacheEntry[] {
    const entries: SerializedApprovalCacheEntry[] = [];
    // entries() only yields live (non-expired) entries
    for (const [cacheKey, cached] of approvalCache.entries()) {
      const { resolution } = cached;
      entries.push({
        cacheKey,
        resolution: {
          requestId: resolution.requestId,
          approved: true,
          approvedBy: resolution.approvedBy,
          ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
          resolvedAt: resolution.resolvedAt,
        },
        expiresAt: cached.expiresAt,
      });
    }
    return entries;
  }

  function restoreApprovalCache(entries: readonly unknown[]): number {
    const now = deps.clock.now();
    let restored = 0;
    for (const rawEntry of entries) {
      const parsed = parseSerializedApprovalCacheEntry(rawEntry);
      if (!parsed.ok) continue;
      const entry = parsed.value;
      if (entry.expiresAt <= now || !isApprovalCacheKey(entry.cacheKey)) continue;
      approvalCache.set(entry.cacheKey, {
        resolution: { ...entry.resolution },
        expiresAt: entry.expiresAt,
      }, entry.expiresAt - now);
      restored++;
    }
    return restored;
  }

  function restorePending(records: readonly unknown[]): number {
    let restored = 0;
    const now = deps.clock.now();
    for (const rawRecord of records) {
      const parsedRecord = parseSerializedApprovalRequest(rawRecord);
      if (!parsedRecord.ok) continue;
      const record = parsedRecord.value;
      const elapsed = now - record.createdAt;
      if (elapsed >= record.timeoutMs) continue; // Already expired, skip

      const params = snapshotApprovalParams(record.params);
      const callbackOwner = snapshotCallbackOwner(record.callbackOwner, record.sessionKey);
      if (!params.ok || !callbackOwner.ok) continue;
      if (
        pendingMap.has(record.requestId)
        || shortIdIndex.has(record.shortId)
      ) continue;

      const remainingMs = record.timeoutMs - elapsed;
      const request: ApprovalRequest = Object.freeze({
        requestId: record.requestId,
        shortId: record.shortId,
        toolName: record.toolName,
        action: record.action,
        params: params.value.value,
        agentId: record.agentId,
        sessionKey: record.sessionKey,
        trustLevel: record.trustLevel,
        callbackOwner: callbackOwner.value,
        createdAt: record.createdAt,
        timeoutMs: record.timeoutMs,
      });
      const cacheKeyResult = createApprovalCacheKey(
        request,
        params.value.canonical,
        deps.fingerprintSecret,
      );
      if (!cacheKeyResult.ok) continue;

      // Create a new pending entry with the ORIGINAL requestId.
      // The restored entry creates a fresh promise but the key behavior is that
      // resolveApproval(requestId, ...) works after restart.
      const timer = deps.timers.setTimeout(() => {
        resolveApproval(record.requestId, false, "system:timeout", "Approval request timed out");
      }, remainingMs);

      // .unref() preserved per the TimerHandle cancel-safety contract.
      timer.unref();

      // Use a no-op resolve for the restored entry; the original caller's promise
      // is gone after restart. resolveApproval() will still emit events.
      pendingMap.set(record.requestId, {
        request,
        cacheKey: cacheKeyResult.value,
        resolve: () => {},
        timer,
      });
      // Restore the secondary index too, or restored approvals are unreachable via
      // getRequestByShortId — the persisted shortId is re-used so callback identity
      // survives the restart.
      shortIdIndex.set(record.shortId, record.requestId);

      // Emit approval:requested so channel adapters can re-render the approval prompt.
      // The persisted shortId is re-used so callback identity survives the restart.
      emitObservationalEventSafely(deps, "approval:requested", {
        requestId: request.requestId,
        shortId: request.shortId,
        toolName: request.toolName,
        action: request.action,
        params: request.params,
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        trustLevel: request.trustLevel,
        createdAt: request.createdAt,
        timeoutMs: request.timeoutMs,
        channelType: request.callbackOwner.channelType,
      });

      restored++;
    }
    return restored;
  }

  return {
    requestApproval,
    resolveApproval,
    pending,
    getRequest,
    getRequestByShortId,
    pendingForSession,
    clearDenialCache,
    clearApprovalCache,
    serializePending,
    restorePending,
    serializeApprovalCache,
    restoreApprovalCache,
    dispose,
  };
}
