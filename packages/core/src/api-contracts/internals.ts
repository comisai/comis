// SPDX-License-Identifier: Apache-2.0
/**
 * Dispatcher-injected internal field names.
 *
 * The gateway dispatcher (`packages/daemon/src/wiring/setup-gateway-api.ts`)
 * injects these `_X` keys into every RPC params object before invoking the
 * handler. They are NEVER part of a public contract — strip via
 * `stripInternalFields()` BEFORE calling `contract.request.parse(params)`.
 *
 * Pitfall: if a contract author models any of these names in `request`,
 * `z.toJSONSchema(schema, additionalProperties: false)` would cause the
 * dispatcher's downstream call to FAIL because the dispatcher adds
 * `_trustLevel` AFTER the CLI sent the request. The paired
 * `test/architecture/contract-internal-fields.test.ts` fails-closed the
 * moment any contract request schema declares one of these keys.
 *
 * @module
 */

/** The 17 dispatcher-injected internal-field names (sorted alphabetically). */
export const INTERNAL_FIELD_NAMES = [
  "_agentId",
  "_callerChannelId",
  "_callerChannelType",
  "_callerMetadata",
  "_callerSessionKey",
  // The trusted in-process caller's resolved orchestration capabilities
  // (Phase 210). Injected by createAgentRpcCall / the 211 lease endpoint;
  // stripped from external WS/REST callers so caps cannot be forged.
  "_capabilities",
  "_channelType",
  "_chatType",
  "_context",
  "_deliveryTarget",
  "_originChannelId",
  // The monotonic outward-send index (Phase 216, NEW-3/HIGH-1). Allocated by
  // durableRuns.allocateOutwardStep at the TRUSTED cap chokepoint (the jail leg
  // in setup-capability-endpoint.ts + the in-process leg in
  // setup-tools-capabilities.ts) and injected as `_outwardStepIndex` for the
  // outward message methods. Listed here so stripInternalFields STRIPS a forged
  // inbound value BEFORE the chokepoint re-injects the trusted allocated one —
  // the exact strip-then-inject pattern `_agentId` uses, so a jailed script
  // cannot forge the index to self-collide its own send (inverting ONCE-02) or
  // perturb outward ordering. Agent-origin-only by construction.
  "_outwardStepIndex",
  "_sessionKey",
  "_tenantId",
  "_traceId",
  "_trustLevel",
  "_userId",
] as const satisfies readonly string[];

/** Pre-computed Set for O(1) lookup. */
const INTERNAL_SET: ReadonlySet<string> = new Set<string>(INTERNAL_FIELD_NAMES);

/**
 * Return a NEW object containing every entry of `params` EXCEPT those whose
 * key appears in `INTERNAL_FIELD_NAMES`. Pure: does not mutate input.
 *
 * The dispatcher calls this before `contract.request.parse(params)` so the
 * internal `_X` keys are projected away. Handler bodies that need a value
 * from one of those keys read it directly from the un-stripped params (e.g.,
 * `rawParams._trustLevel` for the admin-gate check).
 */
export function stripInternalFields(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!INTERNAL_SET.has(k)) {
      out[k] = v;
    }
  }
  return out;
}
