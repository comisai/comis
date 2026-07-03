// SPDX-License-Identifier: Apache-2.0
/**
 * Agent orchestration-capability primitive.
 *
 * The single authority predicate for the in-process agent loop — an
 * orthogonal axis to the gateway's `Scope` (`api-contracts/types.ts:19`). The
 * agent's tool calls reach `createRpcDispatch` directly and NEVER pass through
 * `checkScope` (the in-process bypass), so this gate lives at the handler
 * boundary that reads `_capabilities`, not at the gateway scope check.
 *
 * Two deliberate divergences from `checkScope`
 * (`packages/gateway/src/auth/token-auth.ts:105`):
 *   1. NO wildcard branch. `checkScope` has a `*`-implies-all rule;
 *      `checkCapability` is a plain membership test. With no lattice and no
 *      catch-all, least-privilege holds by construction — no member can imply
 *      `admin`/`rpc`/all. Copying `checkScope` verbatim would FAIL the
 *      `capability-scope-disjoint.test.ts` arch-test.
 *   2. The union is DISJOINT from `Scope` — capabilities are
 *      `orch:*`, scopes are `rpc|admin|mcp-client`; the arch-test asserts the
 *      intersection is empty.
 *
 * Defined in @comis/core so both @comis/daemon (handlers) and @comis/agent
 * (tool-assembly classification) can import it without a package cycle — the
 * same rationale `sub-agent-tool-denylist.ts` lives here.
 *
 * NAMING: the type is `AgentCapability`, NOT `Capability` — `CapabilityId`
 * (`config/capability-activation.ts`), `ChannelCapability`
 * (`domain/channel-capability.ts`) and `CapabilitySourceRef`
 * (`ports/tool-capability.ts`) already exist.
 *
 * @allow-throw: `requireCapability` is the handler-boundary gate; it throws
 * `CapabilityDeniedError`, which `rpc-dispatch.ts` converts to a JSON-RPC error
 * response (mirrors `RequiredToolsUnreachableError`). The pure predicate
 * `checkCapability` returns a boolean and never throws.
 *
 * @module
 */

/**
 * Closed orchestration-capability union. Each member gates one
 * orchestration surface. `orch:browse` is part of the UNION but is OFF in every
 * default profile (the profile defaults live elsewhere — the union must still
 * contain it so the type is total).
 *
 * Closed string-literal tuple (AGENTS §2.8): `AGENT_CAPABILITIES` is the single
 * source of truth; `AgentCapability` is inferred from it so the runtime list and
 * the static type can never drift.
 */
export const AGENT_CAPABILITIES = [
  "orch:spawn",
  "orch:graph",
  "orch:cron",
  "orch:message",
  "orch:skill",
  "orch:read",
  "orch:web",
  "orch:analyze",
  "orch:write",
  "orch:browse",
] as const;

/** The closed orchestration-capability union (inferred from {@link AGENT_CAPABILITIES}). */
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * Pure capability predicate — a plain membership test with NO wildcard branch.
 *
 * CRITICAL: unlike `checkScope`'s asterisk-implies-all rule, there is
 * no lattice and no catch-all here. A held set is exactly the caps it lists; no
 * entry (an asterisk string included) confers any other cap. That is what makes
 * least-privilege hold by construction.
 */
export function checkCapability(
  held: readonly string[],
  required: AgentCapability,
): boolean {
  return held.includes(required);
}

/**
 * Mint attenuation — the single trust boundary against capability broadening
 * down a delegation tree. Pure set-intersection: the result
 * is exactly `parent ∩ requested`, so a child lease can NEVER hold a cap the
 * parent does not, and never a cap that was not requested. This is the only
 * broadening-prevention an opaque lease has, which is why it is property/fuzz-
 * tested over 1000+ random (parent, requested) pairs rather than by example.
 *
 * Same discipline as {@link checkCapability}: a plain membership filter with NO
 * wildcard branch — no member implies admin/rpc/all-authority. The
 * requested order is preserved on the surviving subset.
 */
export function attenuateCaps(
  parent: readonly AgentCapability[],
  requested: readonly AgentCapability[],
): AgentCapability[] {
  const parentSet = new Set(parent);
  return requested.filter((c) => parentSet.has(c)); // intersection; never broadens
}

/**
 * @allow-throw: thrown at the daemon RPC handler boundary by
 * {@link requireCapability}; `rpc-dispatch.ts` converts it to a JSON-RPC error
 * response (mirrors `RequiredToolsUnreachableError`).
 *
 * Discriminated by `kind === "capability_denied"` (the matching `AuditKind`),
 * so a denial can be audited content-free as a security signal.
 */
export class CapabilityDeniedError extends Error {
  readonly kind = "capability_denied" as const;
  readonly required: AgentCapability;

  constructor(required: AgentCapability) {
    super(`Capability denied: ${required}`);
    this.required = required;
    this.name = "CapabilityDeniedError";
  }
}

/**
 * Handler-boundary capability gate (the single gate). Throws
 * {@link CapabilityDeniedError} when the caller does not hold `required`
 * (including the missing/undefined `_capabilities` case). On success it returns
 * `void`.
 *
 * @allow-throw: this is the boundary gate; the pure {@link checkCapability}
 * predicate is the non-throwing form.
 */
export function requireCapability(
  held: readonly string[] | undefined,
  required: AgentCapability,
): void {
  if (!held || !checkCapability(held, required)) {
    throw new CapabilityDeniedError(required);
  }
}
