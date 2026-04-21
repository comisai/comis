// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SecretManager } from "./secret-manager.js";
import { createSecretManager, envSubset, createScopedSecretManager } from "./secret-manager.js";
import { TypedEventBus } from "../event-bus/index.js";
import type { EventMap } from "../event-bus/index.js";

describe("SecretManager", () => {
  const testEnv: Record<string, string | undefined> = {
    TEST_KEY: "test-value",
    API_TOKEN: "secret-token-123",
    EMPTY_KEY: "",
    UNDEF_KEY: undefined,
  };

  function makeManager(): SecretManager {
    return createSecretManager(testEnv);
  }

  describe("get()", () => {
    it("returns value when key exists", () => {
      const manager = makeManager();
      expect(manager.get("TEST_KEY")).toBe("test-value");
    });

    it("returns undefined when key does not exist", () => {
      const manager = makeManager();
      expect(manager.get("NONEXISTENT")).toBeUndefined();
    });

    it("treats undefined values as non-existent", () => {
      const manager = makeManager();
      expect(manager.get("UNDEF_KEY")).toBeUndefined();
    });
  });

  describe("has()", () => {
    it("returns true when key exists", () => {
      const manager = makeManager();
      expect(manager.has("TEST_KEY")).toBe(true);
    });

    it("returns false when key does not exist", () => {
      const manager = makeManager();
      expect(manager.has("NONEXISTENT")).toBe(false);
    });

    it("returns false for keys with undefined values", () => {
      const manager = makeManager();
      expect(manager.has("UNDEF_KEY")).toBe(false);
    });
  });

  describe("require()", () => {
    it("returns value when key exists", () => {
      const manager = makeManager();
      expect(manager.require("TEST_KEY")).toBe("test-value");
    });

    it("throws with key name in message when key does not exist", () => {
      const manager = makeManager();
      expect(() => manager.require("NONEXISTENT")).toThrow("NONEXISTENT");
    });

    it("error message does NOT enumerate available key names", () => {
      const manager = createSecretManager({ A: "val-a", B: "val-b" });
      try {
        manager.require("MISSING");
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as Error).message;
        // Must mention the missing key
        expect(msg).toContain("MISSING");
        // Must NOT list other keys
        expect(msg).not.toContain("Available keys");
        expect(msg).not.toContain('"A"');
        expect(msg).not.toContain('"B"');
        expect(msg).not.toContain("A, B");
        expect(msg).not.toContain("B, A");
        // Should contain the new help text
        expect(msg).toContain("Check that this key is defined");
      }
    });

    it("require() error does not leak other key names or values", () => {
      const mgr = createSecretManager({
        KEY_A: "secret-val-1",
        KEY_B: "secret-val-2",
        OPENAI_API_KEY: "sk-realkey",
      });
      expect(() => mgr.require("MISSING")).toThrowError(/Required secret "MISSING"/);
      try {
        mgr.require("MISSING");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain("KEY_A");
        expect(msg).not.toContain("KEY_B");
        expect(msg).not.toContain("OPENAI_API_KEY");
        expect(msg).not.toContain("secret-val-1");
        expect(msg).not.toContain("sk-realkey");
      }
    });
  });

  describe("no credential enumeration", () => {
    it("does not expose .env property", () => {
      const manager = makeManager();
      expect((manager as unknown as Record<string, unknown>)["env"]).toBeUndefined();
    });

    it("does not expose .getAll() method", () => {
      const manager = makeManager();
      expect((manager as unknown as Record<string, unknown>)["getAll"]).toBeUndefined();
    });
  });

  describe("createSecretManager() with env overrides", () => {
    it("accepts a controlled record of env vars", () => {
      const manager = createSecretManager({ CUSTOM_KEY: "custom-value" });
      expect(manager.get("CUSTOM_KEY")).toBe("custom-value");
    });
  });

  describe("defensive copy", () => {
    it("modifying original env after creation does not affect manager", () => {
      const env: Record<string, string | undefined> = {
        MUTABLE_KEY: "original",
      };
      const manager = createSecretManager(env);

      // Mutate the original object
      env["MUTABLE_KEY"] = "mutated";
      env["NEW_KEY"] = "new-value";

      expect(manager.get("MUTABLE_KEY")).toBe("original");
      expect(manager.get("NEW_KEY")).toBeUndefined();
    });
  });

  describe("keys()", () => {
    it("returns available key names", () => {
      const manager = makeManager();
      const keys = manager.keys();
      expect(keys).toContain("TEST_KEY");
      expect(keys).toContain("API_TOKEN");
      expect(keys).toContain("EMPTY_KEY");
      // UNDEF_KEY should not be in keys since its value is undefined
      expect(keys).not.toContain("UNDEF_KEY");
    });

    it("returns a defensive copy of keys array", () => {
      const manager = makeManager();
      const keys1 = manager.keys();
      const keys2 = manager.keys();
      expect(keys1).toEqual(keys2);
      expect(keys1).not.toBe(keys2); // Different array instances
    });
  });
});

describe("envSubset()", () => {
  it("returns only requested keys from manager", () => {
    const manager = createSecretManager({
      A: "1",
      B: "2",
      C: "3",
      D: "4",
      E: "5",
    });
    const subset = envSubset(manager, ["A", "C"]);
    expect(subset).toEqual({ A: "1", C: "3" });
    expect(Object.keys(subset)).toHaveLength(2);
  });

  it("returns empty for non-existent keys", () => {
    const manager = createSecretManager({ A: "1" });
    const subset = envSubset(manager, ["MISSING_1", "MISSING_2"]);
    expect(subset).toEqual({});
  });

  it("returns a plain object, not a Map", () => {
    const manager = createSecretManager({ X: "val" });
    const subset = envSubset(manager, ["X"]);
    expect(subset).toBeTypeOf("object");
    expect(subset).not.toBeInstanceOf(Map);
    expect(subset.X).toBe("val");
  });
});

// ---------------------------------------------------------------------------
// ScopedSecretManager tests (merged from scoped-secret-manager.test.ts)
// ---------------------------------------------------------------------------

describe("ScopedSecretManager", () => {
  const baseSecrets = {
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: "ak-test",
    STRIPE_KEY: "sk_live_test",
    UNRELATED: "value",
  };

  let base: ReturnType<typeof createSecretManager>;
  let bus: TypedEventBus;
  let events: EventMap["secret:accessed"][];

  beforeEach(() => {
    base = createSecretManager(baseSecrets);
    bus = new TypedEventBus();
    events = [];
    bus.on("secret:accessed", (e) => events.push(e));
  });

  it("get() delegates to base when pattern matches", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    const value = scoped.get("OPENAI_API_KEY");

    expect(value).toBe("sk-test");
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("success");
  });

  it("get() returns undefined when pattern denies", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    const value = scoped.get("STRIPE_KEY");

    expect(value).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("denied");
  });

  it("get() emits not_found when base has no value", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    const value = scoped.get("OPENAI_OTHER");

    expect(value).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("not_found");
  });

  it("has() returns false when pattern denies", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    const result = scoped.has("STRIPE_KEY");

    expect(result).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("denied");
  });

  it("has() delegates when pattern allows", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    const result = scoped.has("OPENAI_API_KEY");

    expect(result).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("success");
  });

  it("require() throws when pattern denies", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    expect(() => scoped.require("STRIPE_KEY")).toThrow("not allowed");
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("denied");
  });

  it("require() throws when key not found in base", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    expect(() => scoped.require("OPENAI_MISSING")).toThrow("not set");
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("not_found");
  });

  it("require() returns value when allowed and exists", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    const value = scoped.require("OPENAI_API_KEY");

    expect(value).toBe("sk-test");
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("success");
  });

  it("keys() filters by allow patterns", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*", "anthropic_*"],
      eventBus: bus,
    });

    const keys = scoped.keys();

    expect(keys).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    // keys() is a listing operation — no events emitted
    expect(events).toHaveLength(0);
  });

  it("empty allow patterns = unrestricted access", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: [],
      eventBus: bus,
    });

    expect(scoped.get("OPENAI_API_KEY")).toBe("sk-test");
    expect(scoped.get("STRIPE_KEY")).toBe("sk_live_test");
    expect(scoped.has("UNRELATED")).toBe(true);
    expect(scoped.require("ANTHROPIC_API_KEY")).toBe("ak-test");
    expect(scoped.keys()).toEqual(
      expect.arrayContaining([
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "STRIPE_KEY",
        "UNRELATED",
      ]),
    );

    // All access events should be "success"
    expect(events.every((e) => e.outcome === "success")).toBe(true);
  });

  it("works without eventBus (no audit events)", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-1",
      allowPatterns: ["openai_*"],
      // eventBus intentionally omitted
    });

    // All methods should work without crashing
    expect(scoped.get("OPENAI_API_KEY")).toBe("sk-test");
    expect(scoped.get("STRIPE_KEY")).toBeUndefined();
    expect(scoped.has("OPENAI_API_KEY")).toBe(true);
    expect(scoped.has("STRIPE_KEY")).toBe(false);
    expect(scoped.require("OPENAI_API_KEY")).toBe("sk-test");
    expect(() => scoped.require("STRIPE_KEY")).toThrow("not allowed");
    expect(scoped.keys()).toEqual(["OPENAI_API_KEY"]);

    // No events emitted to the bus we set up separately
    expect(events).toHaveLength(0);
  });

  it("event payload includes agentId and timestamp", () => {
    const scoped = createScopedSecretManager(base, {
      agentId: "agent-audit-test",
      allowPatterns: ["openai_*"],
      eventBus: bus,
    });

    scoped.get("OPENAI_API_KEY");

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.agentId).toBe("agent-audit-test");
    expect(event.secretName).toBe("OPENAI_API_KEY");
    expect(event.outcome).toBe("success");
    expect(typeof event.timestamp).toBe("number");
    expect(event.timestamp).toBeGreaterThan(0);
  });
});

describe("security:warn for unrestricted access", () => {
  const baseSecrets = {
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: "ak-test",
  };

  it("emits security:warn on first access when allowPatterns is empty", () => {
    const base = createSecretManager(baseSecrets);
    const bus = new TypedEventBus();
    const warnEvents: EventMap["security:warn"][] = [];
    bus.on("security:warn", (e) => warnEvents.push(e));

    const scoped = createScopedSecretManager(base, {
      agentId: "agent-unrestricted",
      allowPatterns: [],
      eventBus: bus,
    });

    scoped.get("OPENAI_API_KEY");

    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]!.category).toBe("secret_access");
    expect(warnEvents[0]!.agentId).toBe("agent-unrestricted");
    expect(warnEvents[0]!.message).toContain("secrets.allow");
    expect(warnEvents[0]!.message).toContain("agent-unrestricted");
    expect(typeof warnEvents[0]!.timestamp).toBe("number");
  });

  it("emits security:warn only once (subsequent accesses do not re-emit)", () => {
    const base = createSecretManager(baseSecrets);
    const bus = new TypedEventBus();
    const warnEvents: EventMap["security:warn"][] = [];
    bus.on("security:warn", (e) => warnEvents.push(e));

    const scoped = createScopedSecretManager(base, {
      agentId: "agent-once",
      allowPatterns: [],
      eventBus: bus,
    });

    scoped.get("OPENAI_API_KEY");
    scoped.has("ANTHROPIC_API_KEY");
    scoped.require("OPENAI_API_KEY");

    expect(warnEvents).toHaveLength(1);
  });

  it("does NOT emit security:warn when allowPatterns is non-empty", () => {
    const base = createSecretManager(baseSecrets);
    const bus = new TypedEventBus();
    const warnEvents: EventMap["security:warn"][] = [];
    bus.on("security:warn", (e) => warnEvents.push(e));

    const scoped = createScopedSecretManager(base, {
      agentId: "agent-restricted",
      allowPatterns: ["OPENAI_*"],
      eventBus: bus,
    });

    scoped.get("OPENAI_API_KEY");

    expect(warnEvents).toHaveLength(0);
  });

  it("does NOT emit security:warn when no eventBus is provided", () => {
    const base = createSecretManager(baseSecrets);

    const scoped = createScopedSecretManager(base, {
      agentId: "agent-no-bus",
      allowPatterns: [],
      // eventBus intentionally omitted
    });

    // Should not throw
    expect(() => scoped.get("OPENAI_API_KEY")).not.toThrow();
  });
});
