// SPDX-License-Identifier: Apache-2.0
/**
 * Whether one heartbeat observation is admissible for a managed run.
 *
 * Kept pure and separate from the store transaction so the rules can be read
 * and tested without a database: liveness is the input the reducer trusts when
 * it decides a run has gone dark, and a rule that is hard to inspect is a rule
 * that quietly stops being true.
 *
 * @module
 */
import { ok, type Result } from "@comis/shared";
import type {
  ManagedRunHeartbeatInput,
  ManagedRunHeartbeatOutcome,
  ManagedRunRecord,
  ManagedRunServiceScope,
} from "@comis/core";
import { scopeMatches } from "./managed-run-store-record.js";

/**
 * A heartbeat carries no operation ID because it is an observation, not a
 * mutation to replay: a duplicate is simply a beat that no longer advances the
 * record. Refusing a backward beat keeps a late-arriving older observation from
 * making a stalled service look current, and refusing a terminal run keeps a
 * service that outlived its own work from holding it open.
 */
export function decideManagedRunHeartbeat(
  current: ManagedRunRecord | undefined,
  scope: ManagedRunServiceScope,
  input: ManagedRunHeartbeatInput,
): Result<ManagedRunHeartbeatOutcome, Error> {
  if (!Number.isInteger(input.observedAtMs) || input.observedAtMs < 0) {
    return ok({ kind: "rejected", reasonCode: "stale_observation" });
  }
  if (current === undefined) return ok({ kind: "rejected", reasonCode: "not_found" });
  if (!scopeMatches(current, scope)) {
    return ok({ kind: "rejected", reasonCode: "ownership_mismatch" });
  }
  if (
    current.status === "succeeded"
    || current.status === "failed"
    || current.status === "cancelled"
  ) return ok({ kind: "rejected", reasonCode: "terminal_run" });
  if (
    current.lastHeartbeatAtMs !== undefined
    && input.observedAtMs <= current.lastHeartbeatAtMs
  ) return ok({ kind: "rejected", reasonCode: "stale_observation" });
  return ok({
    kind: "committed",
    record: {
      ...current,
      lastHeartbeatAtMs: input.observedAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, input.observedAtMs),
    },
  });
}
