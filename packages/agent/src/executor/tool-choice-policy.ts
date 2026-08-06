// SPDX-License-Identifier: Apache-2.0
/**
 * Resolves how a `toolChoice: "none"` execution is enforced for a given provider.
 *
 * There are two ways to run a turn that must not invoke tools:
 *
 *   - STRUCTURAL — ship no tools at all. Nothing can be called because nothing is
 *     offered. Works everywhere, but the tools block is the FIRST element of a
 *     provider's prompt-cache key (tools -> system -> messages), so emptying it on
 *     a turn that shares a conversation's prefix invalidates every cached message
 *     behind it, and again when the next ordinary turn restores the tools.
 *
 *   - DECLARED — ship the normal tools and let the provider refuse to call them.
 *     The prefix is unchanged, so the conversation stays cached, but the guarantee
 *     now rests on the provider honouring a request field.
 *
 * DECLARED is only selected where the provider is known to enforce it. Everything
 * else — including any provider added later — falls back to STRUCTURAL. A turn
 * marked `"none"` therefore loses the cache saving on an unknown provider, never
 * the containment.
 *
 * @module
 */

import { normalizeProviderId } from "../provider/capabilities.js";

/** How a no-tool-calls execution is enforced for the resolved provider. */
export type ToolChoiceEnforcement =
  /** Ship no tools; nothing is callable because nothing is offered. */
  | "structural"
  /** Ship the normal tools; the provider is told to call none of them. */
  | "declared";

/**
 * Providers whose request body carries a tool-choice field the API enforces.
 *
 * Direct Anthropic only, and deliberately NOT the family check — the same
 * distinction `supportsExtendedCacheTtl` already draws. `isAnthropicFamily` is
 * true for amazon-bedrock, which serves Anthropic MODELS over a different API
 * surface; pi-ai types a `toolChoice` there (and for google/mistral) but nothing
 * in this repository exercises those paths, and an unverified provider must not
 * silently downgrade a containment boundary to a field it might ignore.
 *
 * Adding one is a deliberate act: verify that provider actually refuses the call,
 * then list it here with a test. Until then it gets the structural guarantee.
 */
function providerEnforcesToolChoice(provider: string): boolean {
  return normalizeProviderId(provider) === "anthropic";
}

/**
 * Decide how to enforce a no-tool-calls turn.
 *
 * @param provider - Resolved provider id for this execution.
 * @returns `"declared"` when the provider enforces a tool-choice field, else `"structural"`.
 */
export function resolveToolChoiceEnforcement(provider: string | undefined): ToolChoiceEnforcement {
  return provider !== undefined && providerEnforcesToolChoice(provider) ? "declared" : "structural";
}
