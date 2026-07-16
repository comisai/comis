// SPDX-License-Identifier: Apache-2.0
import type { ActivityRecordingGapReason } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

export interface ActivityPayloadFailure {
  readonly reason: ActivityRecordingGapReason;
  readonly cause: Error;
}

const MAX_GRAPH_DEPTH = 12;
const MAX_GRAPH_NODES = 4_096;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;

export function validateActivityJsonGraph(
  value: unknown,
  maxStringBytes: number,
): Result<void, ActivityPayloadFailure> {
  let nodeCount = 0;
  let failureReason: ActivityRecordingGapReason = "payload_invalid";
  const path = new WeakSet<object>();

  function reject(reason: ActivityRecordingGapReason = "payload_invalid"): false {
    failureReason = reason;
    return false;
  }

  function visit(current: unknown, depth: number): boolean {
    nodeCount += 1;
    if (nodeCount > MAX_GRAPH_NODES || depth > MAX_GRAPH_DEPTH) return reject();
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "string") {
      return Buffer.byteLength(current, "utf8") <= maxStringBytes
        || reject("payload_too_large");
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object") return reject();
    if (Buffer.isBuffer(current) || current instanceof Date || path.has(current)) return reject();
    path.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_ARRAY_ITEMS) return reject();
        for (const entry of current) if (!visit(entry, depth + 1)) return false;
        return true;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return reject();
      const keys = Object.keys(current);
      if (keys.length > MAX_OBJECT_KEYS) return reject();
      for (const key of keys) {
        if (!visit((current as Record<string, unknown>)[key], depth + 1)) return false;
      }
      return true;
    } finally {
      path.delete(current);
    }
  }

  const checked = tryCatch(() => visit(value, 0));
  if (!checked.ok) return err({ reason: "payload_invalid", cause: checked.error });
  return checked.value
    ? ok(undefined)
    : err({ reason: failureReason, cause: new Error("Payload is not bounded JSON") });
}

export function serializeActivityPayload(
  value: unknown,
  maxPayloadBytes: number,
): Result<string, ActivityPayloadFailure> {
  const valid = validateActivityJsonGraph(value, maxPayloadBytes);
  if (!valid.ok) return valid;
  const serialized = tryCatch(() => JSON.stringify(value));
  if (!serialized.ok || serialized.value === undefined) {
    return err({
      reason: "payload_invalid",
      cause: serialized.ok ? new Error("Payload did not serialize") : serialized.error,
    });
  }
  if (Buffer.byteLength(serialized.value, "utf8") > maxPayloadBytes) {
    return err({ reason: "payload_too_large", cause: new Error("Payload exceeds configured byte cap") });
  }
  return ok(serialized.value);
}
