// SPDX-License-Identifier: Apache-2.0
/**
 * Non-secret config projections for the web dashboard's REST listings.
 *
 * A security sign-off removed `agents` and `channels` from the getConfig
 * RPC's non-secret allowlist, so the dashboard can no longer source its agent and
 * channel listings from getConfig. These pure projections return ONLY the
 * non-secret identity fields the dashboard needs — never auth profiles, API
 * keys, bot tokens, webhook secrets, or any other credential-bearing field —
 * so GET /api/agents and GET /api/channels work without re-opening the
 * egress path getConfig closed.
 *
 * Extracted from setup-gateway-rpc.ts so that file stays within its
 * per-subdirectory line cap and the projections are independently testable.
 *
 * @module
 */

/** Non-secret per-agent summary surfaced by GET /api/agents. */
export interface AgentSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
}

/** Non-secret per-channel summary surfaced by GET /api/channels. */
export interface ChannelSummary {
  name: string;
  enabled: boolean;
}

/**
 * Channels-config keys that are internal monitoring config, NOT chat adapters,
 * and so must be excluded from the dashboard's channel listing.
 */
const NON_ADAPTER_CHANNEL_KEYS = new Set<string>(["healthCheck"]);

/**
 * Project the agents config to non-secret id/name/provider/model summaries.
 * Only those four scalars are read; every other field (auth/OAuth profiles,
 * secret allow-lists, API keys) is dropped.
 */
export function agentSummaries(
  agents:
    | Record<string, { name?: string; provider?: string; model?: string } | undefined>
    | undefined,
): AgentSummary[] {
  return Object.entries(agents ?? {}).map(([id, cfg]) => ({
    id,
    name: cfg?.name ?? "Comis",
    provider: cfg?.provider ?? "unknown",
    model: cfg?.model ?? "unknown",
  }));
}

/**
 * Project the channels config to non-secret name/enabled summaries. Drops the
 * internal healthCheck monitoring block and every adapter-specific credential
 * field (bot tokens, webhook secrets, ...).
 */
export function channelSummaries(
  channels: Record<string, { enabled?: boolean } | undefined> | undefined,
): ChannelSummary[] {
  return Object.entries(channels ?? {})
    .filter(([name]) => !NON_ADAPTER_CHANNEL_KEYS.has(name))
    .map(([name, cfg]) => ({ name, enabled: cfg?.enabled === true }));
}
