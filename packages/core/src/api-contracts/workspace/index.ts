// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace contract aggregator.
 *
 * Re-aggregates 5 handler-family slices into WORKSPACE_CONTRACTS, preserving
 * the EXACT spread order required to keep API_CONTRACTS_ORDERED byte-
 * identical (contract-codegen-drift.test.ts).
 *
 * Family files (mirrors `packages/daemon/src/api/` factory file naming):
 *   - workspace-handlers.ts     (12 methods — workspace.*)
 *   - browser-handlers.ts       (13 methods — browser.*)
 *   - approval-handlers.ts      ( 4 methods — admin.approval.*)
 *   - skill-handlers.ts         ( 6 methods — skills.*)
 *   - notification-handlers.ts  ( 1 method  — notification.send)
 *
 * Total: 36 contracts. The bidirectional 1:1 architecture test treats the
 * spread order as documentation only (unordered set); the spread order here
 * matches the canonical source for codegen byte-stability.
 *
 * @module
 */
import { WORKSPACE_HANDLERS_CONTRACTS } from "./workspace-handlers.js";
import { BROWSER_HANDLERS_CONTRACTS } from "./browser-handlers.js";
import { APPROVAL_HANDLERS_CONTRACTS } from "./approval-handlers.js";
import { SKILL_HANDLERS_CONTRACTS } from "./skill-handlers.js";
import { NOTIFICATION_HANDLERS_CONTRACTS } from "./notification-handlers.js";

// Each contract must remain individually exported (per-domain *.test.ts files
// import them by name); use `export *` to preserve the entire surface.
export * from "./workspace-handlers.js";
export * from "./browser-handlers.js";
export * from "./approval-handlers.js";
export * from "./skill-handlers.js";
export * from "./notification-handlers.js";

export const WORKSPACE_CONTRACTS = [
  ...WORKSPACE_HANDLERS_CONTRACTS,
  ...BROWSER_HANDLERS_CONTRACTS,
  ...APPROVAL_HANDLERS_CONTRACTS,
  ...SKILL_HANDLERS_CONTRACTS,
  ...NOTIFICATION_HANDLERS_CONTRACTS,
] as const;
