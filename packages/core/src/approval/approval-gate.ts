import { randomUUID } from "node:crypto";
import { createTTLCache } from "@comis/shared";
import type { TTLCache } from "@comis/shared";
import type { TypedEventBus } from "../event-bus/bus.js";
import type { ApprovalRequest, ApprovalResolution, SerializedApprovalRequest, SerializedApprovalCacheEntry } from "../domain/approval-request.js";

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
  /** Optional logger for cache hit/miss debug logging. Structural type -- no Pino import needed. */
  readonly logger?: {
    debug(obj: Record<string, unknown>, msg: string): void;
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
    req: Omit<ApprovalRequest, "requestId" | "createdAt" | "timeoutMs"> & { channelType?: string },
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

  /** Clear denial cache entries. If sessionKey is provided, clears entries for that session only. If omitted, clears all entries. */
  clearDenialCache(sessionKey?: string): void;

  /** Clear approval cache entries. If sessionKey is provided, clears entries for that session only. If omitted, clears all entries. */
  clearApprovalCache(sessionKey?: string): void;

  /** Serialize all pending requests to plain objects (for restart persistence). */
  serializePending(): SerializedApprovalRequest[];

  /** Restore pending requests from serialized records. Skips expired records. Returns count restored. */
  restorePending(records: SerializedApprovalRequest[]): number;

  /** Serialize all approval cache entries to plain objects (for restart persistence). Skips expired entries. */
  serializeApprovalCache(): SerializedApprovalCacheEntry[];

  /** Restore approval cache entries from serialized records. Skips expired entries. Returns count restored. */
  restoreApprovalCache(entries: SerializedApprovalCacheEntry[]): number;

  /** Clean up all timers (for shutdown). */
  dispose(): void;
}

/**
 * Internal entry in the pending map.
 * Holds the request, the promise resolve callback, and the timeout handle.
 */
interface PendingEntry {
  readonly request: ApprovalRequest;
  readonly resolve: (resolution: ApprovalResolution) => void;
  readonly timer: ReturnType<typeof setTimeout>;
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

  /** Denial cache: keyed by `${sessionKey}::${action}`, stores cached denial resolutions. TTL managed by createTTLCache. */
  const denialCache: TTLCache<ApprovalResolution> = createTTLCache<ApprovalResolution>({
    ttlMs: deps.getDenialCacheTtlMs?.() ?? 60_000,
  });

  /** Approval cache: keyed by `${sessionKey}::${action}`, stores cached approval resolutions. TTL managed by createTTLCache. */
  const approvalCache: TTLCache<ApprovalResolution> = createTTLCache<ApprovalResolution>({
    ttlMs: deps.getBatchApprovalTtlMs?.() ?? 30_000,
  });

  /** Batch followers: keyed by `${sessionKey}::${action}`, holds resolve callbacks for parallel requests that joined an existing pending entry. */
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
    clearTimeout(entry.timer);

    const resolution: ApprovalResolution = {
      requestId,
      approved,
      approvedBy,
      reason,
      resolvedAt: Date.now(),
    };

    // Approval/denial cache management with mutual invalidation.
    const cacheKey = `${entry.request.sessionKey}::${entry.request.action}`;

    if (approved) {
      // Populate approval cache (only for explicit user approvals, NOT for system:cached-approval)
      if (approvedBy !== "system:cached-approval") {
        const ttl = deps.getBatchApprovalTtlMs?.() ?? 30_000;
        if (ttl > 0) {
          approvalCache.set(cacheKey, { requestId, approved, approvedBy, reason, resolvedAt: Date.now() });
        }
      }
      // Mutual invalidation: approval clears stale denial for exact key
      denialCache.delete(cacheKey);
    } else {
      // Denial path: differentiate by approvedBy source
      if (approvedBy === "system:shutdown") {
        // Shutdown denials do NOT clear approval cache (locked decision: mechanical, not user intent)
        // Also do NOT populate denial cache (existing behavior preserved)
      } else if (approvedBy === "system:timeout") {
        // Timeout-denials DO clear approval cache (locked decision: stale cached approval)
        approvalCache.delete(cacheKey);
        // Timeout denials do NOT populate denial cache (existing behavior preserved)
      } else {
        // Explicit user denial (/deny command)
        // Populate denial cache (existing behavior)
        denialCache.set(cacheKey, { requestId, approved, approvedBy, reason, resolvedAt: Date.now() });
        // Mutual invalidation: denial clears stale approval for exact key (locked decision: denial always wins)
        approvalCache.delete(cacheKey);
      }
    }

    // Emit resolution event before unblocking the caller.
    deps.eventBus.emit("approval:resolved", {
      requestId,
      approved,
      approvedBy,
      reason,
      resolvedAt: resolution.resolvedAt,
    });

    // Unblock the waiting promise.
    entry.resolve(resolution);

    // Resolve all batch followers that joined this pending entry.
    const batchKey = `${entry.request.sessionKey}::${entry.request.action}`;
    const followers = batchFollowers.get(batchKey);
    if (followers) {
      for (const followerResolve of followers) {
        followerResolve(resolution);
      }
      batchFollowers.delete(batchKey);
    }

    // Remove from pending map.
    pendingMap.delete(requestId);
  }

  function requestApproval(
    req: Omit<ApprovalRequest, "requestId" | "createdAt" | "timeoutMs"> & { channelType?: string },
  ): Promise<ApprovalResolution> {
    const cacheKey = `${req.sessionKey}::${req.action}`;

    // Check approval cache BEFORE denial cache (locked decision: recent approval overrides older denial)
    const ttlMs = deps.getBatchApprovalTtlMs?.() ?? 30_000;
    if (ttlMs > 0) {
      const cachedApproval = approvalCache.get(cacheKey);
      if (cachedApproval) {
        // Log cache hit
        deps.logger?.debug({ cacheKey, action: req.action }, "Approval cache hit");
        // Return cached approval immediately with a new requestId
        const resolution: ApprovalResolution = {
          requestId: randomUUID(),
          approved: true,
          approvedBy: "system:cached-approval",
          reason: `Auto-approved: prior approval for ${req.action} still active`,
          resolvedAt: Date.now(),
        };
        deps.eventBus.emit("approval:resolved", { ...resolution });
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
        reason: `Auto-denied: prior denial for ${req.action} still active`,
        resolvedAt: Date.now(),
      };
      deps.eventBus.emit("approval:resolved", { ...resolution });
      return Promise.resolve(resolution);
    }

    // Batch parallel requests: if an identical request (same sessionKey::action)
    // is already pending, join it as a follower instead of creating a new entry.
    for (const entry of pendingMap.values()) {
      if (entry.request.sessionKey === req.sessionKey && entry.request.action === req.action) {
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
    const timeoutMs = deps.getTimeoutMs();
    const createdAt = Date.now();

    const request: ApprovalRequest = {
      requestId,
      toolName: req.toolName,
      action: req.action,
      params: { ...req.params },
      agentId: req.agentId,
      sessionKey: req.sessionKey,
      trustLevel: req.trustLevel,
      createdAt,
      timeoutMs,
    };

    const promise = new Promise<ApprovalResolution>((resolve) => {
      const timer = setTimeout(() => {
        resolveApproval(requestId, false, "system:timeout", "Approval request timed out");
      }, timeoutMs);

      // Prevent the timer from keeping the process alive during shutdown.
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      pendingMap.set(requestId, { request, resolve, timer });
    });

    // Emit request event with shallow-cloned params to prevent mutation.
    deps.eventBus.emit("approval:requested", {
      requestId,
      toolName: request.toolName,
      action: request.action,
      params: { ...request.params },
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      trustLevel: request.trustLevel,
      createdAt: request.createdAt,
      timeoutMs: request.timeoutMs,
      ...(req.channelType ? { channelType: req.channelType } : {}),
    });

    return promise;
  }

  function pending(): ApprovalRequest[] {
    return Array.from(pendingMap.values()).map((e) => e.request);
  }

  function getRequest(requestId: string): ApprovalRequest | undefined {
    return pendingMap.get(requestId)?.request;
  }

  function clearDenialCache(sessionKey?: string): void {
    if (sessionKey === undefined) {
      denialCache.clear();
    } else {
      const prefix = `${sessionKey}::`;
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
      const prefix = `${sessionKey}::`;
      for (const [key] of approvalCache.entries()) {
        if (key.startsWith(prefix)) {
          approvalCache.delete(key);
        }
      }
    }
  }

  function dispose(): void {
    for (const entry of pendingMap.values()) {
      clearTimeout(entry.timer);
      entry.resolve({
        requestId: entry.request.requestId,
        approved: false,
        approvedBy: "system:shutdown",
        reason: "Daemon shutting down",
        resolvedAt: Date.now(),
      });
    }
    pendingMap.clear();
    denialCache.clear();
    approvalCache.clear();
    batchFollowers.clear();
  }

  function serializePending(): SerializedApprovalRequest[] {
    return Array.from(pendingMap.values()).map((e) => ({
      requestId: e.request.requestId,
      toolName: e.request.toolName,
      action: e.request.action,
      params: { ...e.request.params },
      agentId: e.request.agentId,
      sessionKey: e.request.sessionKey,
      trustLevel: e.request.trustLevel,
      createdAt: e.request.createdAt,
      timeoutMs: e.request.timeoutMs,
    }));
  }

  function serializeApprovalCache(): SerializedApprovalCacheEntry[] {
    const approvalTtl = deps.getBatchApprovalTtlMs?.() ?? 30_000;
    const entries: SerializedApprovalCacheEntry[] = [];
    // entries() only yields live (non-expired) entries
    for (const [cacheKey, resolution] of approvalCache.entries()) {
      entries.push({
        cacheKey,
        resolution: { ...resolution },
        // Approximate: resolvedAt + TTL gives the original expiresAt
        expiresAt: resolution.resolvedAt + approvalTtl,
      });
    }
    return entries;
  }

  function restoreApprovalCache(entries: SerializedApprovalCacheEntry[]): number {
    const now = Date.now();
    let restored = 0;
    for (const entry of entries) {
      if (entry.expiresAt <= now) continue; // Skip expired
      approvalCache.set(entry.cacheKey, { ...entry.resolution });
      restored++;
    }
    return restored;
  }

  function restorePending(records: SerializedApprovalRequest[]): number {
    let restored = 0;
    const now = Date.now();
    for (const record of records) {
      const elapsed = now - record.createdAt;
      if (elapsed >= record.timeoutMs) continue; // Already expired, skip

      const remainingMs = record.timeoutMs - elapsed;
      const request: ApprovalRequest = {
        requestId: record.requestId,
        toolName: record.toolName,
        action: record.action,
        params: { ...record.params },
        agentId: record.agentId,
        sessionKey: record.sessionKey,
        trustLevel: record.trustLevel,
        createdAt: record.createdAt,
        timeoutMs: record.timeoutMs,
      };

      // Create a new pending entry with the ORIGINAL requestId.
      // The restored entry creates a fresh promise but the key behavior is that
      // resolveApproval(requestId, ...) works after restart.
      const timer = setTimeout(() => {
        resolveApproval(record.requestId, false, "system:timeout", "Approval request timed out");
      }, remainingMs);

      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      // Use a no-op resolve for the restored entry; the original caller's promise
      // is gone after restart. resolveApproval() will still emit events.
      pendingMap.set(record.requestId, { request, resolve: () => {}, timer });

      // Emit approval:requested so channel adapters can re-render the approval prompt
      deps.eventBus.emit("approval:requested", {
        requestId: request.requestId,
        toolName: request.toolName,
        action: request.action,
        params: { ...request.params },
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        trustLevel: request.trustLevel,
        createdAt: request.createdAt,
        timeoutMs: request.timeoutMs,
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
    clearDenialCache,
    clearApprovalCache,
    serializePending,
    restorePending,
    serializeApprovalCache,
    restoreApprovalCache,
    dispose,
  };
}
