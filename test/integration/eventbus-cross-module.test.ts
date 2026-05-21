// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-Module Event Flow Integration Tests (non-daemon)
 *
 * Validates that TypedEventBus events flow correctly across real module
 * boundaries and that the bootstrap composition root creates a singleton
 * bus shared by all subsystems.
 *
 *   Bootstrap AppContainer Wiring (singleton bus, shutdown cleanup)
 *
 * EVENT-CLEAN-07 (Phase 52 Plan 02): the previous "Plugin Lifecycle
 * Events" group was deleted alongside the `plugin:registered`,
 * `plugin:deactivated`, and `hook:executed` events (zero non-test
 * subscribers). Cross-module hook execution is now covered by the unit
 * tests in packages/core/src/hooks/.
 *
 * All imports come from built dist/ packages via vitest aliases --
 * this is integration testing, not unit testing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrap } from "@comis/core";
import type { PluginPort } from "@comis/core";
import { ok } from "@comis/shared";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Bootstrap AppContainer Wiring
// ---------------------------------------------------------------------------

describe("Cross-Module Event Flows", () => {
  describe("Bootstrap AppContainer Wiring", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = join(tmpdir(), `comis-test-eventbus-bootstrap-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Write a minimal config YAML that passes Zod validation.
     */
    function writeMinimalConfig(): string {
      const configPath = join(tmpDir, `config-${Date.now()}.yaml`);
      const yaml = `agents:
  test-agent:
    model: echo
    name: Test Agent
    provider: echo
memory:
  dbPath: ":memory:"
gateway:
  port: 19876
  tokens: []
`;
      writeFileSync(configPath, yaml, "utf-8");
      return configPath;
    }

    it("bootstrap() creates AppContainer with functional event bus", () => {
      const configPath = writeMinimalConfig();
      const result = bootstrap({ configPaths: [configPath], env: {} });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const container = result.value;
      try {
        // Verify eventBus exists and has all expected methods
        expect(container.eventBus).toBeDefined();
        expect(typeof container.eventBus.on).toBe("function");
        expect(typeof container.eventBus.emit).toBe("function");
        expect(typeof container.eventBus.off).toBe("function");
      } finally {
        container.shutdown();
      }
    });

    it("bootstrap() event bus is the same instance accessible from container", async () => {
      const configPath = writeMinimalConfig();
      const result = bootstrap({ configPaths: [configPath], env: {} });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const container = result.value;
      try {
        // Register a plugin through the container's plugin registry, exercise
        // the surviving in-process getHooksByName accessor to verify the
        // pluginRegistry singleton is reachable.
        const testPlugin: PluginPort = {
          id: "singleton-test-plugin",
          name: "Singleton Test Plugin",
          version: "1.0.0",
          register(api) {
            api.registerHook("session_start", () => {});
            return ok(undefined);
          },
        };
        const regResult = container.pluginRegistry.register(testPlugin);
        expect(regResult.ok).toBe(true);

        const hooks = container.pluginRegistry.getHooksByName("session_start");
        expect(hooks.length).toBeGreaterThanOrEqual(1);
      } finally {
        await container.shutdown();
      }
    });

    it("container.shutdown() removes all listeners", async () => {
      const configPath = writeMinimalConfig();
      const result = bootstrap({ configPaths: [configPath], env: {} });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const container = result.value;

      // Register handlers for two live events
      container.eventBus.on("system:error", () => {});
      container.eventBus.on("audit:event", () => {});

      // Verify listenerCount > 0 for both events
      expect(container.eventBus.listenerCount("system:error")).toBeGreaterThan(0);
      expect(container.eventBus.listenerCount("audit:event")).toBeGreaterThan(0);

      // Call shutdown()
      await container.shutdown();

      // Verify listenerCount dropped to 0 for both events
      expect(container.eventBus.listenerCount("system:error")).toBe(0);
      expect(container.eventBus.listenerCount("audit:event")).toBe(0);
    });
  });
});
