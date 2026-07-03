// SPDX-License-Identifier: Apache-2.0
/**
 * `image_generate` never-export regression-guard.
 *
 * `image_generate` is a COST-BEARING platform tool. It must NEVER be exported
 * to an untrusted MCP client. Today it is default-deny: it is registered in the
 * PLATFORM-tool registry (skills `createPlatformToolRegistry()`, so the agent
 * can call it) but it is NOT registered in the MCP `tool-metadata-registry`
 * (`@comis/core` `getAllToolMetadata()`), and the MCP export gate
 * (mcp-server-handlers.ts:260) SKIPS any tool whose `mcpExportPolicy` is
 * `undefined` (`policy === undefined → skippedUndefined; continue`).
 *
 * This guard PINS that invariant: it is green today, and turns RED the moment
 * someone adds `registerToolMetadata("image_generate", { ... })` — at which
 * point `image_generate` would acquire a policy and could be exported (unless
 * that policy is explicitly "never-export"). The test forces an explicit,
 * reviewed decision for any future registration rather than a silent export of
 * the cost-bearing tool.
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
// The PLATFORM-tool registry — proves image_generate EXISTS as a tool (so the
// absence from the MCP registry is a deliberate default-deny, not a typo).
import { createPlatformToolRegistry } from "@comis/skills/platform-tools";

describe("image_generate never-export regression-guard", () => {
  it("image_generate is NOT in the MCP exported tool metadata (default-deny)", () => {
    const all = getAllToolMetadata();
    // No entry named image_generate → it is never in the MCP registered set.
    expect(all.has("image_generate")).toBe(false);
    // The dedicated accessor agrees (returns undefined for an unregistered tool).
    expect(getToolMetadata("image_generate")).toBeUndefined();

    // Belt-and-suspenders: scan EVERY registered entry — none may carry an
    // export policy for image_generate. If a future change registers it with
    // ANY mcpExportPolicy other than an explicit "never-export", this fails
    // and forces a reviewed decision (the cost-bearing tool must stay unexported).
    for (const [name, meta] of all) {
      if (name === "image_generate") {
        expect(meta.mcpExportPolicy).toBe("never-export");
      }
    }
  });

  it("image_generate DOES exist in the platform-tool registry (default-deny proof)", () => {
    // Sanity floor: the guard above is only meaningful because image_generate is
    // a real, registered platform tool. If it were absent everywhere the
    // never-export assertion would pass vacuously.
    const platform = createPlatformToolRegistry();
    expect(platform.some((d) => d.name === "image_generate")).toBe(true);
  });

  it("the MCP registry is actually populated (the guard is not vacuous)", () => {
    // If registerAllToolMetadata() failed to populate the singleton, the
    // never-export assertion would pass trivially. Pin a non-trivial size.
    expect(getAllToolMetadata().size).toBeGreaterThan(1);
  });
});
