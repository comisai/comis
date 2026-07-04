// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Autonomy MCP inbound-allowlist sub-block.
 *
 * The nested `z.strictObject` leaf that governs which connected-MCP-server
 * tools an autonomy-bearing agent may call from the jailed SDK. It is the
 * SECOND default-deny layer: the `orch:mcp` capability grant (the surface gate)
 * is layer one; even holding `orch:mcp`, a `{server,tool}` pair absent from
 * `allow` — or on a server without an explicit inbound classification — is
 * denied here.
 *
 * Follows the `durability`/`message` nested-block precedent: a `z.strictObject`
 * with every field `.default()`-ed and `strictObject` as the typo guard
 * (fails-closed). `enabled` defaults FALSE and `allow` defaults `{}`, so a
 * fully-omitted block resolves to a dark surface — no tool reachable.
 *
 * The 3-tier inbound classification MIRRORS THE SHAPE of the per-tool export
 * policy (`"safe" | "permission-gated" | absent ⇒ deny`) but is a SEPARATE
 * inbound field — the outbound export policy is NOT the inbound gate.
 *
 * `permitsMcpTool` is the PURE predicate the daemon-side executor calls per
 * invocation: it answers "is this `{server,tool}` listed AND classified
 * reachable?" — deny by absence at every step (unlisted server, unlisted tool,
 * or an absent classification all return false). Prototype-safe: an untrusted
 * server name never resolves an inherited object.
 *
 * Pure schema leaf — imports only `zod`. No `process.env` / `Date.now` /
 * `path.join`.
 *
 * @module
 */
import { z } from "zod";

/**
 * The inbound MCP allowlist posture. `enabled` is the surface gate (paired with
 * the `orch:mcp` capability grant); `allow` maps a connected server name to the
 * explicit set of tool names reachable on it plus a required inbound
 * classification. An absent classification is treated as unreachable (the
 * default-deny safety net) — it is NOT an accepted inbound tier.
 */
export const AutonomyMcpConfigSchema = z.strictObject({
  /**
   * Surface gate (default FALSE). Pairs with the `orch:mcp` capability grant: an
   * operator turns this on for an autonomy-bearing agent that must reach
   * connected MCP-server tools from the jailed SDK. Off ⇒ the cap is not granted
   * and the whole surface is dark.
   */
  enabled: z.boolean().default(false),
  /**
   * Per-server inbound allowlist. Keys are connected-server names; each value
   * lists the EXPLICIT tool names reachable on that server (no `"*"` wildcard —
   * an explicit list) plus the inbound classification tier. Default `{}` ⇒
   * nothing listed ⇒ everything denied (deny by absence).
   */
  allow: z
    .record(
      z.string(),
      z.strictObject({
        /** Explicit reachable tool names on this server (no wildcard). */
        tools: z.array(z.string()).default([]),
        /**
         * Inbound classification tier. `"safe"` ⇒ reachable; `"permission-gated"`
         * ⇒ reachable but the approval gate fires in the executor; ABSENT ⇒
         * unreachable (deny). Deliberately omits the outbound `"never-export"`
         * value — absent already means deny inbound.
         */
        classification: z.enum(["safe", "permission-gated"]).optional(),
      }),
    )
    .default({}),
});

/** The resolved inbound-MCP-allowlist posture. */
export type AutonomyMcpConfig = z.infer<typeof AutonomyMcpConfigSchema>;

/**
 * Pure inbound-allowlist predicate — the layer-two default-deny gate the
 * daemon-side MCP executor calls per invocation. Returns `true` ONLY when the
 * server is listed in `allow`, the tool is in that server's explicit `tools`
 * list, AND the server carries an inbound classification of `"safe"` or
 * `"permission-gated"`. Every other case — an unlisted server, an unlisted
 * tool, or an absent classification — returns `false` (deny by absence).
 *
 * A `"permission-gated"` server is PERMITTED here; the approval-gate firing is
 * the executor's concern — this predicate only answers "listed & classified".
 *
 * Iterates own entries (never indexes `allow` with the untrusted `server`), so
 * an adversarial `"__proto__"`/`"constructor"` name resolves nothing.
 *
 * PURE — a function of its arguments only (no env/clock/fs).
 */
export function permitsMcpTool(cfg: AutonomyMcpConfig, server: string, tool: string): boolean {
  const match = Object.entries(cfg.allow).find(([name]) => name === server);
  if (match === undefined) return false; // unlisted server ⇒ deny
  const [, entry] = match;
  if (!entry.tools.includes(tool)) return false; // tool not on the server's explicit list ⇒ deny
  // Absent classification ⇒ unreachable (the default-deny safety net).
  return entry.classification === "safe" || entry.classification === "permission-gated";
}
