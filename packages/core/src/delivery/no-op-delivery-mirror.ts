// SPDX-License-Identifier: Apache-2.0
// No-op DeliveryMirrorPort factory. Sibling to other core/src/delivery/ utilities.
import { randomUUID } from "node:crypto";
import { ok } from "@comis/shared";
import type { DeliveryMirrorPort, DeliveryMirrorEntry } from "../ports/delivery-mirror.js";

/**
 * No-op delivery mirror for when the mirror feature is disabled.
 *
 * All operations succeed immediately with no persistence.
 * record returns a random UUID, pending returns [], acknowledge returns void,
 * and clearSession/pruneOld return 0.
 */
export function createNoOpDeliveryMirror(): DeliveryMirrorPort {
  return Object.freeze({
    record: () => Promise.resolve(ok(randomUUID())),
    pending: () => Promise.resolve(ok([] as DeliveryMirrorEntry[])),
    acknowledge: () => Promise.resolve(ok(undefined)),
    clearSession: () => Promise.resolve(ok(0)),
    pruneOld: () => Promise.resolve(ok(0)),
  });
}
