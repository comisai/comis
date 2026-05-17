// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createConfigEditorController } from "./config-editor-controller.js";

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

describe("ConfigEditorController", () => {
  it("readConfig: returns config + sections", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "config.read") {
        return { config: { gateway: { port: 4766 } }, sections: ["gateway"] };
      }
      return {};
    });
    const controller = createConfigEditorController(host, rpc);
    const result = await controller.readConfig();
    expect(result.sections).toEqual(["gateway"]);
    expect(result.config.gateway).toEqual({ port: 4766 });
  });

  it("readSection: returns only the requested section's config", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const params = args[1] as { section?: string } | undefined;
      if (args[0] === "config.read" && params?.section === "gateway") {
        return { port: 4766, host: "127.0.0.1" };
      }
      return {};
    });
    const controller = createConfigEditorController(host, rpc);
    const gateway = await controller.readSection<{ port: number; host: string }>("gateway");
    expect(gateway.port).toBe(4766);
  });

  it("loadSchema: returns config.schema response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "config.schema") {
        return { schema: { properties: { gateway: {} } }, sections: ["gateway"] };
      }
      return {};
    });
    const controller = createConfigEditorController(host, rpc);
    const result = await controller.loadSchema();
    expect(result.sections).toEqual(["gateway"]);
  });

  it("applyConfig / patchConfig: invoke matching rpc methods", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push(args[0] as string);
      return {};
    });
    const controller = createConfigEditorController(host, rpc);
    await controller.applyConfig({ section: "gateway", value: { port: 4766 } });
    await controller.patchConfig({ section: "gateway", key: "port", value: 4766 });
    expect(calls).toEqual(["config.apply", "config.patch"]);
  });

  it("loadHistory: returns config.history response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "config.history") {
        return {
          entries: [{
            sha: "abc123",
            timestamp: "2026-05-17T00:00:00Z",
            metadata: { section: "gateway", summary: "Edit port" },
            message: "Edit port",
          }],
        };
      }
      return {};
    });
    const controller = createConfigEditorController(host, rpc);
    const result = await controller.loadHistory(10);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.sha).toBe("abc123");
  });

  it("loadDiff: returns diff string from config.diff response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "config.diff") return { diff: "+ added line\n- removed line" };
      return {};
    });
    const controller = createConfigEditorController(host, rpc);
    const diff = await controller.loadDiff("abc123");
    expect(diff).toContain("added line");
  });

  it("rollbackToSha / runGc: invoke matching rpc methods", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push(args[0] as string);
      if (args[0] === "config.gc") return { gc: true, squashed: 3 };
      return { rolledBack: true, sha: "abc123", newCommitSha: "def456", restarting: false };
    });
    const controller = createConfigEditorController(host, rpc);
    await controller.rollbackToSha("abc123");
    const gcResult = await controller.runGc();
    expect(calls).toEqual(["config.rollback", "config.gc"]);
    expect(gcResult.squashed).toBe(3);
  });
});
