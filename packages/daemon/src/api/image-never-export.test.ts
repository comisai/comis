// SPDX-License-Identifier: Apache-2.0
/**
 * `image_generate` never-export regression-guard.
 *
 * `image_generate` is a cost-bearing platform tool. It must never be exported
 * to an untrusted MCP client. Its metadata entry is required so execution-side
 * effects are classified, and its explicit export policy must stay closed.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { getAllToolMetadata, getToolMetadata } from "@comis/core";
// Importing the @comis/skills barrel triggers the tool-bridge module-load
// side-effect (`registerAllToolMetadata()` at tool-bridge.ts:16) that populates
// the MCP metadata registry — exactly the path the daemon exercises at boot.
// This makes the assertion meaningful: the registry is actually populated, so a
// future image_generate registration would be visible here (and fail the guard).
import "@comis/skills";
// The platform-tool registry proves image_generate exists as an executable tool.
import { createPlatformToolRegistry } from "@comis/skills/platform-tools";

describe("image_generate never-export regression-guard", () => {
  it("image_generate carries an explicit never-export policy and outbound side effect", () => {
    const all = getAllToolMetadata();
    expect(all.has("image_generate")).toBe(true);
    expect(getToolMetadata("image_generate")).toMatchObject({
      mcpExportPolicy: "never-export",
      invocationSideEffects: { kind: "always", capabilities: ["outbound_delivery"] },
    });
  });

  it("image_generate DOES exist in the platform-tool registry (default-deny proof)", () => {
    const platform = createPlatformToolRegistry();
    expect(platform.some((d) => d.name === "image_generate")).toBe(true);
  });

  it("the MCP registry is actually populated (the guard is not vacuous)", () => {
    // If registerAllToolMetadata() failed, the policy assertion could not test
    // the same populated singleton the daemon uses.
    expect(getAllToolMetadata().size).toBeGreaterThan(1);
  });
});
