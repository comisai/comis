// SPDX-License-Identifier: Apache-2.0
/**
 * ContextStorePort: the full surface consumed by the daemon context-handlers
 * (engine + admin halves combined).
 *
 * Phase 60-02 (REFACTOR-04) split the original 38-method interface into two
 * narrower ports and redefined this name as an intersection type alias:
 *   - ContextEngineStore (34 methods) — per-session read/write
 *   - ContextAdminStore  (4 methods)  — admin/cleanup
 *
 * Agent consumers should import the narrower `ContextEngineStore` directly.
 * The daemon legitimately consumes both halves; the alias preserves the
 * existing public name for the ~14 import sites that resolve through it.
 *
 * Memory's `createContextStore` factory returns `ContextStorePort` (= the
 * intersection). The frozen object the factory returns structurally
 * satisfies both interfaces — zero adapter changes required (RESEARCH §B.4
 * Option A).
 *
 * Historical note: memory pkg previously declared its own `ContextStore`
 * type (interface, then alias). The terminal state — no `ContextStore`
 * declaration in memory pkg; the Port from @comis/core is the single
 * source of truth — predates this split and is preserved.
 *
 * @module
 */

import type { ContextEngineStore } from "./context-engine-store.js";
import type { ContextAdminStore } from "./context-admin-store.js";

export type ContextStorePort = ContextEngineStore & ContextAdminStore;
