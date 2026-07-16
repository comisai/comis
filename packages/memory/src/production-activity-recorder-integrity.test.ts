// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_RECORDING_ZERO_HASH,
  canonicalRecordIndex,
  ciphertextDigest,
  makeTrustedHead,
  trustedHeadStateHash,
} from "./production-activity-recorder-integrity.js";

describe("production activity recorder authenticated state", () => {
  it("binds stream identity and post-record loss accounting into the index", () => {
    const index = canonicalRecordIndex({
      streamId: "machine-a",
      instanceId: "550e8400-e29b-41d4-a716-446655440000",
      sequence: 1,
      recordId: "record:00000000000000000001",
      kind: "gap",
      traceId: null,
      parentRecordId: null,
      attemptId: null,
      capabilityDigest: null,
      writerId: "550e8400-e29b-41d4-a716-446655440001",
      occurredAtMs: 1,
      payloadDigest: ACTIVITY_RECORDING_ZERO_HASH,
      payloadBytes: 1,
      previousHash: ACTIVITY_RECORDING_ZERO_HASH,
      stateLogicalBytes: 200,
      stateRecordCount: 1,
      stateGapCount: 1,
    });
    expect(index).toContain('"streamId":"machine-a"');
    expect(index).toContain('"logicalBytes":200');
    expect(index).toContain('"gapCount":1');
  });

  it("changes the authenticated head hash when loss or logical bytes change", () => {
    const base = {
      streamId: "machine-a",
      instanceId: "550e8400-e29b-41d4-a716-446655440000",
      sequence: 1,
      recordHash: ACTIVITY_RECORDING_ZERO_HASH,
      logicalBytes: 200,
      recordCount: 1,
      gapCount: 0,
    };
    expect(trustedHeadStateHash(base)).not.toBe(trustedHeadStateHash({ ...base, gapCount: 1 }));
    expect(makeTrustedHead(base).stateHash).toBe(trustedHeadStateHash(base));
  });

  it("distinguishes equal byte streams with different ciphertext component boundaries", () => {
    const first = {
      ciphertext: Buffer.from([1, 2]),
      iv: Buffer.from([3]),
      authTag: Buffer.from([4]),
      salt: Buffer.from([5]),
    };
    const repartitioned = {
      ciphertext: Buffer.from([1]),
      iv: Buffer.from([2, 3]),
      authTag: Buffer.from([4]),
      salt: Buffer.from([5]),
    };

    expect(Buffer.concat(Object.values(first))).toEqual(Buffer.concat(Object.values(repartitioned)));
    expect(ciphertextDigest(first)).not.toBe(ciphertextDigest(repartitioned));
  });
});
