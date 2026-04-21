// SPDX-License-Identifier: Apache-2.0
/**
 * Gemini CachedContent lifecycle manager.
 *
 * Creates, reuses, refreshes, and disposes CachedContent resources via the
 * @google/genai SDK. Uses SHA-256 content hashing for invalidation and
 * concurrent dedup via pending Promise tracking.
 *
 * .
 *
 * @module
 */

import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { ok, err, fromPromise } from "@comis/shared";
import type { Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum cacheable tokens per Gemini model family. */
export const GEMINI_MIN_CACHEABLE_TOKENS: Record<string, number> = {
  "gemini-3-flash": 1024,
  "gemini-3-pro": 4096,
  "gemini-2.5-flash": 1024,
  "gemini-2.5-pro": 4096,
  "gemini-2.0-flash": 2048,
};

export const GEMINI_DEFAULT_MIN_CACHEABLE_TOKENS = 2048;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry {
  name: string;
  contentHash: string;
  model: string;
  agentId: string;
  sessionKey: string;
  expiresAt: number;
  createdAt: number;
  cachedTokens: number;
}

export interface CacheRequest {
  sessionKey: string;
  agentId: string;
  model: string;
  provider: string;
  systemInstruction: unknown;
  tools: unknown[];
  toolConfig: unknown;
  contentHash: string;
  estimatedTokens: number;
}

export interface GeminiCacheManagerConfig {
  getApiKey: () => string | undefined;
  ttlSeconds: number;
  maxActiveCachesPerAgent: number;
  refreshThreshold: number;
  logger: {
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface GeminiCacheManager {
  getOrCreate(params: CacheRequest): Promise<Result<CacheEntry | undefined, Error>>;
  dispose(sessionKey: string): Promise<void>;
  disposeAll(): Promise<void>;
  refresh(sessionKey: string): Promise<Result<void, Error>>;
  getActiveCount(agentId: string): number;
  /** Delete all orphaned comis:* caches from previous daemon runs. */
  cleanupOrphaned(): Promise<Result<{ deleted: number; skipped: number }, Error>>;
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 hex digest from system instruction, tools,
 * and tool config. Used as the cache invalidation key.
 */
export function computeCacheContentHash(
  systemInstruction: unknown,
  tools: unknown[],
  toolConfig: unknown,
): string {
  const data = JSON.stringify({ systemInstruction, tools, toolConfig });
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve minimum cacheable tokens for a model. Matches model ID substrings
 * against GEMINI_MIN_CACHEABLE_TOKENS entries, falls back to default.
 */
function getMinTokens(model: string): number {
  for (const [prefix, min] of Object.entries(GEMINI_MIN_CACHEABLE_TOKENS)) {
    if (model.includes(prefix)) return min;
  }
  return GEMINI_DEFAULT_MIN_CACHEABLE_TOKENS;
}

/**
 * Build displayName for CachedContent resource.
 * Format: comis:{agentId}:{sessionKey}:{hashPrefix}
 * Truncated to 128 chars max (Gemini API limit).
 */
function buildDisplayName(agentId: string, sessionKey: string, contentHash: string): string {
  const hashPrefix = contentHash.slice(0, 8);
  const name = `comis:${agentId}:${sessionKey}:${hashPrefix}`;
  return name.slice(0, 128);
}

/**
 * Parse RFC 3339 expireTime string to epoch ms. Falls back to now + 1h.
 */
function parseExpireTime(expireTime: string | undefined): number {
  if (!expireTime) return Date.now() + 3_600_000;
  return new Date(expireTime).getTime();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Gemini CachedContent lifecycle manager.
 *
 * Uses closure-scoped state (not module-level Maps) following the
 * createCircuitBreaker / createBudgetGuard pattern.
 *
 * @param config - Manager configuration (API key getter, TTL, limits, logger)
 * @returns GeminiCacheManager interface
 */
export function createGeminiCacheManager(config: GeminiCacheManagerConfig): GeminiCacheManager {
  // Closure state -- NOT module-level Maps
  const activeCaches = new Map<string, CacheEntry>();
  const pendingCreations = new Map<string, Promise<CacheEntry | undefined>>();
  let client: InstanceType<typeof GoogleGenAI> | null = null;

  /**
   * Lazily create GoogleGenAI client. Returns null if no API key available.
   */
  function getClient(): InstanceType<typeof GoogleGenAI> | null {
    if (client) return client;
    const apiKey = config.getApiKey();
    if (!apiKey) return null;
    client = new GoogleGenAI({ apiKey });
    return client;
  }

  /**
   * Create a new CachedContent via the SDK. Does NOT check activeCaches --
   * that's the caller's responsibility. Returns undefined if below token
   * threshold or no API key.
   */
  async function createCacheEntry(params: CacheRequest): Promise<CacheEntry | undefined> {
    const ai = getClient();
    if (!ai) return undefined;

    const displayName = buildDisplayName(params.agentId, params.sessionKey, params.contentHash);
    const ttl = `${config.ttlSeconds}s`;

    const result = await ai.caches.create({
      model: params.model,
      config: {
        systemInstruction: params.systemInstruction as string,
        tools: params.tools as Array<Record<string, unknown>>,
        toolConfig: params.toolConfig as Record<string, unknown>,
        displayName,
        ttl,
      },
    });

    const entry: CacheEntry = {
      name: result.name ?? "",
      contentHash: params.contentHash,
      model: params.model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      expiresAt: parseExpireTime(result.expireTime),
      createdAt: Date.now(),
      cachedTokens: result.usageMetadata?.totalTokenCount ?? 0,
    };

    activeCaches.set(params.sessionKey, entry);
    return entry;
  }

  /**
   * Count active caches for a specific agent.
   */
  function countForAgent(agentId: string): number {
    let count = 0;
    for (const entry of activeCaches.values()) {
      if (entry.agentId === agentId) count++;
    }
    return count;
  }

  /**
   * Find the oldest (by createdAt) cache entry for a given agent.
   * Used for LRU eviction when per-agent limit is reached.
   */
  function findOldestForAgent(agentId: string): CacheEntry | undefined {
    let oldest: CacheEntry | undefined;
    for (const entry of activeCaches.values()) {
      if (entry.agentId === agentId) {
        if (!oldest || entry.createdAt < oldest.createdAt) {
          oldest = entry;
        }
      }
    }
    return oldest;
  }

  return {
    async getOrCreate(params: CacheRequest): Promise<Result<CacheEntry | undefined, Error>> {
      try {
        // Check API key first
        if (!config.getApiKey()) return ok(undefined);

        // minimum token check (before any map lookups to avoid unnecessary work)
        const minTokens = getMinTokens(params.model);
        if (params.estimatedTokens < minTokens) {
          config.logger.debug(
            { model: params.model, estimatedTokens: params.estimatedTokens, minTokens },
            "Gemini cache: below minimum token threshold, skipping",
          );
          return ok(undefined);
        }

        // Check existing valid cache (hash match)
        const existing = activeCaches.get(params.sessionKey);
        if (existing && existing.contentHash === params.contentHash) {
          config.logger.debug(
            { sessionKey: params.sessionKey, name: existing.name },
            "Gemini cache: reusing existing entry",
          );

          // Refresh TTL on cache hit when elapsed > refreshThreshold * TTL
          const ttlMs = existing.expiresAt - existing.createdAt;
          const elapsed = Date.now() - existing.createdAt;
          if (elapsed > config.refreshThreshold * ttlMs) {
            const ai = getClient();
            if (ai) {
              const refreshResult = await fromPromise(
                ai.caches.update({ name: existing.name, config: { ttl: `${config.ttlSeconds}s` } }),
              );
              if (refreshResult.ok) {
                existing.expiresAt = parseExpireTime(refreshResult.value.expireTime);
              } else {
                config.logger.warn(
                  {
                    sessionKey: params.sessionKey,
                    name: existing.name,
                    err: refreshResult.error,
                    hint: "Cache entry still usable, refresh will retry on next call",
                    errorKind: "network" as const,
                  },
                  "Gemini cache: TTL refresh failed on cache hit",
                );
              }
            }
          }

          return ok(existing);
        }

        // Hash mismatch -- dispose old entry
        if (existing && existing.contentHash !== params.contentHash) {
          config.logger.debug(
            { sessionKey: params.sessionKey, oldHash: existing.contentHash, newHash: params.contentHash },
            "Gemini cache: content changed, replacing entry",
          );
          const ai = getClient();
          if (ai && existing.name) {
            await fromPromise(ai.caches.delete({ name: existing.name }));
          }
          activeCaches.delete(params.sessionKey);
        }

        // Per-agent cache limit enforcement
        const agentCount = countForAgent(params.agentId);
        if (agentCount >= config.maxActiveCachesPerAgent) {
          const oldest = findOldestForAgent(params.agentId);
          if (oldest) {
            config.logger.debug(
              { agentId: params.agentId, evicted: oldest.sessionKey, count: agentCount },
              "Gemini cache: evicting oldest entry (per-agent limit reached)",
            );
            const ai = getClient();
            if (ai && oldest.name) {
              await fromPromise(ai.caches.delete({ name: oldest.name }));
            }
            activeCaches.delete(oldest.sessionKey);
          }
        }

        // Check pending creation (concurrent dedup)
        const pending = pendingCreations.get(params.sessionKey);
        if (pending) {
          const entry = await pending;
          return ok(entry);
        }

        // Create new cache entry
        const promise = createCacheEntry(params);
        pendingCreations.set(params.sessionKey, promise);
        try {
          const entry = await promise;
          return ok(entry);
        } catch (error) {
          return err(error instanceof Error ? error : new Error(String(error)));
        } finally {
          pendingCreations.delete(params.sessionKey);
        }
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async dispose(sessionKey: string): Promise<void> {
      const entry = activeCaches.get(sessionKey);
      if (!entry) return;
      activeCaches.delete(sessionKey);
      const ai = getClient();
      if (ai && entry.name) {
        const result = await fromPromise(ai.caches.delete({ name: entry.name }));
        if (!result.ok) {
          config.logger.warn(
            { sessionKey, name: entry.name, err: result.error, hint: "Cache entry may persist until API-side TTL expires", errorKind: "network" },
            "Gemini cache: failed to delete cache entry",
          );
        }
      }
    },

    async disposeAll(): Promise<void> {
      const entries = [...activeCaches.values()];
      activeCaches.clear();
      const ai = getClient();
      if (!ai) return;
      await Promise.allSettled(
        entries.map((entry) =>
          entry.name ? fromPromise(ai.caches.delete({ name: entry.name })) : Promise.resolve(),
        ),
      );
    },

    async refresh(sessionKey: string): Promise<Result<void, Error>> {
      const entry = activeCaches.get(sessionKey);
      if (!entry) return ok(undefined);
      const ai = getClient();
      if (!ai) return ok(undefined);

      const ttlMs = entry.expiresAt - entry.createdAt;
      const elapsed = Date.now() - entry.createdAt;
      if (elapsed <= ttlMs * config.refreshThreshold) return ok(undefined);

      const ttl = `${config.ttlSeconds}s`;
      const result = await fromPromise(
        ai.caches.update({ name: entry.name, config: { ttl } }),
      );
      if (!result.ok) {
        return err(result.error);
      }
      entry.expiresAt = parseExpireTime(result.value.expireTime);
      return ok(undefined);
    },

    getActiveCount(agentId: string): number {
      return countForAgent(agentId);
    },

    async cleanupOrphaned(): Promise<Result<{ deleted: number; skipped: number }, Error>> {
      try {
        const ai = getClient();
        if (!ai) return ok({ deleted: 0, skipped: 0 });

        let deleted = 0;
        let skipped = 0;

        const pager = await ai.caches.list({ config: { pageSize: 100 } });
        for await (const cache of pager) {
          // Skip entries that are not comis-owned
          if (!cache.displayName?.startsWith("comis:")) {
            skipped++;
            continue;
          }

          // Skip entries with no name (cannot delete without resource name)
          if (!cache.name) {
            skipped++;
            continue;
          }

          const result = await fromPromise(ai.caches.delete({ name: cache.name }));
          if (result.ok) {
            deleted++;
          } else {
            config.logger.warn(
              { name: cache.name, displayName: cache.displayName, err: result.error, hint: "Orphaned cache will expire via API-side TTL", errorKind: "network" },
              "Gemini cache: failed to delete orphaned cache entry",
            );
            skipped++;
          }
        }

        return ok({ deleted, skipped });
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
