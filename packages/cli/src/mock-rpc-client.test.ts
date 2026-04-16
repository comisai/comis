/**
 * Tests for the mock RPC client builder.
 *
 * Verifies all four response modes (success, error, timeout, disconnect),
 * unconfigured method handling, multi-method configuration, close() safety,
 * and the withMockClient convenience wrapper.
 */

import { describe, it, expect } from "vitest";
import {
  createMockRpcClient,
  withMockClient,
} from "./mock-rpc-client.js";

describe("MockRpcClientBuilder", () => {
  describe("success mode", () => {
    it("resolves with configured response for a method", async () => {
      const client = createMockRpcClient()
        .onCall("config.get", { agents: {} })
        .build();

      const result = await client.call("config.get");
      expect(result).toEqual({ agents: {} });
    });

    it("returns undefined when configured with undefined", async () => {
      const client = createMockRpcClient()
        .onCall("void.method", undefined)
        .build();

      const result = await client.call("void.method");
      expect(result).toBeUndefined();
    });
  });

  describe("error mode", () => {
    it("rejects with configured error message", async () => {
      const client = createMockRpcClient()
        .onError("config.get", "Permission denied")
        .build();

      await expect(client.call("config.get")).rejects.toThrow(
        "Permission denied",
      );
    });
  });

  describe("timeout mode", () => {
    it("rejects after configured delay with timeout message", async () => {
      const client = createMockRpcClient()
        .onTimeout("config.get", 50)
        .build();

      const start = Date.now();
      await expect(client.call("config.get")).rejects.toThrow(
        "Connection to daemon timed out",
      );
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  describe("disconnect mode", () => {
    it("rejects all calls with connection closed error", async () => {
      const client = createMockRpcClient()
        .onDisconnect()
        .build();

      await expect(client.call("any.method")).rejects.toThrow(
        "Connection closed unexpectedly",
      );
    });

    it("rejects even configured methods when disconnected", async () => {
      const client = createMockRpcClient()
        .onCall("config.get", { data: true })
        .onDisconnect()
        .build();

      await expect(client.call("config.get")).rejects.toThrow(
        "Connection closed unexpectedly",
      );
    });
  });

  describe("unconfigured method", () => {
    it("rejects with descriptive error for unconfigured method", async () => {
      const client = createMockRpcClient().build();

      await expect(client.call("unknown.method")).rejects.toThrow(
        "Unexpected RPC call: unknown.method",
      );
    });
  });

  describe("multiple methods", () => {
    it("supports different responses for different methods", async () => {
      const client = createMockRpcClient()
        .onCall("agent.list", [{ name: "bot-1" }])
        .onError("agent.delete", "Not found")
        .onCall("config.get", { debug: false })
        .build();

      const agents = await client.call("agent.list");
      expect(agents).toEqual([{ name: "bot-1" }]);

      await expect(client.call("agent.delete")).rejects.toThrow("Not found");

      const config = await client.call("config.get");
      expect(config).toEqual({ debug: false });
    });
  });

  describe("close()", () => {
    it("does not throw", () => {
      const client = createMockRpcClient().build();
      expect(() => client.close()).not.toThrow();
    });

    it("can be called multiple times safely", () => {
      const client = createMockRpcClient().build();
      client.close();
      client.close();
      client.close();
    });
  });

  describe("builder chaining", () => {
    it("supports fluent chaining of all configuration methods", () => {
      const builder = createMockRpcClient()
        .onCall("a", 1)
        .onError("b", "err")
        .onTimeout("c", 100)
        .onDisconnect();

      // If chaining works, build() should not throw
      expect(() => builder.build()).not.toThrow();
    });
  });
});

describe("withMockClient", () => {
  it("passes built client to the callback function", async () => {
    const builder = createMockRpcClient()
      .onCall("config.get", { version: "1.0" });

    const run = withMockClient(builder);
    const result = await run(async (client) => {
      return await client.call("config.get");
    });

    expect(result).toEqual({ version: "1.0" });
  });

  it("propagates errors from the mock client", async () => {
    const builder = createMockRpcClient()
      .onError("agent.delete", "Forbidden");

    const run = withMockClient(builder);

    await expect(
      run(async (client) => {
        return await client.call("agent.delete");
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("returns callback result", async () => {
    const builder = createMockRpcClient()
      .onCall("agent.list", [{ name: "a" }, { name: "b" }]);

    const run = withMockClient(builder);
    const count = await run(async (client) => {
      const agents = (await client.call("agent.list")) as Array<{ name: string }>;
      return agents.length;
    });

    expect(count).toBe(2);
  });
});
