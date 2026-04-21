// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { RpcContext } from "./method-router.js";
import { createMethodRouter, createDynamicMethodRouter, createStubMethods } from "./method-router.js";

/** RPC context with full access */
const ADMIN_CTX: RpcContext = { clientId: "admin", scopes: ["*"] };

/** RPC context with rpc-only scope */
const RPC_CTX: RpcContext = { clientId: "client-a", scopes: ["rpc"] };

/** RPC context with no scopes */
const NO_SCOPE_CTX: RpcContext = { clientId: "client-b", scopes: [] };

describe("createMethodRouter", () => {
  const stubs = createStubMethods();
  const server = createMethodRouter(stubs);

  it("dispatches a registered method", async () => {
    const response = await server.receive(
      { jsonrpc: "2.0", method: "agent.execute", params: { query: "hello" }, id: 1 },
      RPC_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.result).toEqual({
      stub: true,
      method: "agent.execute",
      params: { query: "hello" },
    });
  });

  it("returns -32601 for unregistered method", async () => {
    const response = await server.receive(
      { jsonrpc: "2.0", method: "nonexistent.method", id: 2 },
      RPC_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32601);
  });

  it("rejects call when client lacks required scope", async () => {
    const response = await server.receive(
      { jsonrpc: "2.0", method: "config.get", params: {}, id: 3 },
      RPC_CTX, // has "rpc" scope, needs "admin"
    );

    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32603);
    expect(response!.error!.message).toContain("Insufficient scope");
  });

  it("allows wildcard scope for admin methods", async () => {
    const response = await server.receive(
      { jsonrpc: "2.0", method: "config.set", params: { key: "test" }, id: 4 },
      ADMIN_CTX, // has "*" wildcard scope
    );

    expect(response).not.toBeNull();
    expect(response!.result).toEqual({
      stub: true,
      method: "config.set",
      params: { key: "test" },
    });
  });

  it("rejects when client has empty scopes", async () => {
    const response = await server.receive(
      { jsonrpc: "2.0", method: "agent.execute", params: {}, id: 5 },
      NO_SCOPE_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32603);
  });

  it("dispatches memory.search with rpc scope", async () => {
    const response = await server.receive(
      { jsonrpc: "2.0", method: "memory.search", params: { query: "test" }, id: 6 },
      RPC_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.result).toEqual({
      stub: true,
      method: "memory.search",
      params: { query: "test" },
    });
  });
});

describe("createDynamicMethodRouter", () => {
  it("registers initial methods from RpcMethodMap", async () => {
    const router = createDynamicMethodRouter(createStubMethods());
    // Initial core methods should be registered
    expect(router.hasMethod("agent.execute")).toBe(true);
    expect(router.hasMethod("config.set")).toBe(true);
  });

  it("dispatches a dynamically registered method", async () => {
    const router = createDynamicMethodRouter(createStubMethods());

    router.registerMethod("cron.list", "rpc", () => ({ jobs: [] }));

    const response = await router.server.receive(
      { jsonrpc: "2.0", method: "cron.list", params: {}, id: 10 },
      RPC_CTX,
    );

    expect(response).not.toBeNull();
    expect(response!.result).toEqual({ jobs: [] });
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

describe("createStubMethods", () => {
  it("returns handlers for all 6 methods", () => {
    const stubs = createStubMethods();
    const names = Object.keys(stubs);

    expect(names).toHaveLength(6);
    expect(names).toContain("agent.execute");
    expect(names).toContain("agent.stream");
    expect(names).toContain("memory.search");
    expect(names).toContain("memory.inspect");
    expect(names).toContain("config.get");
    expect(names).toContain("config.set");
  });

  it("each stub returns method identification", () => {
    const stubs = createStubMethods();
    const result = stubs["agent.execute"]({ foo: "bar" }, ADMIN_CTX);
    expect(result).toEqual({
      stub: true,
      method: "agent.execute",
      params: { foo: "bar" },
    });
  });
});
