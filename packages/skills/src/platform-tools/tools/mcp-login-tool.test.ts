// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the mcp_login agent tool.
 *
 * RED phase: assert the tool file does not yet exist (import fails).
 * GREEN phase: assert correct behavior after implementation.
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// RED: assert tool does not exist yet
// ---------------------------------------------------------------------------

describe("mcp_login tool (RED gate — pre-patch)", () => {
  it("mcp_login tool does not exist yet (pre-patch RED)", async () => {
    // Attempt dynamic import of the not-yet-created tool file.
    // This MUST throw/reject when the file does not exist — confirming RED.
    await expect(
      import("../tools/mcp-login-tool.js"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GREEN: assert correct behavior after implementation
// (skipped until GREEN commit creates the tool)
// ---------------------------------------------------------------------------

describe("mcp_login tool (GREEN — post-patch)", () => {
  it.todo("mcp_login returns authUrl as content[0].text when authUrl is present");
  it.todo("mcp_login returns status fallback when authUrl is absent");
  it.todo("mcp_login trust guard fires before rpcCall");
  it.todo("mcp_login content array has exactly one element");
});
