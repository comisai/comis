// SPDX-License-Identifier: Apache-2.0
/**
 * Applies a no-tool-calls constraint to the outgoing request body.
 *
 * A turn that must not invoke tools can be run two ways: ship no tools at all, or
 * ship the normal ones and have the provider refuse to call them. The first is
 * expensive on a turn that shares a conversation's cached prefix — the tools block
 * is the FIRST element of the cache key (tools -> system -> messages), so emptying
 * it invalidates every cached message behind it, and again when the next ordinary
 * turn restores them. The second leaves the prefix untouched.
 *
 * Which one applies is decided upstream, per provider, by
 * `executor/tool-choice-policy.ts`; this module only writes the field.
 *
 * @module
 */

/**
 * Set the provider's no-tool-calls field when this turn ships callable tools.
 *
 * No-op when the turn is not constrained, or when it ships no tools — with none
 * present the constraint is already structurally satisfied and the field is noise.
 *
 * @param body - The outgoing request body, mutated in place.
 * @param tools - The tools the body will carry.
 * @param toolChoice - `"none"` when the provider must refuse tool calls.
 */
export function applyToolChoice(
  body: Record<string, unknown>,
  tools: unknown,
  toolChoice: "none" | undefined,
): void {
  if (toolChoice !== "none") return;
  if (!Array.isArray(tools) || tools.length === 0) return;
  body.tool_choice = { type: "none" };
}
