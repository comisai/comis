// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createNoOpCapabilityPort } from "./no-op-tool-capability.js";

describe("createNoOpCapabilityPort (production no-op factory)", () => {
  it("returns a frozen object implementing all 9 ToolCapabilityPort methods", () => {
    const port = createNoOpCapabilityPort();
    expect(Object.isFrozen(port)).toBe(true);
    // 7 config-view:
    expect(typeof port.isCapabilityIndexEnabled).toBe("function");
    expect(typeof port.getInstallDetourMode).toBe("function");
    expect(typeof port.getBuiltinCluster).toBe("function");
    expect(typeof port.getClusterConfig).toBe("function");
    expect(typeof port.getMcpServerHint).toBe("function");
    expect(typeof port.getSkillHint).toBe("function");
    expect(typeof port.getPackageAliasMap).toBe("function");
    // 2 runtime-view:
    expect(typeof port.getConnectedMcpServers).toBe("function");
    expect(typeof port.getPromptSkillCapabilities).toBe("function");
  });

  it("returns expected default values for all methods", () => {
    const port = createNoOpCapabilityPort();
    expect(port.isCapabilityIndexEnabled()).toBe(true);
    expect(port.getInstallDetourMode()).toBe("advise");
    expect(port.getBuiltinCluster("anything")).toBeUndefined();
    expect(port.getClusterConfig("any-cluster")).toBeUndefined();
    expect(port.getMcpServerHint("any-server")).toBeUndefined();
    expect(port.getSkillHint("any-skill")).toBeUndefined();
    expect(port.getSkillHint("any-skill", "any::key")).toBeUndefined();
    expect(port.getPackageAliasMap().size).toBe(0);
    expect(port.getConnectedMcpServers().length).toBe(0);
    expect(port.getPromptSkillCapabilities().length).toBe(0);
  });

  it("returns stable references across calls (same module-level constants)", () => {
    const port = createNoOpCapabilityPort();
    // Multiple calls return the SAME frozen empty array reference:
    const servers1 = port.getConnectedMcpServers();
    const servers2 = port.getConnectedMcpServers();
    expect(servers1).toBe(servers2);

    const skills1 = port.getPromptSkillCapabilities();
    const skills2 = port.getPromptSkillCapabilities();
    expect(skills1).toBe(skills2);

    const aliasMap1 = port.getPackageAliasMap();
    const aliasMap2 = port.getPackageAliasMap();
    expect(aliasMap1).toBe(aliasMap2);
  });
});
