// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for setup-gateway-api RPC method registration.
 * Verifies that registerRpcMethods registers all expected method groups
 * as passthroughs to rpcCall. Business logic tests for individual handlers
 * live in api/*.test.ts files; this file only tests registration wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { INTERNAL_FIELD_NAMES } from "@comis/core";
import { registerRpcMethods, type RpcMethodDeps } from "./setup-gateway-api.js";

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
    // NOTE: obs.diagnostics + obs.explain are now scopes:["rpc"] — agent
    // self-observability — so they register agent-reachable, NOT admin. The
    // DAEMON-WIDE/sensitive obs methods below stay admin.
    const obsMethods = [
      "obs.billing.byProvider", "obs.billing.byAgent",
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

    // Use obs.billing.total (a DAEMON-WIDE admin passthrough). NB: obs.diagnostics is no
    // longer admin (re-scoped to rpc), so it's no longer an admin passthrough.
    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "obs.billing.total");
    const handler = call![2];

    await handler({});

    expect(deps.rpcCall).toHaveBeenCalledWith("obs.billing.total", {
      _trustLevel: "admin",
    });
  });

  // -----------------------------------------------------------------------
  // Bridge methods
  // -----------------------------------------------------------------------

  it("registers session/cron bridge methods with rpc trust", () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    // cron.add joins the session-bridge passthrough list; the WEB-shape
    // transformer lives in cron-handlers.ts (no dispatcher special-cases).
    const bridgeMethods = [
      "session.send", "session.spawn", "session.status",
      "session.history", "session.search", "cron.list", "cron.add",
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
  // cron.add passthrough
  //
  // setup-gateway-api.ts registers cron.add as a plain rpc passthrough
  // (no transformation). The WEB-shape -> handler normalization lives in
  // the cron-handlers.ts handler body. Verified by the cron-handlers unit
  // test ("cron.add" suite, WEB-shape and legacy-flat-shape variants) and
  // by the gateway-rpc-sse integration test.
  // -----------------------------------------------------------------------

  it("cron.add is registered as a plain rpc passthrough (no transformation)", async () => {
    registerRpcMethods(deps);

    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "cron.add");
    expect(call).toBeDefined();
    expect(call![1]).toBe("rpc");
    const handler = call![2];

    // The dispatcher now forwards params unchanged — the cron-handlers body
    // is responsible for normalizing both WEB-shape (nested schedule +
    // message) and legacy flat-shape (schedule_kind + payload_text).
    const webShape = {
      name: "daily-check",
      message: "How are things?",
      agentId: "agent-1",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    };
    await handler(webShape);

    // cron.add is gated (orch:cron), so the gateway leg now injects the required
    // cap server-side; the user-shape params are otherwise unchanged.
    expect(deps.rpcCall).toHaveBeenCalledWith("cron.add", {
      ...webShape,
      _capabilities: ["orch:cron"],
    });
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
      // session.list/reset/compact are rpc (agent-self reads/lifecycle).
      // delete/export stay admin (in-handler admin check + arbitrary-session
      // targeting → deny-by-origin).
      "session.delete", "session.export",
      // memory.store is scoped rpc (agent-reachable — the memory_store tool
      // is the primary caller); asserted as rpc below.
      "memory.stats", "memory.browse", "memory.delete", "memory.flush", "memory.export",
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

  it("memory.store is registered as an rpc passthrough (agent-reachable; the memory_store tool's backing RPC)", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    const call = calls.find(([m]: [string]) => m === "memory.store");
    expect(call, "expected memory.store to be registered").toBeDefined();
    expect(call![1]).toBe("rpc");
  });

  it("session.list/reset/compact are registered as rpc passthroughs (agent-reachable self reads/lifecycle)", () => {
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    for (const name of ["session.list", "session.reset", "session.compact"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("rpc");
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

  it("skills.upload/import/delete are registered as rpc passthroughs (orch:skill surface)", () => {
    // Re-scoped admin→rpc so the deny-by-origin chokepoint no longer denies an
    // agent its own orch:skill grant. Admin gateway tokens carry rpc, so the
    // web-UI skills manager (which calls these) is unaffected.
    registerRpcMethods(deps);
    const calls = registerMethod.mock.calls;
    for (const name of ["skills.upload", "skills.import", "skills.delete"]) {
      const call = calls.find(([m]: [string]) => m === name);
      expect(call, `expected ${name} to be registered`).toBeDefined();
      expect(call![1]).toBe("rpc");
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

  // -----------------------------------------------------------------------
  // Strip INTERNAL_FIELD_NAMES at the external WS/REST boundary.
  //
  // An external rpc/admin-token holder can spread an `_agentId` (or any
  // `_X` control field) into params. The dispatcher must project those
  // away BEFORE re-injecting the trusted `_trustLevel` so that `_agentId`
  // PRESENCE becomes an unforgeable agent-origin signal (the prerequisite
  // that makes deny-by-origin sound).
  // -----------------------------------------------------------------------

  function handlerFor(method: string): (params: unknown) => Promise<unknown> {
    registerRpcMethods(deps);
    const call = registerMethod.mock.calls.find(([m]: [string]) => m === method);
    expect(call, `expected ${method} to be registered`).toBeDefined();
    return call![2] as (params: unknown) => Promise<unknown>;
  }

  it("admin branch strips a forged _agentId but re-injects _trustLevel and keeps user fields", async () => {
    // obs.billing.total is a DAEMON-WIDE admin method (obs.diagnostics is now rpc).
    const handler = handlerFor("obs.billing.total");

    await handler({ _agentId: "forged", marker: "keep" });

    const forwarded = (deps.rpcCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    // Forged origin field is stripped before dispatch.
    expect(forwarded).not.toHaveProperty("_agentId");
    // Trusted control field is re-injected (strip-then-inject ordering).
    expect(forwarded._trustLevel).toBe("admin");
    // Legitimate user field survives the strip.
    expect(forwarded.marker).toBe("keep");
  });

  it("rpc branch strips forged internal fields but keeps user fields", async () => {
    const handler = handlerFor("session.send");

    await handler({ _agentId: "forged", _capabilities: ["orch:spawn"], text: "hello" });

    const forwarded = (deps.rpcCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    // Forged agent-origin field is stripped on the non-admin path too.
    expect(forwarded).not.toHaveProperty("_agentId");
    // Legitimate user field survives.
    expect(forwarded.text).toBe("hello");
    // `_capabilities` is forward-correct: stripped iff it is an internal field.
    // Guarded by membership so this assertion holds whether or not
    // `_capabilities` is currently in INTERNAL_FIELD_NAMES.
    if ((INTERNAL_FIELD_NAMES as readonly string[]).includes("_capabilities")) {
      expect(forwarded).not.toHaveProperty("_capabilities");
    }
  });

  it("strips every INTERNAL_FIELD_NAMES entry forged by an external admin caller", async () => {
    const handler = handlerFor("obs.billing.total"); // admin (obs.diagnostics is now rpc)

    const forged: Record<string, unknown> = { marker: "keep" };
    for (const name of INTERNAL_FIELD_NAMES) {
      forged[name] = "forged";
    }
    await handler(forged);

    const forwarded = (deps.rpcCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    for (const name of INTERNAL_FIELD_NAMES) {
      if (name === "_trustLevel") continue; // re-injected by the admin branch
      expect(forwarded, `expected ${name} to be stripped`).not.toHaveProperty(name);
    }
    expect(forwarded._trustLevel).toBe("admin");
    expect(forwarded.marker).toBe("keep");
  });

  it("does not drop legitimate-only params (strip removes nothing it should not)", async () => {
    const handler = handlerFor("session.send");

    await handler({ text: "hello", foo: 1 });

    const forwarded = (deps.rpcCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(forwarded).toEqual({ text: "hello", foo: 1 });
  });

  // -----------------------------------------------------------------------
  // Capability-gated orchestration RPCs check the injected `_capabilities`.
  // Only the in-process agent leg injects that cap, so the gateway leg must
  // inject the method's REQUIRED orch cap server-side, after the strip —
  // otherwise every authenticated operator/dashboard call would hit
  // `Capability denied: orch:*`. A client cannot forge `_capabilities` — it is
  // a stripped internal field.
  // -----------------------------------------------------------------------

  it("injects the required orch cap for gated orchestration methods (least-privilege)", async () => {
    for (const [method, cap] of [
      ["graph.save", "orch:graph"],
      ["graph.execute", "orch:graph"],
      ["session.spawn", "orch:spawn"],
      ["skills.upload", "orch:skill"],
      ["cron.add", "orch:cron"],
    ] as const) {
      (deps.rpcCall as ReturnType<typeof vi.fn>).mockClear();
      const handler = handlerFor(method);
      await handler({ any: "param" });
      const forwarded = (deps.rpcCall as ReturnType<typeof vi.fn>).mock
        .calls[0]![1] as Record<string, unknown>;
      expect(forwarded._capabilities, `${method} → ${cap}`).toEqual([cap]);
    }
  });

  it("does NOT inject _capabilities for an ungated rpc method (session.send)", async () => {
    const handler = handlerFor("session.send");
    await handler({ text: "hi" });
    const forwarded = (deps.rpcCall as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("_capabilities");
  });
});
