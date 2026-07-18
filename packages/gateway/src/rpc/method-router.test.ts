// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { runWithContext } from "@comis/core";
import type { RpcContext, RpcMethodMap, RpcMethodName } from "./method-router.js";
import { createDynamicMethodRouter } from "./method-router.js";

/** RPC context with full access */
const ADMIN_CTX: RpcContext = { clientId: "admin", scopes: ["*"] };

/** RPC context with rpc-only scope */
const RPC_CTX: RpcContext = { clientId: "client-a", scopes: ["rpc"] };

/**
 * Build a minimal RpcMethodMap for a test. Seeds only the methods the test
 * actually exercises so we do not re-introduce the dead `createStubMethods`
 * shape via the back door.
 */
function makeInlineStubs(methods: readonly RpcMethodName[]): RpcMethodMap {
  const map: RpcMethodMap = {};
  for (const name of methods) {
    map[name] = (params) => ({ stub: true, method: name, params });
  }
  return map;
}

describe("createDynamicMethodRouter", () => {
  it("registers initial methods from RpcMethodMap", async () => {
    const router = createDynamicMethodRouter(
      makeInlineStubs(["agent.execute", "config.set"]),
    );
    // Initial core methods should be registered
    expect(router.hasMethod("agent.execute")).toBe(true);
    expect(router.hasMethod("config.set")).toBe(true);
  });

  it("dispatches a dynamically registered method", async () => {
    const router = createDynamicMethodRouter(
      makeInlineStubs(["agent.execute"]),
    );

    router.registerMethod("cron.list", "rpc", () => ({ jobs: [] }));

    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "cron.list", params: {}, id: 10 },
      RPC_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.result).toEqual({ jobs: [] });
  });

  it("enforces scope on initial core methods (config.set requires admin)", async () => {
    const router = createDynamicMethodRouter(
      makeInlineStubs(["config.set"]),
    );
    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "config.set", params: { key: "test" }, id: 1 },
      RPC_CTX, // has "rpc", needs "admin"
    );
    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32603);
    expect(response!.error!.message).toContain("Insufficient scope");
  });

  it("allows wildcard scope (admin) to call admin-only initial methods", async () => {
    const router = createDynamicMethodRouter(
      makeInlineStubs(["config.set"]),
    );
    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "config.set", params: { key: "test" }, id: 2 },
      ADMIN_CTX,
    );
    expect(response).not.toBeNull();
    expect(response!.result).toEqual({
      stub: true,
      method: "config.set",
      params: { key: "test" },
    });
  });

  it("dispatches initial method with matching scope", async () => {
    const router = createDynamicMethodRouter(
      makeInlineStubs(["memory.search"]),
    );
    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "memory.search", params: { query: "test" }, id: 3 },
      RPC_CTX,
    );
    expect(response).not.toBeNull();
    expect(response!.result).toEqual({
      stub: true,
      method: "memory.search",
      params: { query: "test" },
    });
  });

  it("enforces namespace prefix on new methods", () => {
    const router = createDynamicMethodRouter();

    expect(() => {
      router.registerMethod("nonamespace", "rpc", () => ({}));
    }).toThrow("namespace prefix");
  });

  it("rejects registration without namespace dot", () => {
    const router = createDynamicMethodRouter();

    expect(() => {
      router.registerMethod("flatname", "rpc", () => ({}));
    }).toThrow("Method name must use namespace prefix");
    expect(() => {
      router.registerMethod("flatname", "rpc", () => ({}));
    }).toThrow("got: flatname");
  });

  it("allows core methods without namespace prefix", () => {
    const router = createDynamicMethodRouter();
    // Core methods like "agent.execute" already have dots, but the point is
    // they are exempted from the namespace validation check entirely.
    // Registering them directly (not via initial methods) should work.
    expect(() => {
      router.registerMethod("agent.execute", "rpc", () => ({}));
    }).not.toThrow();
  });

  it("rejects duplicate method registration", () => {
    const router = createDynamicMethodRouter();

    router.registerMethod("cron.status", "rpc", () => ({}));

    expect(() => {
      router.registerMethod("cron.status", "rpc", () => ({}));
    }).toThrow("already registered");
  });

  it("enforces scope on dynamically registered methods", async () => {
    const router = createDynamicMethodRouter();

    router.registerMethod("admin.restart", "admin", () => ({ restarted: true }));

    // Call with RPC_CTX which has scopes: ["rpc"] — should fail
    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "admin.restart", params: {}, id: 11 },
      RPC_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32603);
    expect(response!.error!.message).toContain("Insufficient scope");
  });

  it("hasMethod returns true for registered, false for unregistered", () => {
    const router = createDynamicMethodRouter();

    router.registerMethod("cron.list", "rpc", () => ({}));

    expect(router.hasMethod("cron.list")).toBe(true);
    expect(router.hasMethod("cron.nonexistent")).toBe(false);
  });

  it("returns -32601 for unregistered method call", async () => {
    const router = createDynamicMethodRouter();

    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "nonexistent.method", id: 12 },
      RPC_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32601);
  });
});

// ---------------------------------------------------------------------------
// trace wrapper + error classifier branch coverage
// ---------------------------------------------------------------------------

describe("createDynamicMethodRouter trace logging", () => {
  // Minimal MethodRouterLogger stub (any args, any return)
  function makeLogger() {
    const debug = (...args: unknown[]): void => { calls.debug.push(args); };
    const warn = (...args: unknown[]): void => { calls.warn.push(args); };
    const error = (...args: unknown[]): void => { calls.error.push(args); };
    const calls: { debug: unknown[][]; warn: unknown[][]; error: unknown[][] } = { debug: [], warn: [], error: [] };
    return { logger: { debug, warn, error }, calls };
  }

  it("emits debug RPC-call-start and RPC-call-completed entries on a successful traced method invocation", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.traced", "rpc", () => ({ ok: true }));
    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "cron.traced", params: {}, id: 100 },
      RPC_CTX,
    );
    expect(response!.result).toEqual({ ok: true });
    expect(calls.debug.length).toBeGreaterThanOrEqual(2);
  });

  it("emits error-level log entry when traced handler throws an unclassified error message", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.boom", "rpc", () => { throw new Error("generic explosion"); });
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.boom", params: {}, id: 101 },
      RPC_CTX,
    );
    // Handler error -> classified as "internal" -> error logger
    expect(calls.error.length).toBe(1);
  });

  it("returns a stable public error and keeps the private exception out of gateway logs", async () => {
    const { logger, calls } = makeLogger();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = createDynamicMethodRouter(undefined, logger);
    const privateMessage = "Failed to read /Users/operator/.comis/secrets.db";
    router.registerMethod("cron.privatefailure", "rpc", () => {
      throw new Error(privateMessage);
    });

    const traceId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const response = await runWithContext(
      {
        tenantId: "default",
        traceId,
        startedAt: 1,
        trustLevel: "admin",
      },
      () => router.server.receive(
        { jsonrpc: "2.0", method: "cron.privatefailure", params: {}, id: 107 },
        RPC_CTX,
      ),
    );

    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.message).toBe("Internal server error");
    expect(response!.error!.message).not.toContain(privateMessage);
    expect(response!.error!.data).toEqual({ traceId });
    expect(JSON.stringify(calls.error)).not.toContain(privateMessage);
    expect(calls.error[0]![0]).toEqual(expect.objectContaining({
      errorName: "UnhandledError",
      parameterCount: 0,
    }));
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("classifies immutable-config errors as config errorKind and emits warn-level log entry", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.immutable", "rpc", () => { throw new Error("This key is immutable"); });
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.immutable", params: {}, id: 102 },
      RPC_CTX,
    );
    expect(calls.warn.length).toBe(1);
    const logged = calls.warn[0]![0] as { errorKind: string; hint: string };
    expect(logged.errorKind).toBe("config");
    expect(logged.hint).toMatch(/requires daemon restart/i);
  });

  it("classifies Admin-access errors as auth errorKind and emits warn-level log entry", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.authz", "rpc", () => { throw new Error("Admin access required"); });
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.authz", params: {}, id: 103 },
      RPC_CTX,
    );
    expect(calls.warn.length).toBe(1);
    expect((calls.warn[0]![0] as { errorKind: string }).errorKind).toBe("auth");
  });

  it("logs an admin-trust denial on a read-only obs method at DEBUG, not WARN (the CLI probe-then-offline-fallback flow)", async () => {
    // `comis explain` / `comis system-health` hit the admin-gated obs.explain /
    // obs.system.health RPC, then fall back to offline assembly from the local
    // data dir. The daemon-side denial is a ROUTINE operator flow — logging it
    // WARN spams the very log the operator is reviewing (live incident).
    for (const method of ["obs.explain", "obs.system.health"]) {
      const { logger, calls } = makeLogger();
      const router = createDynamicMethodRouter(undefined, logger);
      router.registerMethod(method, "rpc", () => {
        throw new Error(`Admin access required for ${method}`);
      });
      await router.server.receive(
        { jsonrpc: "2.0", method, params: {}, id: 111 },
        RPC_CTX,
      );
      // The auth denial is logged, but at debug (routine), never warn.
      expect(calls.warn.length, `${method} should not warn`).toBe(0);
      const denyDebug = calls.debug.find(
        (c) => (c[0] as { errorKind?: string })?.errorKind === "auth",
      );
      expect(denyDebug, `${method} should log the auth denial at debug`).toBeDefined();
    }
  });

  it("still WARNs an admin-trust denial on a non-obs method (only the offline-fallback obs reads are quieted)", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("agents.create", "rpc", () => { throw new Error("Admin access required"); });
    await router.server.receive(
      { jsonrpc: "2.0", method: "agents.create", params: {}, id: 112 },
      RPC_CTX,
    );
    expect(calls.warn.length).toBe(1);
    expect((calls.warn[0]![0] as { errorKind: string }).errorKind).toBe("auth");
  });

  it("logs a typed refusal by class without its message or stack", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.denied", "rpc", () => {
      const e = new Error("Admin access required for obs.explain");
      e.name = "AuthorizationError";
      throw e;
    });
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.denied", params: {}, id: 105 },
      RPC_CTX,
    );
    expect(calls.warn.length).toBe(1);
    const logged = calls.warn[0]![0] as Record<string, unknown>;
    expect(logged.errorKind).toBe("auth");
    expect(logged.errorName).toBe("AuthorizationError");
    expect(logged).not.toHaveProperty("err");
    expect(JSON.stringify(logged)).not.toContain("Admin access required");
  });

  it("classifies not-found errors as validation errorKind and emits warn-level log entry", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.missing", "rpc", () => { throw new Error("Resource not found in db"); });
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.missing", params: {}, id: 104 },
      RPC_CTX,
    );
    expect(calls.warn.length).toBe(1);
    expect((calls.warn[0]![0] as { errorKind: string }).errorKind).toBe("validation");
  });

  it("classifies Invalid-prefixed errors as validation errorKind and emits warn-level log entry", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.invalid", "rpc", () => { throw new Error("Invalid input shape"); });
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.invalid", params: {}, id: 105 },
      RPC_CTX,
    );
    expect(calls.warn.length).toBe(1);
    expect((calls.warn[0]![0] as { errorKind: string }).errorKind).toBe("validation");
  });

  // ---------------------------------------------------------------------------
  // Typed-refusal classification at the GATEWAY trace wrapper.
  //
  // This trace wrapper is a SECOND, independent error classifier (separate from
  // rpc-dispatch's classifyRpcError). Without recognizing them here, a typed
  // PreconditionError / SandboxDowngradeError — an intentional policy/security
  // refusal — is logged at error(50), so a `logscan --level 50,60` surfaces it
  // as an ERROR (module:gateway, "RPC call failed: <method>") rather than a warn.
  //
  // The typed errors propagate up to this wrapper with their `.name` intact; this
  // package cannot `instanceof` the daemon/@comis/agent classes (dep direction), so
  // it must recognize them by the stable `.name`. The messages below are the EXACT
  // runtime shapes and match NONE of the substring branches, so they must be
  // classified by `.name`.
  // ---------------------------------------------------------------------------
  it("classifies a typed PreconditionError (by .name) as precondition/warn — not internal/error(50)", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("graph.fromintentgate", "rpc", () => {
      // The from_intent gated-off refusal (graph-mutate.ts) — a caller precondition,
      // NOT an internal handler fault. Message matches no substring branch.
      const e = new Error("from_intent authoring is disabled by policy (orchestration.authoring.intentAction).");
      e.name = "PreconditionError";
      throw e;
    });
    await router.server.receive(
      { jsonrpc: "2.0", method: "graph.fromintentgate", params: {}, id: 120 },
      RPC_CTX,
    );
    expect(calls.error.length).toBe(0); // must NOT log error(50) — a health sweep counts it
    expect(calls.warn.length).toBe(1);
    expect((calls.warn[0]![0] as { errorKind: string }).errorKind).toBe("precondition");
  });

  it("classifies a typed SandboxDowngradeError (by .name) as precondition/warn — not internal/error(50)", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("session.spawndowngrade", "rpc", () => {
      // The P0-C sandbox no-downgrade spawn refusal (sub-agent-runner.ts) — a
      // fail-closed SECURITY refusal, NOT an internal handler fault.
      const e = new Error('Spawn refused: child "loose" sandbox posture is less confined than parent "default" on: exec.');
      e.name = "SandboxDowngradeError";
      throw e;
    });
    await router.server.receive(
      { jsonrpc: "2.0", method: "session.spawndowngrade", params: {}, id: 121 },
      RPC_CTX,
    );
    expect(calls.error.length).toBe(0); // must NOT log error(50)
    expect(calls.warn.length).toBe(1);
    expect((calls.warn[0]![0] as { errorKind: string }).errorKind).toBe("precondition");
  });

  it("does not include a long handler error message in the log hint", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    const longMessage = "x".repeat(200);
    router.registerMethod("cron.long", "rpc", () => { throw new Error(longMessage); });
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.long", params: {}, id: 106 },
      RPC_CTX,
    );
    expect(calls.error.length).toBe(1);
    const payload = calls.error[0]![0] as { hint: string };
    expect(payload.hint.length).toBeLessThan(180);
    expect(JSON.stringify(payload)).not.toContain(longMessage);
  });

  it("skips trace wrapper for SUPPRESS_LOG_METHODS to avoid noise on polling endpoints", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("system.ping", "rpc", () => ({ ok: true }));
    await router.server.receive(
      { jsonrpc: "2.0", method: "system.ping", params: {}, id: 107 },
      RPC_CTX,
    );
    // No trace-start or trace-end debug log should be emitted for a SUPPRESS method
    const tracedDebug = calls.debug.filter((args) => {
      const first = args[0] as { method?: string };
      return first?.method === "system.ping";
    });
    expect(tracedDebug).toHaveLength(0);
  });

  it("logs successful initial-method invocation through trace wrapper when logger is provided", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(
      makeInlineStubs(["agent.execute"]),
      logger,
    );
    await router.server.receive(
      { jsonrpc: "2.0", method: "agent.execute", params: { x: 1 }, id: 200 },
      RPC_CTX,
    );
    expect(calls.debug.length).toBeGreaterThanOrEqual(2);
  });

  it("includes connectionId in trace logs when context carries a connectionId field", async () => {
    const { logger, calls } = makeLogger();
    const router = createDynamicMethodRouter(undefined, logger);
    router.registerMethod("cron.with-conn", "rpc", () => ({ ok: true }));
    await router.server.receive(
      { jsonrpc: "2.0", method: "cron.with-conn", params: {}, id: 108 },
      { clientId: "c", scopes: ["rpc"], connectionId: "conn-abc" },
    );
    const first = calls.debug[0]![0] as { connectionId?: string };
    expect(first.connectionId).toBe("conn-abc");
  });
});
