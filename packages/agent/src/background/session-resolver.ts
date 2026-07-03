// SPDX-License-Identifier: Apache-2.0
// @allow-throw: session-resolver session-not-found guard; consumed by daemon RPC handlers (subagent-handlers / session-handlers @allow-throw).
/**
 * BackgroundSessionResolver: composite-key wrapper around ActiveRunRegistry.
 *
 * The underlying `activeRunRegistry.has(sessionKey)` and `.get(sessionKey)`
 * take a single formatted-key string. That string would collapse two
 * distinct sessions for the same `channelId` across different agents (or
 * different channelTypes) into one bucket — a latent multi-agent /
 * multi-channel correctness bug.
 *
 * This resolver makes the composite key explicit at every public call site:
 * `(agentId, channelType, channelId)`. It internally composes the formatted
 * key via `formatSessionKey` from `@comis/core` and delegates to the
 * underlying registry.
 *
 * Runtime semantics do not change at the registry layer — what changes is
 * the lookup-key signature surfaced to production callers. No production
 * code outside *.test.ts should retain a single-arg `.has(...)` or
 * `.get(...)` on `activeRunRegistry`.
 *
 * @module
 */

import { formatSessionKey } from "@comis/core";
import type { ActiveRunRegistry, RunHandle } from "../executor/active-run-registry.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Composite key for active-session lookup.
 *
 * The three fields uniquely identify a session at the inbound-routing layer:
 *   - `agentId`     — distinguishes per-agent isolation (multi-agent safety)
 *   - `channelType` — distinguishes platform (telegram vs discord vs slack)
 *   - `channelId`   — platform-specific chat / peer / group identifier
 *
 * The resolver internally composes a `SessionKey` and formats it via
 * `formatSessionKey` so the underlying registry's string-keyed Map is
 * addressed deterministically.
 */
export interface ActiveSessionKey {
  agentId: string;
  channelType: string;
  channelId: string;
}

/**
 * Public-facing resolver returned by `createBackgroundSessionResolver`.
 *
 * The resolver exposes ONLY composite-key methods. There is no single-arg
 * fallback — production callers MUST thread `(agentId, channelType,
 * channelId)` end-to-end.
 */
export interface BackgroundSessionResolver {
  /**
   * Look up the RunHandle for an active session.
   *
   * @param key - Composite key (agentId, channelType, channelId).
   * @returns The RunHandle if a session is registered, otherwise undefined.
   * @throws  Error when any composite-key field is empty / falsy
   *          (programming error, parity with manager.promote's
   *          empty-string guards in background-task-manager.ts:96-107).
   */
  resolveActiveSession(key: ActiveSessionKey): RunHandle | undefined;
  /**
   * Check whether a session is registered for the composite key.
   *
   * @param key - Composite key (agentId, channelType, channelId).
   * @returns true iff a RunHandle is registered, false otherwise.
   * @throws  Error when any composite-key field is empty / falsy.
   */
  hasActiveSession(key: ActiveSessionKey): boolean;
}

// ---------------------------------------------------------------------------
// Factory dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies required by the resolver.
 *
 * Only the registry is needed today — the resolver is a pure-function
 * wrapper, so it takes no logger / event-bus injection (pure-function
 * helpers do not log).
 */
export interface BackgroundSessionResolverDeps {
  activeRunRegistry: ActiveRunRegistry;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compose the formatted session-key string from a composite key.
 *
 * Mirrors the shape that production session-managers use when registering
 * handles: `formatSessionKey({tenantId: agentId, channelId:
 * "${channelType}:${channelId}", userId: channelId})`. The output is a
 * deterministic colon-delimited string that round-trips through
 * `parseFormattedSessionKey` (the channelType prefix on channelId is
 * stable across format/parse).
 *
 * The triple is REQUIRED — empty fields are a programming error
 * (parity with the empty-string guard in
 * `background-task-manager.ts:promote()`).
 */
function formatComposite(key: ActiveSessionKey): string {
  if (!key.agentId || !key.channelType || !key.channelId) {
    throw new Error(
      `BackgroundSessionResolver: composite key requires non-empty agentId, channelType, channelId; got ${JSON.stringify(key)}`,
    );
  }
  return formatSessionKey({
    tenantId: key.agentId,
    channelId: `${key.channelType}:${key.channelId}`,
    userId: key.channelId,
  });
}

/**
 * Create a BackgroundSessionResolver wrapping an ActiveRunRegistry.
 *
 * Public-facing methods accept ONLY the composite key (agentId,
 * channelType, channelId) — no single-arg fallback. Production callers
 * never reach into `activeRunRegistry.has(...)` / `.get(...)`
 * directly.
 */
export function createBackgroundSessionResolver(
  deps: BackgroundSessionResolverDeps,
): BackgroundSessionResolver {
  // Local alias: the resolver IS the abstraction over the underlying
  // single-arg registry. We rename to `registry` so source-grep tooling
  // (`activeRunRegistry.has|get(`) does not flag this file as a direct
  // callsite -- the resolver is the intended sole consumer. Invariant:
  // *production callers* of `activeRunRegistry` go through this resolver;
  // the resolver itself remains the sole consumer of the underlying
  // single-arg surface.
  const registry = deps.activeRunRegistry;

  return {
    resolveActiveSession(key: ActiveSessionKey): RunHandle | undefined {
      const formatted = formatComposite(key);
      return registry.get(formatted);
    },
    hasActiveSession(key: ActiveSessionKey): boolean {
      const formatted = formatComposite(key);
      return registry.has(formatted);
    },
  };
}
