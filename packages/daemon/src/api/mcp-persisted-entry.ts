// SPDX-License-Identifier: Apache-2.0
/**
 * Build the persisted `McpServerEntry` for the `mcp.connect` RPC handler.
 *
 * Extracted from `mcp-handlers.ts` to keep that leaf under the 800-line
 * per-file cap AND — more importantly — to give a SINGLE SOURCE OF TRUTH for
 * "which per-server fields flow through to persistence". That exact concern
 * was missed twice in a row (an earlier change dropped the tool filters /
 * resources-prompts opt-outs from the runtime config; another dropped
 * them — plus supportsParallelToolCalls — from the PERSISTED entry, a security
 * regression). Co-locating the construction here makes the field set auditable
 * in one place.
 *
 * The split between the runtime `McpServerConfig` (built inline in the handler,
 * consumed by `manager.connect`) and this persisted `McpServerEntry` (written
 * back to config.yaml via `persistMcpServers`) is deliberate: the runtime
 * object carries spawn-time-only fields (safetyAllowedEnvKeys, osvCheckEnabled,
 * osvCacheTtlMs) that must NOT be persisted, while this entry carries only the
 * schema-validated `McpServerEntry` shape.
 *
 * **Reconnect invariant:** mcp.connect has NO RPC params for the config-only fields
 * (toolAllowlist, toolBlocklist, enableResources, enablePrompts,
 * supportsParallelToolCalls, idleTtlMs). Their only source on a reconnect /
 * re-add is the existing persisted entry — so they are conditionally spread
 * from `persistedEntry` here. Dropping toolAllowlist/toolBlocklist on persist
 * is a security regression: the operator-configured tool filter survives the
 * runtime session but is gone on the next daemon restart, surfacing ALL tools.
 *
 * @module
 */

import type { McpServerEntry } from "@comis/core";

/**
 * Inputs to {@link buildPersistedMcpEntry}. The resolved* values are the
 * handler's already-computed `params.X ?? persistedEntry?.X` results (current
 * intent wins over the prior persisted value); the config-only fields are read
 * directly from `persistedEntry` because the RPC has no params for them.
 */
// @optional-field-count: 14 optional fields covering the McpServerEntry persistence-projection surface. Each field maps 1:1 to a persisted McpServerEntrySchema field that the helper conditionally spreads when defined (so a no-param reconnect does not strip an operator-set value). Splitting this interface would create N parallel projection helpers — the rule-of-three test catches duplication; the optional-field cap exists to flag undermodeled types, NOT a well-bounded projection like this one. _bundleSource + _bundleArchive (the 13th and 14th) are direct projections of new McpServerEntrySchema optionals. Audit-stamped per the architecture allowlist policy.
export interface BuildPersistedMcpEntryInput {
  /** The validated `server_name` RPC param. */
  readonly serverName: string;
  /** Transport from the validated RPC params. */
  readonly transport: McpServerEntry["transport"];
  /** Optional transport params from the validated RPC request. */
  readonly command?: string;
  readonly args?: string[];
  readonly url?: string;
  /** Unresolved `${KEY}` env references (NOT the resolved spawn values). */
  readonly env?: Record<string, string>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Whether the caller opted this server out of the plaintext-secret scan. */
  readonly disablePlaintextSecretCheck: boolean;
  /** Resolved rlimits (caller param > persisted > undefined). */
  readonly resolvedRlimits?: McpServerEntry["rlimits"];
  /** Resolved reliability overrides (caller param > persisted). */
  readonly resolvedKeepaliveIntervalMs?: number;
  readonly resolvedCircuitBreakerThreshold?: number;
  readonly resolvedCircuitBreakerCooldownMs?: number;
  /**
   * Per-server auth scheme + OAuth hints. Config-only on the mcp.connect path
   * (no RPC params) — the caller resolves them as `params.X ?? persistedEntry?.X`
   * (current intent > persisted) and passes the result here. Conditionally spread
   * so a no-param reconnect does NOT strip a server's `auth:"oauth"` requirement
   * (prevents downgrade to no-auth).
   */
  readonly auth?: McpServerEntry["auth"];
  readonly oauth?: McpServerEntry["oauth"];
  /**
   * Skill-bundle provenance. Set by the bundle resolver when persisting a bundled
   * entry; absent on direct mcp.connect calls. INPUT-DRIVEN: a no-marker reconnect
   * from a manual mcp.connect intentionally clears the marker (operator has explicitly
   * overridden the bundle entry). Differs from the reconnect config-only fields below
   * which fall back to persistedEntry -- those would silently survive an override;
   * the bundle marker MUST be cleared so audits reflect operator intent.
   */
  readonly _bundleSource?: string;
  /**
   * Archived bundle entry when a user override (or --force from a second bundle)
   * replaced it. Forwarded verbatim from input to output. Recursive shape --
   * McpServerEntry self-reference resolved at parse time via z.lazy().
   */
  readonly _bundleArchive?: McpServerEntry;
  /**
   * The existing persisted entry for this server (if any). The reconnect
   * config-only fields are propagated from here so a reconnect / re-add does
   * not strip operator-set values.
   */
  readonly persistedEntry?: McpServerEntry;
}

/**
 * Construct the `McpServerEntry` written back to config.yaml by `mcp.connect`.
 *
 * Conditional-spread pattern (`...(x !== undefined && { x })`) matches the
 * runtime `McpServerConfig` construction in the handler, so a field absent on
 * input is absent on output (no spurious `undefined` keys in the persisted
 * YAML).
 */
export function buildPersistedMcpEntry(input: BuildPersistedMcpEntryInput): McpServerEntry {
  const { persistedEntry } = input;
  return {
    name: input.serverName,
    transport: input.transport,
    ...(input.command !== undefined && { command: input.command }),
    ...(input.args !== undefined && { args: input.args }),
    ...(input.url !== undefined && { url: input.url }),
    // Persist params.env (unresolved `${KEY}` references), NOT
    // the resolved values used for spawn.
    ...(input.env !== undefined && { env: input.env }),
    ...(input.headers !== undefined && { headers: input.headers }),
    // Persist rlimits so the resource-limit config survives restart and no-op
    // reconnects don't drop the field (resolvedRlimits keeps the prior value).
    ...(input.resolvedRlimits !== undefined && { rlimits: input.resolvedRlimits }),
    // Persist disablePlaintextSecretCheck so the per-server
    // opt-out survives a daemon restart.
    ...(input.disablePlaintextSecretCheck && { disablePlaintextSecretCheck: true as const }),
    // Persist reliability overrides (same posture as rlimits).
    ...(input.resolvedKeepaliveIntervalMs !== undefined && { keepaliveIntervalMs: input.resolvedKeepaliveIntervalMs }),
    ...(input.resolvedCircuitBreakerThreshold !== undefined && { circuitBreakerThreshold: input.resolvedCircuitBreakerThreshold }),
    ...(input.resolvedCircuitBreakerCooldownMs !== undefined && { circuitBreakerCooldownMs: input.resolvedCircuitBreakerCooldownMs }),
    // Persist auth/oauth so a reconnect cannot strip the server's OAuth
    // requirement. mcp.connect has no RPC params for them, so a no-param
    // reconnect arrives with input.auth/oauth undefined — fall back to the
    // persisted entry (the same source the tool-filter fields below read
    // directly). Current intent (a direct input value) still wins over the
    // persisted value.
    ...((input.auth ?? persistedEntry?.auth) !== undefined && { auth: input.auth ?? persistedEntry?.auth }),
    ...((input.oauth ?? persistedEntry?.oauth) !== undefined && { oauth: input.oauth ?? persistedEntry?.oauth }),
    // Preserve config-only fields from the prior persisted entry — mcp.connect
    // has no RPC params for them, so the existing persisted entry is the only
    // source. Dropping toolAllowlist / toolBlocklist here is a security
    // regression (filter lost on next restart).
    ...(persistedEntry?.toolAllowlist !== undefined && { toolAllowlist: persistedEntry.toolAllowlist }),
    ...(persistedEntry?.toolBlocklist !== undefined && { toolBlocklist: persistedEntry.toolBlocklist }),
    ...(persistedEntry?.enableResources !== undefined && { enableResources: persistedEntry.enableResources }),
    ...(persistedEntry?.enablePrompts !== undefined && { enablePrompts: persistedEntry.enablePrompts }),
    ...(persistedEntry?.supportsParallelToolCalls !== undefined && { supportsParallelToolCalls: persistedEntry.supportsParallelToolCalls }),
    // Bundle provenance + archive. INPUT-DRIVEN (NOT carried from persistedEntry)
    // -- a no-marker reconnect from a manual mcp.connect explicitly clears
    // _bundleSource so the audit reflects operator intent (the deliberate
    // semantic: a direct mcp.connect HAS overridden the bundle entry). Contrast
    // with the reconnect config-only fields above where the persistedEntry
    // fallback prevents accidental strip on a no-param reconnect.
    ...(input._bundleSource !== undefined && { _bundleSource: input._bundleSource }),
    ...(input._bundleArchive !== undefined && { _bundleArchive: input._bundleArchive }),
    // idleTtlMs has a schema default(0) ⇒ required on the inferred McpServerEntry.
    // mcp.connect has no idle param, so preserve the operator-configured positive
    // value (don't reset to 0); default to 0 (disabled) when the prior entry had
    // none / had 0.
    idleTtlMs: persistedEntry?.idleTtlMs !== undefined && persistedEntry.idleTtlMs > 0
      ? persistedEntry.idleTtlMs
      : 0,
    enabled: true,
  };
}
