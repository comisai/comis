/**
 * Tests for setup-gateway-rpc RPC method registration.
 * Verifies that registerRpcMethods registers all expected method groups
 * as passthroughs to rpcCall. Business logic tests for individual handlers
 * live in rpc/*.test.ts files; this file only tests registration wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerRpcMethods, type RpcMethodDeps } from "./setup-gateway-rpc.js";

describe("registerRpcMethods", () => {
  let deps: RpcMethodDeps;
  let registerMethod: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registerMethod = vi.fn();

    deps = {
      dynamicRouter: { registerMethod } as any,
      container: {
        config: {
          agents: { default: { name: "test" } },
          gateway: { enabled: true },
          channels: {},
          tenantId: "test",
          dataDir: "/data",
        },
        eventBus: { emit: vi.fn() },
        secretManager: { get: vi.fn() },
      } as any,
      configPaths: ["/etc/comis/config.yaml"],
      rpcCall: vi.fn(async () => ({ ok: true })),
    };
  });

  // -----------------------------------------------------------------------
  // Infrastructure methods (passthroughs)
  // -----------------------------------------------------------------------

  it("registers system.ping as rpc passthrough", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "system.ping");
    expect(call, "expected system.ping to be registered").toBeDefined();
    expect(call![1]).toBe("rpc");
  });

  it("registers infrastructure admin methods as passthroughs", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const infraMethods = [
      "config.read", "config.schema", "config.patch", "config.apply",
      "gateway.status", "gateway.restart", "daemon.setLogLevel",
    ];
    for (const name of infraMethods) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  // -----------------------------------------------------------------------
  // Observability methods
  // -----------------------------------------------------------------------

  it("registers all observability methods with admin trust", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const obsMethods = [
      "obs.diagnostics", "obs.billing.byProvider", "obs.billing.byAgent",
      "obs.billing.bySession", "obs.billing.total", "obs.billing.usage24h",
      "obs.channels.all", "obs.channels.stale", "obs.channels.get",
      "obs.delivery.recent", "obs.delivery.stats",
      "obs.reset", "obs.reset.table", "obs.getCacheStats",
      "agent.cacheStats", "memory.embeddingCache",
    ];
    for (const name of obsMethods) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  it("admin passthrough methods inject _trustLevel", async () => {
    registerRpcMethods(deps);

    // Find the obs.diagnostics handler (admin passthrough)
    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "obs.diagnostics");
    const handler = call![2];

    await handler({ category: "usage" });

    expect(deps.rpcCall).toHaveBeenCalledWith("obs.diagnostics", {
      category: "usage",
      _trustLevel: "admin",
    });
  });

  // -----------------------------------------------------------------------
  // Bridge methods
  // -----------------------------------------------------------------------

  it("registers session/cron bridge methods with rpc trust", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const bridgeMethods = [
      "session.send", "session.spawn", "session.status",
      "session.history", "session.search", "cron.list",
    ];
    for (const name of bridgeMethods) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("rpc");
    }
  });

  it("rpc passthrough methods delegate without _trustLevel", async () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "session.send");
    const handler = call![2];

    await handler({ text: "hello" });

    expect(deps.rpcCall).toHaveBeenCalledWith("session.send", { text: "hello" });
  });

  // -----------------------------------------------------------------------
  // cron.add param transformation (sole inline handler)
  // -----------------------------------------------------------------------

  it("cron.add transforms frontend CronJobInput to flat params", async () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "cron.add");
    expect(call).toBeDefined();
    expect(call![1]).toBe("rpc");
    const handler = call![2];

    await handler({
      name: "daily-check",
      message: "How are things?",
      agentId: "agent-1",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    });

    expect(deps.rpcCall).toHaveBeenCalledWith("cron.add", {
      name: "daily-check",
      schedule_kind: "cron",
      payload_kind: "agent_turn",
      payload_text: "How are things?",
      _agentId: "agent-1",
      schedule_expr: "0 9 * * *",
      timezone: "UTC",
      schedule_every_ms: undefined,
      schedule_at: undefined,
    });
  });

  it("cron.add defaults to cron schedule_kind", async () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const handler = calls.find(([m]: [string]) => m === "cron.add")![2];

    await handler({ name: "test", message: "ping", schedule: {} });

    expect(deps.rpcCall).toHaveBeenCalledWith("cron.add", expect.objectContaining({
      schedule_kind: "cron",
    }));
  });

  it("cron.add converts empty agentId string to undefined", async () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const handler = calls.find(([m]: [string]) => m === "cron.add")![2];

    await handler({ name: "test", agentId: "", message: "ping", schedule: {} });

    expect(deps.rpcCall).toHaveBeenCalledWith("cron.add", expect.objectContaining({
      _agentId: undefined,
    }));
  });

  // -----------------------------------------------------------------------
  // Browser bridge methods
  // -----------------------------------------------------------------------

  it("registers all 13 browser bridge methods with rpc trust", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const browserMethods = [
      "browser.status", "browser.start", "browser.stop", "browser.navigate",
      "browser.snapshot", "browser.screenshot", "browser.pdf", "browser.act",
      "browser.tabs", "browser.open", "browser.focus", "browser.close",
      "browser.console",
    ];
    for (const name of browserMethods) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("rpc");
    }
  });

  // -----------------------------------------------------------------------
  // Audio + media passthroughs
  // -----------------------------------------------------------------------

  it("registers audio.transcribe as rpc passthrough", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "audio.transcribe");
    expect(call).toBeDefined();
    expect(call![1]).toBe("rpc");
  });

  it("registers media test methods as admin passthroughs", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const mediaMethods = [
      "media.test.stt", "media.test.tts", "media.test.vision",
      "media.test.document", "media.test.video", "media.test.link",
      "media.providers",
    ];
    for (const name of mediaMethods) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  // -----------------------------------------------------------------------
  // Admin management methods
  // -----------------------------------------------------------------------

  it("registers admin management methods (approval, agent, session, memory, model, token, channel)", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const adminMethods = [
      "admin.approval.pending", "admin.approval.resolve", "admin.approval.clearDenialCache",
      "agents.create", "agents.get", "agents.update", "agents.delete", "agents.suspend", "agents.resume",
      "session.list", "session.delete", "session.reset", "session.export", "session.compact",
      "memory.stats", "memory.browse", "memory.delete", "memory.flush", "memory.export", "memory.store",
      "models.list", "models.test",
      "tokens.list", "tokens.create", "tokens.revoke", "tokens.rotate",
      "channels.list", "channels.get", "channels.enable", "channels.disable", "channels.restart",
    ];
    for (const name of adminMethods) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  // -----------------------------------------------------------------------
  // Skills passthroughs (handlers now in skill-handlers.ts via rpc-dispatch)
  // -----------------------------------------------------------------------

  it("registers skills.list as rpc passthrough", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "skills.list");
    expect(call).toBeDefined();
    expect(call![1]).toBe("rpc");
  });

  it("registers skills.upload/import/delete as admin passthroughs", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    for (const name of ["skills.upload", "skills.import", "skills.delete"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  // -----------------------------------------------------------------------
  // MCP, workspace, graph, heartbeat, config history passthroughs
  // -----------------------------------------------------------------------

  it("registers MCP methods as admin passthroughs", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    for (const name of ["mcp.list", "mcp.status", "mcp.connect", "mcp.disconnect", "mcp.reconnect", "mcp.test"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  it("registers heartbeat methods as admin passthroughs", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    for (const name of ["heartbeat.states", "heartbeat.get", "heartbeat.update", "heartbeat.trigger"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  it("registers workspace methods with correct trust scopes", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;

    // rpc-scoped workspace methods
    for (const name of ["workspace.status", "workspace.readFile", "workspace.listDir", "workspace.git.status"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered as rpc`).toBeDefined();
      expect(call![1]).toBe("rpc");
    }

    // admin-scoped workspace methods
    for (const name of ["workspace.writeFile", "workspace.deleteFile", "workspace.init", "workspace.git.commit"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered as admin`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  it("registers config history methods as admin passthroughs", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    for (const name of ["config.history", "config.diff", "config.rollback", "config.gc"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("admin");
    }
  });

  // -----------------------------------------------------------------------
  // Method coverage
  // -----------------------------------------------------------------------

  it("registers at least 90 methods total (comprehensive coverage)", () => {
    registerRpcMethods(deps);
    // Each registerMethod call registers one method
    expect(registerMethod.mock.calls.length).toBeGreaterThanOrEqual(90);
  });
});
