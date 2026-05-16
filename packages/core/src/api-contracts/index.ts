// SPDX-License-Identifier: Apache-2.0
/**
 * `@comis/core/api-contracts` aggregator (barrel-only public surface per
 * CONTEXT D-05). External consumers always import from `"@comis/core"`.
 *
 * Phase 35 history:
 *   - Wave A (35-01..35-05): scaffolded the empty registry + 12-shape
 *     allowlist + INTERNAL_FIELD_NAMES + architecture tests.
 *   - Wave C (35-06..35-19): per-domain plans added each domain
 *     additively (one contract file per logical domain mirroring Phase
 *     34's `*ApiDeps` cluster slices). Plan 35-19 (Wave C closure)
 *     performs the BLOCKER 6 atomic edit of THIS file with all 14
 *     domain aggregator imports alphabetically sorted — replacing the
 *     cumulative additive list with a single deterministic registry.
 *     This prevents parallel-plan write conflicts AND makes git diffs
 *     for future contract authors deterministic (alphabetical position
 *     of the domain).
 *
 * Domain order: agents → auth → channels → config → daemon → mcp →
 * media → memory → observability → orchestrator → secrets → sessions →
 * tokens → workspace. Note: `mcp` < `media` alphabetically (verified).
 *
 * BLOCKER 9 (Wave C closure): the bidirectional 1:1 test in
 * `test/architecture/api-contracts-bidirectional.test.ts` is the
 * AUTHORITATIVE COUNT — it walks every handler factory file and
 * asserts equality with `API_CONTRACTS.size`. No magic-number floor.
 *
 * @module
 */
import type { ZodTypeAny } from "zod";
import type { ApiContract } from "./types.js";

// 14 domain imports — alphabetical order for deterministic git diffs
// (BLOCKER 6 fix; Wave C closure).
import { AGENTS_CONTRACTS } from "./agents.js";
import { AUTH_CONTRACTS } from "./auth.js";
import { CHANNELS_CONTRACTS } from "./channels.js";
import { CONFIG_CONTRACTS } from "./config.js";
import { DAEMON_CONTRACTS } from "./daemon.js";
import { MCP_CONTRACTS } from "./mcp.js";
import { MEDIA_CONTRACTS } from "./media.js";
import { MEMORY_CONTRACTS } from "./memory.js";
import { OBSERVABILITY_CONTRACTS } from "./observability.js";
import { ORCHESTRATOR_CONTRACTS } from "./orchestrator.js";
import { SECRETS_CONTRACTS } from "./secrets.js";
import { SESSIONS_CONTRACTS } from "./sessions.js";
import { TOKENS_CONTRACTS } from "./tokens.js";
import { WORKSPACE_CONTRACTS } from "./workspace/index.js";

/**
 * Ordered array — codegen-deterministic iteration. Alphabetical by domain
 * (BLOCKER 6 fix). The bidirectional 1:1 architecture test treats this as
 * an unordered set; Plan 35-20's collapse loop iterates it to derive
 * registerMethod calls.
 */
export const API_CONTRACTS_ORDERED: readonly ApiContract<ZodTypeAny, ZodTypeAny>[] = [
  ...AGENTS_CONTRACTS,
  ...AUTH_CONTRACTS,
  ...CHANNELS_CONTRACTS,
  ...CONFIG_CONTRACTS,
  ...DAEMON_CONTRACTS,
  ...MCP_CONTRACTS,
  ...MEDIA_CONTRACTS,
  ...MEMORY_CONTRACTS,
  ...OBSERVABILITY_CONTRACTS,
  ...ORCHESTRATOR_CONTRACTS,
  ...SECRETS_CONTRACTS,
  ...SESSIONS_CONTRACTS,
  ...TOKENS_CONTRACTS,
  ...WORKSPACE_CONTRACTS,
];

/** O(1) lookup map keyed by method name. */
export const API_CONTRACTS: ReadonlyMap<string, ApiContract<ZodTypeAny, ZodTypeAny>> =
  new Map(API_CONTRACTS_ORDERED.map((c) => [c.method, c] as const));

// Type + helper re-exports (barrel-only — D-05).
export type { ApiContract, Scope, MethodName } from "./types.js";
export { defineContract } from "./types.js";
export { INTERNAL_FIELD_NAMES, stripInternalFields } from "./internals.js";

// Per-domain barrel re-exports (alphabetical, matching imports above).
export * from "./agents.js";
export * from "./auth.js";
export * from "./channels.js";
export * from "./config.js";
export * from "./daemon.js";
export * from "./mcp.js";
export * from "./media.js";
export * from "./memory.js";
export * from "./observability.js";
export * from "./orchestrator.js";
export * from "./secrets.js";
export * from "./sessions.js";
export * from "./tokens.js";
export * from "./workspace/index.js";
