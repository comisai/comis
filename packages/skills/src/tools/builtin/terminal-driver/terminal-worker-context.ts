// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound-context validation for the Terminal Worker.
 *
 * The worker re-establishes the originating `traceId` as its ALS context
 * so its logs correlate to the originating turn — but the wire `traceId`
 * is UNTRUSTED. This module owns the sanitize-not-trust policy + the
 * least-privilege trust level the worker context runs under. Extracted from the
 * worker entry so that file stays under the 800-line architecture cap; pure (no
 * I/O, no module-global mutable state).
 *
 * @module
 */

import { randomUUID } from "node:crypto";

/** UUID (8-4-4-4-12 hex) shape — matches `RequestContextSchema.traceId` (`z.guid()`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The least-privileged trust level the worker context runs under.
 *
 * The worker performs NO authorization decisions — it only spawns from the
 * already-gated `{bin,argv}` and renders read views. An unconditional
 * `trustLevel:"admin"` was a latent trust-elevation foothold for any future
 * worker-side code that consults `getContext().trustLevel`; `guest` (least
 * privilege) removes it. Worker code MUST NOT make trust decisions — authz lives
 * entirely on the daemon side, before the create frame is ever sent.
 */
export const WORKER_TRUST_LEVEL = "guest" as const;

/**
 * Sanitize the inbound wire `traceId` before it becomes the ALS context.
 *
 * `runWithContext` does NOT validate against `RequestContextSchema` (whose
 * `traceId` is `z.guid()`), so an arbitrary/attacker-chosen traceId off the wire
 * would be stamped onto every worker log line — log-correlation poisoning (a
 * forged id stitches worker logs to an unrelated turn). We accept a valid UUID
 * verbatim (legitimate correlation preserved) and otherwise REGENERATE a fresh
 * id rather than trusting the wire. The caller logs the substitution.
 *
 * @param wire - The raw `traceId` off the request frame.
 * @returns The accepted-or-regenerated `traceId` + whether it was regenerated.
 */
export function sanitizeTraceId(wire: unknown): { traceId: string; regenerated: boolean } {
  if (typeof wire === "string" && UUID_RE.test(wire)) {
    return { traceId: wire, regenerated: false };
  }
  return { traceId: randomUUID(), regenerated: true };
}
