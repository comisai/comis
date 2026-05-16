// SPDX-License-Identifier: Apache-2.0
/**
 * Shared dependencies + dev-mode flag for the observability handler bundles
 * (Phase 43 split per FILE-SPLIT-09).
 *
 * No closures, no factory: every export is a pure type alias or compile-time
 * flag so the dependency graph stays one-directional (metrics / diagnostics /
 * export → obs-helpers).
 *
 *   - ObsHandlerDeps type re-export (ObservabilityApiDeps from api/types.ts)
 *   - IS_DEV (NODE_ENV !== "production" dev-mode flag for D-10 response.parse)
 *
 * @module
 */

import { systemGetEnv } from "@comis/core";

// Re-aliased from the cluster slice in api/types.ts (Plan 34-08a; alias retarget
// in Plan 34-08c). Single source of truth: ObservabilityApiDeps. The cluster
// slice was widened in 34-08c to cover obs-handler fields (eventBus, agents,
// embeddingCacheStats, embeddingCircuitBreakerState, tokenTracker). DAEMON-API-03
// Option A retarget — handler body unchanged.
import type { ObservabilityApiDeps as ObsHandlerDeps } from "../types.js";
export type { ObsHandlerDeps };

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse. Mirrors the D-10 gate
 * pattern used in auth-handlers / secrets-handlers / config-handlers.
 */
export const IS_DEV = systemGetEnv("NODE_ENV") !== "production";
