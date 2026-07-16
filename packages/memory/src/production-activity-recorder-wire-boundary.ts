// SPDX-License-Identifier: Apache-2.0
import { types as nodeTypes } from "node:util";

import {
  ACTIVITY_RECORDING_MAX_WIRE_FRAME_BYTES,
  ACTIVITY_RECORDING_WIRE_ENVELOPE_RESERVE_BYTES,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

export interface ActivityRecordingWirePreflightFailure {
  readonly reason: "payload_invalid" | "payload_too_large";
  readonly cause: Error;
}

const MAX_WIRE_DEPTH = 16;
const MAX_WIRE_NODES = 8_192;
const MAX_WIRE_KEYS = 256;
const MAX_WIRE_ARRAY_ITEMS = 256;
/** Derive one fixed aggregate cap for both request and response worker frames. */
export function activityRecordingWireFrameBytes(maxPayloadBytes: number): Result<number, Error> {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    return err(new Error("Activity recording wire payload limit is invalid"));
  }
  return ok(Math.min(
    ACTIVITY_RECORDING_MAX_WIRE_FRAME_BYTES,
    maxPayloadBytes > Number.MAX_SAFE_INTEGER - ACTIVITY_RECORDING_WIRE_ENVELOPE_RESERVE_BYTES
      ? ACTIVITY_RECORDING_MAX_WIRE_FRAME_BYTES
      : maxPayloadBytes + ACTIVITY_RECORDING_WIRE_ENVELOPE_RESERVE_BYTES,
  ));
}

/**
 * Measure a structured-clone frame without invoking getters or proxy traps.
 * The walk stops at fixed depth, node, key, array, and byte ceilings.
 */
export function preflightActivityRecordingWireValue(
  value: unknown,
  maxBytes: number,
): Result<number, ActivityRecordingWirePreflightFailure> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return err({
      reason: "payload_invalid",
      cause: new Error("Activity recording wire frame limit is invalid"),
    });
  }
  let bytes = 0;
  let nodes = 0;
  const active = new WeakSet<object>();
  let failure: ActivityRecordingWirePreflightFailure | undefined;

  function reject(
    reason: ActivityRecordingWirePreflightFailure["reason"],
    message: string,
  ): false {
    failure ??= { reason, cause: new Error(message) };
    return false;
  }

  function addBytes(count: number): boolean {
    if (!Number.isSafeInteger(count) || count < 0 || count > maxBytes - bytes) {
      return reject("payload_too_large", "Activity recording wire frame exceeds its byte limit");
    }
    bytes += count;
    return true;
  }

  function addString(text: string): boolean {
    if (text.length > maxBytes - bytes) {
      return reject("payload_too_large", "Activity recording wire string exceeds its byte limit");
    }
    return addBytes(Buffer.byteLength(text, "utf8"));
  }

  function visit(current: unknown, depth: number): boolean {
    nodes += 1;
    if (nodes > MAX_WIRE_NODES || depth > MAX_WIRE_DEPTH) {
      return reject("payload_invalid", "Activity recording wire graph exceeds its structural limit");
    }
    if (!addBytes(8)) return false;
    if (current === null || current === undefined || typeof current === "boolean") return true;
    if (typeof current === "string") return addString(current);
    if (typeof current === "number") {
      return Number.isFinite(current)
        || reject("payload_invalid", "Activity recording wire graph contains a non-finite number");
    }
    if (typeof current !== "object") {
      return reject("payload_invalid", "Activity recording wire graph contains a non-cloneable value");
    }
    if (nodeTypes.isProxy(current)) {
      return reject("payload_invalid", "Activity recording wire graph contains a proxy");
    }
    if (Buffer.isBuffer(current) || current instanceof Date
      || current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      return reject("payload_invalid", "Activity recording wire graph contains a binary or special object");
    }
    if (active.has(current)) {
      return reject("payload_invalid", "Activity recording wire graph contains a cycle");
    }
    const prototypeRead = tryCatch(() => Object.getPrototypeOf(current) as object | null);
    if (!prototypeRead.ok) {
      return reject("payload_invalid", "Activity recording wire object prototype is unavailable");
    }
    const array = Array.isArray(current);
    if (array) {
      if (current.length > MAX_WIRE_ARRAY_ITEMS) {
        return reject("payload_invalid", "Activity recording wire array exceeds its item limit");
      }
      if (prototypeRead.value !== Array.prototype) {
        return reject("payload_invalid", "Activity recording wire array prototype is unsupported");
      }
    } else if (prototypeRead.value !== Object.prototype && prototypeRead.value !== null) {
      return reject("payload_invalid", "Activity recording wire object prototype is unsupported");
    }

    active.add(current);
    try {
      let keyCount = 0;
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
          return reject("payload_invalid", "Activity recording wire graph contains inherited fields");
        }
        keyCount += 1;
        if (keyCount > MAX_WIRE_KEYS) {
          return reject("payload_invalid", "Activity recording wire object exceeds its key limit");
        }
        const descriptorRead = tryCatch(() => Object.getOwnPropertyDescriptor(current, key));
        if (!descriptorRead.ok || descriptorRead.value === undefined
          || !("value" in descriptorRead.value)) {
          return reject("payload_invalid", "Activity recording wire graph contains an accessor");
        }
        if (!addString(key) || !visit(descriptorRead.value.value, depth + 1)) return false;
      }
      return true;
    } finally {
      active.delete(current);
    }
  }

  const checked = tryCatch(() => visit(value, 0));
  if (!checked.ok) {
    return err({
      reason: "payload_invalid",
      cause: new Error("Activity recording wire preflight failed", { cause: checked.error }),
    });
  }
  if (!checked.value) {
    return err(failure ?? {
      reason: "payload_invalid",
      cause: new Error("Activity recording wire preflight failed"),
    });
  }
  return ok(bytes);
}
