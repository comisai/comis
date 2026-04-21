// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createActiveRunRegistry, type RunHandle } from "./active-run-registry.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockRunHandle(overrides?: Partial<RunHandle>): RunHandle {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    isStreaming: vi.fn().mockReturnValue(false),
    isCompacting: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ActiveRunRegistry", () => {
  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  describe("register", () => {
    it("returns true on first registration", () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle();

      const result = registry.register("t1:u1:c1", handle);

      expect(result).toBe(true);
    });

    it("returns false when session is already registered (duplicate guard)", () => {
      const registry = createActiveRunRegistry();
      const handle1 = createMockRunHandle();
      const handle2 = createMockRunHandle();

      registry.register("t1:u1:c1", handle1);
      const result = registry.register("t1:u1:c1", handle2);

      expect(result).toBe(false);
    });

    it("does not overwrite existing handle on duplicate registration", () => {
      const registry = createActiveRunRegistry();
      const handle1 = createMockRunHandle();
      const handle2 = createMockRunHandle();

      registry.register("t1:u1:c1", handle1);
      registry.register("t1:u1:c1", handle2);

      expect(registry.get("t1:u1:c1")).toBe(handle1);
    });

    it("allows registering different session keys", () => {
      const registry = createActiveRunRegistry();
      const handle1 = createMockRunHandle();
      const handle2 = createMockRunHandle();

      expect(registry.register("t1:u1:c1", handle1)).toBe(true);
      expect(registry.register("t1:u2:c1", handle2)).toBe(true);
      expect(registry.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // deregister
  // -------------------------------------------------------------------------

  describe("deregister", () => {
    it("removes the handle for the session key", () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle();

      registry.register("t1:u1:c1", handle);
      registry.deregister("t1:u1:c1");

      expect(registry.has("t1:u1:c1")).toBe(false);
      expect(registry.get("t1:u1:c1")).toBeUndefined();
    });

    it("is a no-op when session key is not registered (no throw)", () => {
      const registry = createActiveRunRegistry();

      // Should not throw
      expect(() => registry.deregister("nonexistent")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  describe("get", () => {
    it("returns the handle after registration", () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle();

      registry.register("t1:u1:c1", handle);

      expect(registry.get("t1:u1:c1")).toBe(handle);
    });

    it("returns undefined after deregistration", () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle();

      registry.register("t1:u1:c1", handle);
      registry.deregister("t1:u1:c1");

      expect(registry.get("t1:u1:c1")).toBeUndefined();
    });

    it("returns undefined for never-registered key", () => {
      const registry = createActiveRunRegistry();

      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // has
  // -------------------------------------------------------------------------

  describe("has", () => {
    it("returns true for registered session", () => {
      const registry = createActiveRunRegistry();
      registry.register("t1:u1:c1", createMockRunHandle());

      expect(registry.has("t1:u1:c1")).toBe(true);
    });

    it("returns false for unregistered session", () => {
      const registry = createActiveRunRegistry();

      expect(registry.has("nonexistent")).toBe(false);
    });

    it("returns false after deregistration", () => {
      const registry = createActiveRunRegistry();
      registry.register("t1:u1:c1", createMockRunHandle());
      registry.deregister("t1:u1:c1");

      expect(registry.has("t1:u1:c1")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // size
  // -------------------------------------------------------------------------

  describe("size", () => {
    it("starts at 0", () => {
      const registry = createActiveRunRegistry();

      expect(registry.size).toBe(0);
    });

    it("reflects active count after registrations", () => {
      const registry = createActiveRunRegistry();

      registry.register("k1", createMockRunHandle());
      expect(registry.size).toBe(1);

      registry.register("k2", createMockRunHandle());
      expect(registry.size).toBe(2);

      registry.register("k3", createMockRunHandle());
      expect(registry.size).toBe(3);
    });

    it("decreases after deregistration", () => {
      const registry = createActiveRunRegistry();

      registry.register("k1", createMockRunHandle());
      registry.register("k2", createMockRunHandle());
      expect(registry.size).toBe(2);

      registry.deregister("k1");
      expect(registry.size).toBe(1);

      registry.deregister("k2");
      expect(registry.size).toBe(0);
    });

    it("does not change on duplicate registration", () => {
      const registry = createActiveRunRegistry();

      registry.register("k1", createMockRunHandle());
      expect(registry.size).toBe(1);

      registry.register("k1", createMockRunHandle());
      expect(registry.size).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // RunHandle proxy behavior
  // -------------------------------------------------------------------------

  describe("RunHandle methods are accessible through get()", () => {
    it("steer delegates correctly", async () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle();

      registry.register("t1:u1:c1", handle);
      const retrieved = registry.get("t1:u1:c1")!;

      await retrieved.steer("interrupt me");

      expect(handle.steer).toHaveBeenCalledWith("interrupt me");
    });

    it("followUp delegates correctly", async () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle();

      registry.register("t1:u1:c1", handle);
      const retrieved = registry.get("t1:u1:c1")!;

      await retrieved.followUp("follow up text");

      expect(handle.followUp).toHaveBeenCalledWith("follow up text");
    });

    it("abort delegates correctly", async () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle();

      registry.register("t1:u1:c1", handle);
      const retrieved = registry.get("t1:u1:c1")!;

      await retrieved.abort();

      expect(handle.abort).toHaveBeenCalled();
    });

    it("isStreaming returns handle value", () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle({ isStreaming: vi.fn().mockReturnValue(true) });

      registry.register("t1:u1:c1", handle);
      const retrieved = registry.get("t1:u1:c1")!;

      expect(retrieved.isStreaming()).toBe(true);
    });

    it("isCompacting returns handle value", () => {
      const registry = createActiveRunRegistry();
      const handle = createMockRunHandle({ isCompacting: vi.fn().mockReturnValue(true) });

      registry.register("t1:u1:c1", handle);
      const retrieved = registry.get("t1:u1:c1")!;

      expect(retrieved.isCompacting()).toBe(true);
    });
  });
});
