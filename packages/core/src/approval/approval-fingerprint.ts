// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { isProxy } from "node:util/types";
import { err, ok, tryCatch, type Result } from "@comis/shared";

export interface ApprovalParamSnapshot {
  readonly value: Record<string, unknown>;
  readonly canonical: string;
}

interface ValueSnapshot {
  readonly value: unknown;
  readonly canonical: string;
}

function snapshotValue(value: unknown, ancestors: Set<object>): Result<ValueSnapshot, Error> {
  if (value === null) return ok({ value: null, canonical: "null" });
  if (typeof value === "string") {
    return ok({ value, canonical: JSON.stringify(value) });
  }
  if (typeof value === "boolean") {
    return ok({ value, canonical: value ? "true" : "false" });
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? ok({ value, canonical: JSON.stringify(value) })
      : err(new Error("Approval parameters contain a non-finite number"));
  }
  if (typeof value !== "object") {
    return err(new Error("Approval parameters contain a non-JSON value"));
  }
  if (ancestors.has(value)) {
    return err(new Error("Approval parameters contain a cycle"));
  }

  if (Array.isArray(value)) {
    const inspected = tryCatch((): unknown[] | undefined => {
      if (isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
      const ownKeys = Reflect.ownKeys(value);
      const expectedKeys = new Set<PropertyKey>(["length"]);
      const values: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const key = String(index);
        expectedKeys.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || descriptor.enumerable !== true
        ) return undefined;
        values.push(descriptor.value);
      }
      return ownKeys.some((key) => !expectedKeys.has(key)) ? undefined : values;
    });
    if (!inspected.ok || inspected.value === undefined) {
      return err(new Error("Approval parameters contain an unsafe array"));
    }

    ancestors.add(value);
    const snapshots: ValueSnapshot[] = [];
    for (const item of inspected.value) {
      const snapshot = snapshotValue(item, ancestors);
      if (!snapshot.ok) {
        ancestors.delete(value);
        return snapshot;
      }
      snapshots.push(snapshot.value);
    }
    ancestors.delete(value);
    const cloned = Object.freeze(snapshots.map((snapshot) => snapshot.value));
    return ok({
      value: cloned,
      canonical: `[${snapshots.map((snapshot) => snapshot.canonical).join(",")}]`,
    });
  }

  const inspected = tryCatch((): Array<readonly [string, unknown]> | undefined => {
    if (isProxy(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
      ) return undefined;
      if (descriptor.value !== undefined) entries.push([key, descriptor.value]);
    }
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return entries;
  });
  if (!inspected.ok || inspected.value === undefined) {
    return err(new Error("Approval parameters contain an unsafe object"));
  }

  ancestors.add(value);
  const snapshots: Array<readonly [string, ValueSnapshot]> = [];
  for (const [key, item] of inspected.value) {
    const snapshot = snapshotValue(item, ancestors);
    if (!snapshot.ok) {
      ancestors.delete(value);
      return snapshot;
    }
    snapshots.push([key, snapshot.value]);
  }
  ancestors.delete(value);
  const cloned = Object.freeze(Object.fromEntries(
    snapshots.map(([key, snapshot]) => [key, snapshot.value]),
  ));
  return ok({
    value: cloned,
    canonical: `{${snapshots.map(([key, snapshot]) => (
      `${JSON.stringify(key)}:${snapshot.canonical}`
    )).join(",")}}`,
  });
}

/** Capture a JSON-only, deeply frozen approval parameter record and canonical encoding. */
export function snapshotApprovalParams(raw: unknown): Result<ApprovalParamSnapshot, Error> {
  const captured = tryCatch(() => snapshotValue(raw, new Set<object>()));
  if (!captured.ok) {
    return err(new Error("Approval parameters could not be inspected safely"));
  }
  if (!captured.value.ok) return captured.value;
  const snapshot = captured.value.value;
  if (
    snapshot.value === null
    || typeof snapshot.value !== "object"
    || Array.isArray(snapshot.value)
  ) {
    return err(new Error("Approval parameters must be a record"));
  }
  return ok({
    value: snapshot.value as Record<string, unknown>,
    canonical: snapshot.canonical,
  });
}

/** Produce an opaque keyed digest with a purpose-specific domain separator. */
export function createApprovalHmac(
  secret: string,
  domain: "cache" | "operation",
  canonical: string,
): Result<string, Error> {
  if (secret.length === 0) return err(new Error("Approval fingerprint secret is empty"));
  const digest = tryCatch(() => createHmac("sha256", secret)
    .update(`comis.approval.${domain}.v1\0`)
    .update(canonical)
    .digest("hex"));
  return digest.ok
    ? ok(digest.value)
    : err(new Error("Approval fingerprint could not be created"));
}
