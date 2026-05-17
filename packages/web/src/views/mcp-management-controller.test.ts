// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createMcpManagementController } from "./mcp-management-controller.js";

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

describe("McpManagementController", () => {
  it("listServers: invokes mcp.list with no params + returns servers array", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        servers: [
          { name: "fs", status: "connected", toolCount: 3 },
          { name: "memory", status: "disconnected", toolCount: 0 },
        ],
        total: 2,
      };
    });
    const controller = createMcpManagementController(host, rpc);
    const result = await controller.listServers();
    expect((seen[0] as unknown[])[0]).toBe("mcp.list");
    expect((seen[0] as unknown[]).length).toBe(1);
    expect(result.total).toBe(2);
    expect(result.servers.length).toBe(2);
    expect(result.servers[0]!.name).toBe("fs");
  });

  it("readConfig: invokes config.read with no params + returns config tree", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        config: {
          integrations: {
            mcp: {
              servers: [
                {
                  name: "fs",
                  transport: "stdio",
                  command: "npx",
                  enabled: true,
                },
              ],
            },
          },
        },
      };
    });
    const controller = createMcpManagementController(host, rpc);
    const result = await controller.readConfig();
    expect((seen[0] as unknown[])[0]).toBe("config.read");
    expect(result.config.integrations?.mcp?.servers?.[0]?.name).toBe("fs");
  });

  it("getServerStatus: invokes mcp.status with server_name + returns detail", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        name: "fs",
        status: "connected",
        tools: [
          { name: "readFile", qualifiedName: "fs.readFile" },
          { name: "writeFile", qualifiedName: "fs.writeFile" },
        ],
        instructions: "Filesystem MCP server",
      };
    });
    const controller = createMcpManagementController(host, rpc);
    const detail = await controller.getServerStatus("fs");
    expect((seen[0] as unknown[])[0]).toBe("mcp.status");
    expect((seen[0] as unknown[])[1]).toEqual({ server_name: "fs" });
    expect(detail.tools.length).toBe(2);
    expect(detail.instructions).toBe("Filesystem MCP server");
  });

  it("patchConfig: forwards section/key/value to config.patch", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createMcpManagementController(host, rpc);
    await controller.patchConfig("integrations", "mcp.servers", [
      { name: "fs", transport: "stdio", enabled: true },
    ]);
    expect((seen[0] as unknown[])[0]).toBe("config.patch");
    expect((seen[0] as unknown[])[1]).toEqual({
      section: "integrations",
      key: "mcp.servers",
      value: [{ name: "fs", transport: "stdio", enabled: true }],
    });
  });

  it("disconnectServer / reconnectServer: invoke mcp.disconnect + mcp.reconnect with server_name", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createMcpManagementController(host, rpc);
    await controller.disconnectServer("fs");
    await controller.reconnectServer("memory");
    expect((seen[0] as unknown[])[0]).toBe("mcp.disconnect");
    expect((seen[0] as unknown[])[1]).toEqual({ server_name: "fs" });
    expect((seen[1] as unknown[])[0]).toBe("mcp.reconnect");
    expect((seen[1] as unknown[])[1]).toEqual({ server_name: "memory" });
  });

  it("testServer: forwards full params (name-only and config-only dry-run)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { success: true, toolCount: 3, tools: ["a", "b", "c"] };
    });
    const controller = createMcpManagementController(host, rpc);
    // Name-only test (running server)
    await controller.testServer({ name: "fs" });
    expect((seen[0] as unknown[])[0]).toBe("mcp.test");
    expect((seen[0] as unknown[])[1]).toEqual({ name: "fs" });
    // Config-only dry-run with transport params
    const result = await controller.testServer({
      name: "new-server",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { NODE_ENV: "test" },
    });
    expect((seen[1] as unknown[])[1]).toEqual({
      name: "new-server",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { NODE_ENV: "test" },
    });
    expect(result.success).toBe(true);
    expect(result.toolCount).toBe(3);
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createMcpManagementController(host, rpc);
    await expect(controller.listServers()).rejects.toThrow("daemon unreachable");
    await expect(controller.readConfig()).rejects.toThrow("daemon unreachable");
    await expect(controller.getServerStatus("fs")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.disconnectServer("fs")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.testServer({ name: "fs" })).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createMcpManagementController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createMcpManagementController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
