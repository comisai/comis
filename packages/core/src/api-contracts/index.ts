// SPDX-License-Identifier: Apache-2.0
/**
 * `@comis/core/api-contracts` aggregator (barrel-only public surface).
 * External consumers always import from `"@comis/core"`.
 *
 * One contract file per logical domain; this file aggregates the 16
 * domain registries into a single deterministic registry. Imports are
 * alphabetically sorted so future contract authors get deterministic
 * git diffs (alphabetical position of the domain).
 *
 * Domain order: agents → auth → capabilities → channels → config → daemon →
 * mcp → mcp-oauth → media → memory → observability → orchestrator → secrets →
 * sessions → tokens → workspace. Note: `mcp` < `mcp-oauth` < `media`
 * alphabetically.
 *
 * The bidirectional 1:1 test in
 * `test/architecture/api-contracts-bidirectional.test.ts` is the
 * authoritative count — it walks every handler factory file and
 * asserts equality with `API_CONTRACTS.size`. No magic-number floor.
 *
 * @module
 */
import type { ZodTypeAny } from "zod";
import type { ApiContract } from "./types.js";

// 16 domain imports — alphabetical order for deterministic git diffs.
import { AGENTS_CONTRACTS } from "./agents.js";
import { AUTH_CONTRACTS } from "./auth.js";
import { CAPABILITIES_CONTRACTS } from "./capabilities.js";
import { CHANNELS_CONTRACTS } from "./channels.js";
import { CONFIG_CONTRACTS } from "./config.js";
import { CONTEXT_CONTRACTS } from "./context.js";
import { DAEMON_CONTRACTS } from "./daemon.js";
import { MCP_CONTRACTS } from "./mcp.js";
import { MCP_OAUTH_CONTRACTS } from "./mcp-oauth.js";
import { MEDIA_CONTRACTS } from "./media.js";
import { MEMORY_CONTRACTS } from "./memory.js";
import { OBSERVABILITY_CONTRACTS } from "./observability.js";
import { ORCHESTRATOR_CONTRACTS } from "./orchestrator/index.js";
import { SECRETS_CONTRACTS } from "./secrets.js";
import { SESSIONS_CONTRACTS } from "./sessions.js";
import { TOKENS_CONTRACTS } from "./tokens.js";
import { WORKSPACE_CONTRACTS } from "./workspace/index.js";

/**
 * Ordered array — codegen-deterministic iteration. Alphabetical by domain.
 * The bidirectional 1:1 architecture test treats this as an unordered
 * set; the collapse loop iterates it to derive registerMethod calls.
 */
export const API_CONTRACTS_ORDERED: readonly ApiContract<ZodTypeAny, ZodTypeAny>[] = [
  ...AGENTS_CONTRACTS,
  ...AUTH_CONTRACTS,
  ...CAPABILITIES_CONTRACTS,
  ...CHANNELS_CONTRACTS,
  ...CONFIG_CONTRACTS,
  ...CONTEXT_CONTRACTS,
  ...DAEMON_CONTRACTS,
  ...MCP_CONTRACTS,
  ...MCP_OAUTH_CONTRACTS,
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

// Type + helper re-exports (barrel-only).
export type { ApiContract, Scope, MethodName } from "./types.js";
export { defineContract } from "./types.js";
export { INTERNAL_FIELD_NAMES, stripInternalFields } from "./internals.js";

// Per-domain barrel re-exports (alphabetical, matching imports above).
export * from "./agents.js";
export * from "./auth.js";
export * from "./capabilities.js";
export * from "./channels.js";
export * from "./config.js";
export * from "./context.js";
export * from "./daemon.js";
export * from "./mcp.js";
export * from "./mcp-oauth.js";
export * from "./media.js";
export * from "./memory.js";
export * from "./observability.js";
export * from "./orchestrator/index.js";
export * from "./secrets.js";
export * from "./sessions.js";
export * from "./tokens.js";
export * from "./workspace/index.js";
