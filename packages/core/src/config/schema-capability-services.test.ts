// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "./schema.js";
import { getFieldMetadata } from "./field-metadata.js";
import { isImmutableConfigPath } from "./immutable-keys.js";
import { getConfigSections } from "./schema-serializer.js";
import { CapabilityServicesConfigSchema } from "./schema-capability-services.js";

function makeInstance() {
  return {
    serviceInstanceId: "service-instance_a",
    serviceDefinitionId: "example.service-definition",
    enabled: true,
    mcpServerName: "example-service",
    control: {
      transport: "unix" as const,
      socketPath: "/tmp/example-service.sock",
      credentialRef: "secret://capability-services/service-instance_a",
    },
    allowedAgents: ["agent_a"],
    allowedWorkspaceRoots: [],
  };
}

describe("capability-services application configuration", () => {
  it("defaults to an inert strict configuration with concrete runtime bounds", () => {
    expect(CapabilityServicesConfigSchema.parse({})).toEqual({
      instances: [],
      privateContentDirectory: "managed-runs/private",
      reportRetentionMs: 2_592_000_000,
      maxObservedClockSkewMs: 300_000,
      recoveryBatchSize: 256,
      requestDeadlineMs: 5_000,
    });
    expect(AppConfigSchema.parse({}).capabilityServices.instances).toEqual([]);
  });

  it("accepts exact Unix instances and rejects unknown or unsafe topology", () => {
    expect(CapabilityServicesConfigSchema.safeParse({ instances: [makeInstance()] }).success)
      .toBe(true);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{
        ...makeInstance(),
        control: { ...makeInstance().control, socketPath: "relative.sock" },
      }],
    }).success).toBe(false);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [makeInstance()],
      privateContentDirectory: "../outside",
    }).success).toBe(false);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [makeInstance()],
      unknownKey: true,
    }).success).toBe(false);
  });

  it("accepts canonical workspace roots and rejects broad workspace authority", () => {
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{ ...makeInstance(), allowedWorkspaceRoots: ["/srv/comis-workspaces"] }],
    }).success).toBe(true);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{ ...makeInstance(), allowedWorkspaceRoots: ["/"] }],
    }).success).toBe(false);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{ ...makeInstance(), allowedWorkspaceRoots: ["relative/workspaces"] }],
    }).success).toBe(false);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{
        ...makeInstance(),
        allowedWorkspaceRoots: ["/srv/comis-workspaces", "/srv/comis-workspaces"],
      }],
    }).success).toBe(false);
  });

  it("requires narrow absolute unique runtime roots for execution attachments", () => {
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{
        ...makeInstance(),
        allowedRuntimeRoots: ["/srv/capability-runtime/service-a"],
      }],
    }).success).toBe(true);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{ ...makeInstance(), allowedRuntimeRoots: ["/"] }],
    }).success).toBe(false);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{ ...makeInstance(), allowedRuntimeRoots: ["relative/runtime"] }],
    }).success).toBe(false);
    expect(CapabilityServicesConfigSchema.safeParse({
      instances: [{
        ...makeInstance(),
        allowedRuntimeRoots: [
          "/srv/capability-runtime/service-a",
          "/srv/capability-runtime/service-a",
        ],
      }],
    }).success).toBe(false);
  });

  it("exposes the restart-only section while keeping every field immutable", () => {
    expect(getConfigSections()).toContain("capabilityServices");
    expect(isImmutableConfigPath("capabilityServices")).toBe(true);
    const metadata = getFieldMetadata("capabilityServices");
    expect(metadata.length).toBeGreaterThan(0);
    expect(metadata.every((entry) => entry.immutable)).toBe(true);
  });
});
