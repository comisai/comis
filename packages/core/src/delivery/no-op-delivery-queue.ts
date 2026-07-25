// SPDX-License-Identifier: Apache-2.0
// No-op DeliveryQueuePort factory. Sibling to other core/src/delivery/ utilities.
import { randomUUID } from "node:crypto";
import { ok } from "@comis/shared";
import type { DeliveryQueuePort, DeliveryQueueEntry } from "../ports/delivery-queue.js";

/**
 * No-op delivery queue for when the queue feature is disabled.
 *
 * All operations succeed immediately with no persistence.
 * enqueue returns a random UUID, claim returns true, ack/nack/fail return void,
 * pendingEntries returns [], pruneExpired/depth return 0.
 */
export function createNoOpDeliveryQueue(): DeliveryQueuePort {
  return Object.freeze({
    enqueue: () => Promise.resolve(ok(randomUUID())),
    enqueueInFlight: () => Promise.resolve(ok(randomUUID())),
    claim: () => Promise.resolve(ok(true)),
    ack: () => Promise.resolve(ok(undefined)),
    nack: () => Promise.resolve(ok(undefined)),
    fail: () => Promise.resolve(ok(undefined)),
    pendingEntries: () => Promise.resolve(ok([] as DeliveryQueueEntry[])),
    unconfirmedEntries: () => Promise.resolve(ok([] as DeliveryQueueEntry[])),
    pruneExpired: () => Promise.resolve(ok(0)),
    depth: () => Promise.resolve(ok(0)),
    statusCounts: () => Promise.resolve(ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 })),
    recoverInFlight: () => Promise.resolve(ok(0)),
  });
}
