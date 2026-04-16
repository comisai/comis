/**
 * Security Infrastructure Integration Tests
 *
 * Non-daemon integration tests verifying cross-layer composition of Comis's
 * security infrastructure:
 * - SEC-INF-01: SafePath traversal guard with real filesystem
 * - SEC-INF-03: SSRF guard DNS-pinned URL validation
 * - SEC-INF-04: Plugin registry security model
 *
 * Note: SEC-INF-02 (V8 sandbox resource limits) was removed -- code skills
 * and the V8 sandbox were deleted in Phase 213.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  safePath,
  PathTraversalError,
  validateUrl,
  createPluginRegistry,
  TypedEventBus,
} from "@comis/core";
import type { PluginPort } from "@comis/core";
import { ok } from "@comis/shared";
import { z } from "zod";

// =============================================================================
// SEC-INF-01: SafePath Traversal Guard with Real Filesystem
// =============================================================================

describe("SEC-INF-01: SafePath Traversal Guard", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "comis-safepath-"));
  const baseDir = join(tempRoot, "base");

  // Create base directory and a valid file inside it
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, "valid.txt"), "test content");

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("blocks ../ directory traversal", () => {
    expect(() => safePath(baseDir, "../escape.txt")).toThrow(
      PathTraversalError,
    );
  });

  it("blocks URL-encoded traversal %2e%2e%2f", () => {
    expect(() => safePath(baseDir, "%2e%2e%2fescape.txt")).toThrow(
      PathTraversalError,
    );
  });

  it("blocks null byte injection", () => {
    expect(() => safePath(baseDir, "file\0.txt")).toThrow(PathTraversalError);
  });

  it("allows valid relative paths within base directory", () => {
    const resolved = safePath(baseDir, "valid.txt");
    expect(resolved).toBe(join(baseDir, "valid.txt"));
  });

  it("blocks absolute path escape", () => {
    expect(() => safePath(baseDir, "/etc/passwd")).toThrow(PathTraversalError);
  });
});

// =============================================================================
// SEC-INF-03: SSRF Guard URL Validation
// =============================================================================

describe("SEC-INF-03: SSRF Guard URL Validation", () => {
  it("blocks loopback address http://127.0.0.1/secret", async () => {
    const result = await validateUrl("http://127.0.0.1/secret");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain("loopback");
    }
  });

  it("blocks private range http://10.0.0.1/internal", async () => {
    const result = await validateUrl("http://10.0.0.1/internal");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain("private");
    }
  });

  it("blocks cloud metadata http://169.254.169.254/latest/meta-data", async () => {
    const result = await validateUrl(
      "http://169.254.169.254/latest/meta-data",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.error.message.toLowerCase().includes("cloud metadata") ||
          result.error.message.toLowerCase().includes("blocked"),
      ).toBe(true);
    }
  });

  it("blocks non-HTTP protocol ftp://example.com/file", async () => {
    const result = await validateUrl("ftp://example.com/file");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain("protocol");
    }
  });
});

// =============================================================================
// SEC-INF-04: Plugin Registry Security Model
// =============================================================================

describe("SEC-INF-04: Plugin Registry Security Model", () => {
  it("emits plugin:registered event on TypedEventBus with correct pluginId and hookCount", () => {
    const eventBus = new TypedEventBus();
    const registry = createPluginRegistry({ eventBus });

    let receivedEvent: {
      pluginId: string;
      pluginName: string;
      hookCount: number;
      timestamp: number;
    } | null = null;

    eventBus.on("plugin:registered", (payload) => {
      receivedEvent = payload;
    });

    const testPlugin: PluginPort = {
      id: "test-plugin-event",
      name: "Test Plugin Event",
      version: "1.0.0",
      register(api) {
        api.registerHook("before_agent_start", async () => undefined);
        api.registerHook("agent_end", async () => undefined);
        return ok(undefined);
      },
    };

    const result = registry.register(testPlugin);
    expect(result.ok).toBe(true);
    expect(receivedEvent).not.toBeNull();
    expect(receivedEvent!.pluginId).toBe("test-plugin-event");
    expect(receivedEvent!.pluginName).toBe("Test Plugin Event");
    expect(receivedEvent!.hookCount).toBe(2);
    expect(receivedEvent!.timestamp).toBeGreaterThan(0);
  });

  it("stores Zod config schema via registerConfigSchema, retrievable via getRegisteredConfigSchemas()", () => {
    const registry = createPluginRegistry();

    const configSchema = z.object({
      endpoint: z.string().url(),
      retries: z.number().int().positive(),
    });

    const testPlugin: PluginPort = {
      id: "config-schema-plugin",
      name: "Config Schema Plugin",
      version: "1.0.0",
      register(api) {
        api.registerConfigSchema("myPlugin", configSchema);
        return ok(undefined);
      },
    };

    const result = registry.register(testPlugin);
    expect(result.ok).toBe(true);

    const schemas = registry.getRegisteredConfigSchemas();
    expect(schemas.has("myPlugin")).toBe(true);

    // Validate that the stored schema works correctly
    const validParse = schemas.get("myPlugin")!.safeParse({
      endpoint: "https://example.com",
      retries: 3,
    });
    expect(validParse.success).toBe(true);

    const invalidParse = schemas.get("myPlugin")!.safeParse({
      endpoint: "not-a-url",
      retries: -1,
    });
    expect(invalidParse.success).toBe(false);
  });

  it("returns err Result for duplicate plugin registration", () => {
    const registry = createPluginRegistry();

    const testPlugin: PluginPort = {
      id: "duplicate-plugin",
      name: "Duplicate Plugin",
      version: "1.0.0",
      register() {
        return ok(undefined);
      },
    };

    const first = registry.register(testPlugin);
    expect(first.ok).toBe(true);

    const second = registry.register(testPlugin);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.message).toContain("already registered");
    }
  });

  it("returns hooks sorted by priority descending from getHooksByName", () => {
    const registry = createPluginRegistry();

    const lowPriorityPlugin: PluginPort = {
      id: "low-priority-plugin",
      name: "Low Priority Plugin",
      version: "1.0.0",
      register(api) {
        api.registerHook("before_agent_start", async () => undefined, {
          priority: 10,
        });
        return ok(undefined);
      },
    };

    const highPriorityPlugin: PluginPort = {
      id: "high-priority-plugin",
      name: "High Priority Plugin",
      version: "1.0.0",
      register(api) {
        api.registerHook("before_agent_start", async () => undefined, {
          priority: 50,
        });
        return ok(undefined);
      },
    };

    // Register low priority first, then high priority
    registry.register(lowPriorityPlugin);
    registry.register(highPriorityPlugin);

    const hooks = registry.getHooksByName("before_agent_start");
    expect(hooks.length).toBe(2);
    // Higher priority (50) should be first, lower (10) second
    expect(hooks[0]!.priority).toBe(50);
    expect(hooks[0]!.pluginId).toBe("high-priority-plugin");
    expect(hooks[1]!.priority).toBe(10);
    expect(hooks[1]!.pluginId).toBe("low-priority-plugin");
  });

  it("returns err for plugin with invalid (empty string) id", () => {
    const registry = createPluginRegistry();

    const invalidPlugin: PluginPort = {
      id: "",
      name: "Invalid Plugin",
      version: "1.0.0",
      register() {
        return ok(undefined);
      },
    };

    const result = registry.register(invalidPlugin);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-empty");
    }
  });
});
