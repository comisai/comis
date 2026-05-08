// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createCapabilityPortStub } from "./tool-capability-stub.js";

describe("createCapabilityPortStub (TOOLING-CFG-15 test fixture)", () => {
  it("returns all 9 methods with default behaviors when called with no overrides", () => {
    const port = createCapabilityPortStub();
    expect(port.isCapabilityIndexEnabled()).toBe(true);
    expect(port.getInstallDetourMode()).toBe("advise");
    expect(port.getBuiltinCluster("any")).toBeUndefined();
    expect(port.getClusterConfig("any")).toBeUndefined();
    expect(port.getMcpServerHint("any")).toBeUndefined();
    expect(port.getSkillHint("any")).toBeUndefined();
    expect(port.getPackageAliasMap().size).toBe(0);
    expect(port.getConnectedMcpServers()).toEqual([]);
    expect(port.getPromptSkillCapabilities()).toEqual([]);
  });

  it("overrides single method via partial", () => {
    const port = createCapabilityPortStub({
      getInstallDetourMode: () => "soft-stop",
    });
    expect(port.getInstallDetourMode()).toBe("soft-stop");
    // Defaults preserved:
    expect(port.isCapabilityIndexEnabled()).toBe(true);
    expect(port.getConnectedMcpServers()).toEqual([]);
  });

  it("overrides multiple methods", () => {
    const port = createCapabilityPortStub({
      isCapabilityIndexEnabled: () => false,
      getInstallDetourMode: () => "observe",
      getConnectedMcpServers: () => ["finance-data"],
    });
    expect(port.isCapabilityIndexEnabled()).toBe(false);
    expect(port.getInstallDetourMode()).toBe("observe");
    expect(port.getConnectedMcpServers()).toEqual(["finance-data"]);
    // Defaults preserved for the other six:
    expect(port.getBuiltinCluster("any")).toBeUndefined();
    expect(port.getClusterConfig("any")).toBeUndefined();
    expect(port.getMcpServerHint("any")).toBeUndefined();
  });

  it("supports type-correct getBuiltinCluster override", () => {
    const port = createCapabilityPortStub({
      getBuiltinCluster: (name: string) =>
        name === "exec" ? "other-tools" : undefined,
    });
    expect(port.getBuiltinCluster("exec")).toBe("other-tools");
    expect(port.getBuiltinCluster("read")).toBeUndefined();
  });

  it("returned port is NOT frozen (test fixtures may mutate for test-time setup)", () => {
    const port = createCapabilityPortStub();
    expect(Object.isFrozen(port)).toBe(false);
  });
});
