// SPDX-License-Identifier: Apache-2.0
/**
 * Security controller tests (Phase 44 / WEB-DECOMP-01 / Wave 7 / Task 2).
 *
 * Coverage: each RPC method (success + failure propagation) + addController
 * registration + lifecycle no-op. Pattern matches pipeline-monitor-
 * controller.test.ts (Wave 6 reference).
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createSecurityController } from "./security-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("SecurityController", () => {
  it("readConfig: forwards 'config.read' RPC + returns config + sections", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        config: { security: { logRedaction: true, auditLog: false } },
        sections: ["security", "channels", "models"],
      };
    });
    const controller = createSecurityController(host, rpc);
    const result = await controller.readConfig();
    expect((seen[0] as unknown[])[0]).toBe("config.read");
    expect(result.config.security?.logRedaction).toBe(true);
    expect(result.sections).toEqual(["security", "channels", "models"]);
  });

  it("patchConfig: forwards 'config.patch' RPC with section/key/value", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { ok: true };
    });
    const controller = createSecurityController(host, rpc);
    await controller.patchConfig("security", "secrets", { enabled: true });
    expect((seen[0] as unknown[])[0]).toBe("config.patch");
    expect((seen[0] as unknown[])[1]).toEqual({
      section: "security",
      key: "secrets",
      value: { enabled: true },
    });
  });

  it("patchConfig: passes undefined key for section-only writes", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { ok: true };
    });
    const controller = createSecurityController(host, rpc);
    await controller.patchConfig("security", undefined, { logRedaction: false });
    expect((seen[0] as unknown[])[1]).toEqual({
      section: "security",
      key: undefined,
      value: { logRedaction: false },
    });
  });

  it("getProviderCacheStats: forwards 'agent.cacheStats' RPC + returns providers list", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        providers: [
          {
            provider: "anthropic",
            model: "claude-opus",
            callCount: 100,
            totalCost: 5.5,
            totalCacheSaved: 1.5,
            cacheHitRate: 0.25,
          },
        ],
        totalCacheSaved: 1.5,
      };
    });
    const controller = createSecurityController(host, rpc);
    const result = await controller.getProviderCacheStats();
    expect((seen[0] as unknown[])[0]).toBe("agent.cacheStats");
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider).toBe("anthropic");
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon offline");
    });
    const controller = createSecurityController(host, rpc);
    await expect(controller.readConfig()).rejects.toThrow("daemon offline");
    await expect(controller.patchConfig("s", "k", "v")).rejects.toThrow("daemon offline");
    await expect(controller.getProviderCacheStats()).rejects.toThrow("daemon offline");
  });

  it("hostConnected / hostDisconnected: are no-ops (view manages its own lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSecurityController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createSecurityController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
