// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for setupSecretManager composition-root helper (03-04).
 *
 * setupSecretManager is a thin wrapper around createSecretManagerWithMutableHandle.
 * These tests verify the wrapper contract: shared-Map invariant, returned shapes,
 * and that upserts on mutableHandle are immediately visible to secretManager.
 */

import { describe, it, expect } from "vitest";
import { setupSecretManager } from "./setup-secret-manager.js";

describe("setupSecretManager (03-04 — composition-root shared-Map helper)", () => {
  it("returns secretManager and mutableHandle from an empty env", () => {
    const result = setupSecretManager({});
    expect(result).toHaveProperty("secretManager");
    expect(result).toHaveProperty("mutableHandle");
    expect(typeof result.secretManager.get).toBe("function");
    expect(typeof result.secretManager.has).toBe("function");
    expect(typeof result.secretManager.keys).toBe("function");
    expect(typeof result.mutableHandle.upsert).toBe("function");
    expect(typeof result.mutableHandle.remove).toBe("function");
  });

  it("seeds initial env values into secretManager", () => {
    const { secretManager } = setupSecretManager({ MY_KEY: "my-value" });
    expect(secretManager.get("MY_KEY")).toBe("my-value");
    expect(secretManager.has("MY_KEY")).toBe(true);
  });

  it("shared-Map invariant: mutableHandle.upsert is immediately visible to secretManager.get", () => {
    const { secretManager, mutableHandle } = setupSecretManager({});

    // Before upsert: key does not exist
    expect(secretManager.has("LIVE_KEY")).toBe(false);
    expect(secretManager.get("LIVE_KEY")).toBeUndefined();

    // Upsert via mutableHandle (simulating what the daemon's RPC handler does)
    mutableHandle.upsert("LIVE_KEY", "live-value");

    // After upsert: secretManager reads from the SAME backing Map — immediately visible
    expect(secretManager.has("LIVE_KEY")).toBe(true);
    expect(secretManager.get("LIVE_KEY")).toBe("live-value");
  });

  it("shared-Map invariant: mutableHandle.remove is immediately visible to secretManager", () => {
    const { secretManager, mutableHandle } = setupSecretManager({ REMOVE_KEY: "v1" });

    expect(secretManager.has("REMOVE_KEY")).toBe(true);

    mutableHandle.remove("REMOVE_KEY");

    expect(secretManager.has("REMOVE_KEY")).toBe(false);
    expect(secretManager.get("REMOVE_KEY")).toBeUndefined();
  });

  it("undefined env values are not populated into secretManager", () => {
    const { secretManager } = setupSecretManager({ PRESENT: "val", ABSENT: undefined });
    expect(secretManager.get("PRESENT")).toBe("val");
    expect(secretManager.has("ABSENT")).toBe(false);
  });
});
