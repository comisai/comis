// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createSecretsCrypto } from "@comis/core";

import {
  createActivityRecordingCrypto,
  deriveActivityRecordingMasterKey,
} from "./activity-recording-crypto.js";

describe("activity recording crypto authority", () => {
  it("round-trips payload through the injected authenticated encryption authority", () => {
    const crypto = createActivityRecordingCrypto(randomBytes(32));
    const context = { streamId: "machine-a", instanceId: "instance-a", purpose: "payload" as const };
    const sealed = crypto.seal(context, Buffer.from("private user text", "utf8"));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    const opened = crypto.open(context, sealed.value);
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.value.toString("utf8")).toBe("private user text");
  });

  it("binds ciphertext to purpose, stream, and recorder instance", () => {
    const crypto = createActivityRecordingCrypto(randomBytes(32));
    const context = { streamId: "machine-a", instanceId: "instance-a", purpose: "payload" as const };
    const sealed = crypto.seal(context, Buffer.from("private user text", "utf8"));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    expect(crypto.open({ ...context, purpose: "index_proof" }, sealed.value).ok).toBe(false);
    expect(crypto.open({ ...context, streamId: "machine-b" }, sealed.value).ok).toBe(false);
    expect(crypto.open({ ...context, instanceId: "instance-b" }, sealed.value).ok).toBe(false);
  });

  it("rejects a tampered authentication tag", () => {
    const crypto = createActivityRecordingCrypto(randomBytes(32));
    const context = { streamId: "machine-a", instanceId: "instance-a", purpose: "index_proof" as const };
    const sealed = crypto.seal(context, Buffer.from("content-free-index", "utf8"));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    const authTag = Buffer.from(sealed.value.authTag);
    authTag[0] = (authTag[0] ?? 0) ^ 0xff;
    const opened = crypto.open(context, { ...sealed.value, authTag });
    expect(opened.ok).toBe(false);
  });

  it("cannot be decrypted through generic secret crypto using the same master key", () => {
    const masterKey = randomBytes(32);
    const activityCrypto = createActivityRecordingCrypto(masterKey);
    const genericCrypto = createSecretsCrypto(masterKey);
    const context = { streamId: "machine-a", instanceId: "instance-a", purpose: "payload" as const };
    const sealed = activityCrypto.seal(context, Buffer.from("private user text", "utf8"));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    expect(genericCrypto.decrypt(sealed.value).ok).toBe(false);
  });

  it("derives a stable dedicated root key disjoint from generic secret key bytes", () => {
    const root = randomBytes(32);
    const first = deriveActivityRecordingMasterKey(root);
    const second = deriveActivityRecordingMasterKey(root);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toEqual(second.value);
    expect(first.value).not.toEqual(root);
    expect(deriveActivityRecordingMasterKey(Buffer.alloc(16)).ok).toBe(false);
  });
});
