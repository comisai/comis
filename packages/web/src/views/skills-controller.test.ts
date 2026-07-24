// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createSkillsController } from "./skills-controller.js";

vi.mock("../components/feedback/ic-toast.js", () => ({
  IcToast: { show: vi.fn() },
}));

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

const MOCK_CONFIG = {
  config: {
    agents: {
      default: {
        skills: {
          discoveryPaths: ["./skills"],
          builtinTools: { read: true, write: true, edit: true, grep: true, find: true, ls: true, exec: true, process: true, webSearch: false, webFetch: false, browser: false },
          toolPolicy: { profile: "full", allow: [] as string[], deny: [] as string[] },
          promptSkills: { maxBodyLength: 20000, enableDynamicContext: false, maxAutoInject: 3, allowedSkills: [], deniedSkills: [] },
        },
      },
    },
  },
  sections: ["agents"],
};

describe("SkillsController", () => {
  it("loadData: transitions loading → loaded on successful config.read", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "config.read") return structuredClone(MOCK_CONFIG);
      if (method === "skills.list") return { skills: [] };
      return {};
    });
    const controller = createSkillsController(host, rpc, null);
    await controller.loadData();
    expect(controller.getSnapshot().loadState).toBe("loaded");
    expect(controller.getSnapshot().agentIds).toEqual(["default"]);
    expect(host._updates).toBeGreaterThan(0);
  });

  it("loadData: transitions loading → error on RPC failure with errorMessage", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("network down");
    });
    const controller = createSkillsController(host, rpc, null);
    await controller.loadData();
    expect(controller.getSnapshot().loadState).toBe("error");
    expect(controller.getSnapshot().error).toBe("network down");
  });

  it("onToolToggle: patches config and updates snapshot.skillsConfig.builtinTools", async () => {
    const host = makeHost();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      const params = args[1];
      calls.push({ method, params });
      if (method === "config.read") return structuredClone(MOCK_CONFIG);
      if (method === "skills.list") return { skills: [] };
      return {};
    });
    const controller = createSkillsController(host, rpc, null);
    // Select the default agent so skillsConfig becomes populated.
    await controller.onAgentChange("default");
    await controller.onToolToggle("webSearch", true);
    const patchCalls = calls.filter((c) => c.method === "config.patch");
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
    expect(controller.getSnapshot().skillsConfig?.builtinTools["webSearch"]).toBe(true);
  });

  it("onAgentChange: switches targetAgentId and reloads data", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "config.read") return structuredClone(MOCK_CONFIG);
      if (method === "skills.list") return { skills: [] };
      return {};
    });
    const controller = createSkillsController(host, rpc, null);
    await controller.loadData();
    expect(controller.getSnapshot().targetAgentId).toBe("");
    await controller.onAgentChange("default");
    expect(controller.getSnapshot().targetAgentId).toBe("default");
    expect(controller.getSnapshot().skillScope).toBe("all");
  });

  it("handleDeleteSkill / cancelDeleteSkill: sets and clears deletingSkill", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSkillsController(host, rpc, null);
    controller.handleDeleteSkill("my-skill");
    expect(controller.getSnapshot().deletingSkill).toBe("my-skill");
    controller.cancelDeleteSkill();
    expect(controller.getSnapshot().deletingSkill).toBeNull();
  });

  it("setActiveTab / setSearchQuery / setSkillScope: independent setters fire host.requestUpdate", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSkillsController(host, rpc, null);
    const before = host._updates;
    controller.setActiveTab("skills");
    expect(controller.getSnapshot().activeTab).toBe("skills");
    controller.setSearchQuery("docx");
    expect(controller.getSnapshot().searchQuery).toBe("docx");
    controller.setSkillScope("shared");
    expect(controller.getSnapshot().skillScope).toBe("shared");
    expect(host._updates).toBeGreaterThan(before);
  });

  it("addToList: appends item to allowedSkills via config.patch", async () => {
    const host = makeHost();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      const params = args[1];
      calls.push({ method, params });
      if (method === "config.read") return structuredClone(MOCK_CONFIG);
      if (method === "skills.list") return { skills: [] };
      return {};
    });
    const controller = createSkillsController(host, rpc, null);
    await controller.onAgentChange("default");
    await controller.addToList("allowedSkills", "my-skill");
    expect(controller.getSnapshot().skillsConfig?.promptSkills.allowedSkills).toContain("my-skill");
  });

  it("getResolvedTools: combines profile base + allow minus deny", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "config.read") {
        const cfg = structuredClone(MOCK_CONFIG);
        cfg.config.agents.default.skills.toolPolicy = {
          profile: "coding",
          allow: ["webSearch"],
          deny: ["process"],
        };
        return cfg;
      }
      if (method === "skills.list") return { skills: [] };
      return {};
    });
    const controller = createSkillsController(host, rpc, null);
    await controller.onAgentChange("default");
    const { included, denied } = controller.getResolvedTools();
    expect(included).toContain("read");
    expect(included).toContain("webSearch");
    expect(included).not.toContain("process");
    expect(denied).toContain("process");
  });

  it("agentIdFromLocation helper extracts workspace agent id from location path", async () => {
    const { agentIdFromLocation } = await import("./skills-controller.js");
    expect(agentIdFromLocation("/home/x/.comis/workspace-alpha/skills/foo")).toBe("alpha");
    expect(agentIdFromLocation("/home/x/.comis/workspace/skills/foo")).toBe("default");
    expect(agentIdFromLocation("/some/other/path")).toBe("");
  });
});
