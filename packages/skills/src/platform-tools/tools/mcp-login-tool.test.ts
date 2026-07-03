// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the mcp_login agent tool.
 *
 * Assert the tool surfaces the OAuth device-authorization URL so the user
 * can complete login, and enforces the required trust level.
 */

import { describe, it, expect, vi } from "vitest";
import { runWithContext } from "@comis/core";
import type { RequestContext } from "@comis/core";

// Mock @comis/core: preserve real implementations (including registerActivityLabelSpec)
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminContext(): RequestContext {
  return {
    tenantId: "default",
    userId: "test-user",
    sessionKey: "test-session",
    traceId: crypto.randomUUID(),
    startedAt: Date.now(),
    trustLevel: "admin",
  };
}

// ---------------------------------------------------------------------------
// RED: assert tool does not exist yet (pre-patch)
// The RED test remains in the file but is skipped after GREEN implementation
// so it does not fail due to the now-existing file.
// ---------------------------------------------------------------------------

describe("mcp_login tool (RED gate — pre-patch)", () => {
  it.skip("mcp_login tool does not exist yet (pre-patch RED)", async () => {
    // This was the RED gate. The file now exists after the GREEN commit.
    // Kept for audit trail; skipped so the suite stays green.
    await expect(
      import("../tools/mcp-login-tool.js"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GREEN: assert correct behavior after implementation
// ---------------------------------------------------------------------------

describe("mcp_login tool (GREEN — post-patch)", () => {
  it("mcp_login returns authUrl as content[0].text when authUrl is present", async () => {
    const { createMcpLoginTool } = await import("./mcp-login-tool.js");

    const authUrl = "https://x.ai/device?code=ABCD-1234";
    const mockRpcCall = vi.fn(async () => ({ authUrl, status: "pending" }));
    const tool = createMcpLoginTool(mockRpcCall as never);

    const result = await runWithContext(makeAdminContext(), () =>
      tool.execute("call-1", { server_name: "x-ai" }),
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text", text: authUrl });
  });

  it("mcp_login content array has exactly one element", async () => {
    const { createMcpLoginTool } = await import("./mcp-login-tool.js");

    const mockRpcCall = vi.fn(async () => ({
      authUrl: "https://example.com/auth?code=WXYZ-5678",
      status: "pending",
    }));
    const tool = createMcpLoginTool(mockRpcCall as never);

    const result = await runWithContext(makeAdminContext(), () =>
      tool.execute("call-2", { server_name: "example-server" }),
    );

    expect(result.content).toHaveLength(1);
  });

  it("mcp_login returns status fallback when authUrl is absent", async () => {
    const { createMcpLoginTool } = await import("./mcp-login-tool.js");

    const mockRpcCall = vi.fn(async () => ({ status: "error" }));
    const tool = createMcpLoginTool(mockRpcCall as never);

    const result = await runWithContext(makeAdminContext(), () =>
      tool.execute("call-3", { server_name: "broken-server" }),
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "OAuth login status: error",
    });
  });

  it("mcp_login trust guard fires before rpcCall (blocks guest callers)", async () => {
    const { createMcpLoginTool } = await import("./mcp-login-tool.js");

    const mockRpcCall = vi.fn(async () => ({
      authUrl: "https://example.com/auth",
      status: "pending",
    }));
    const tool = createMcpLoginTool(mockRpcCall as never);

    // Guest trust level must be rejected
    await expect(
      runWithContext(
        {
          tenantId: "default",
          userId: "test-user",
          sessionKey: "test-session",
          traceId: crypto.randomUUID(),
          startedAt: Date.now(),
          trustLevel: "guest",
        },
        () => tool.execute("call-4", { server_name: "any-server" }),
      ),
    ).rejects.toThrow(/Insufficient trust level/);

    // rpcCall was NOT called — trust guard blocked before dispatch
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("mcp_login dispatches rpcCall with mcp.oauth_login and server_name", async () => {
    const { createMcpLoginTool } = await import("./mcp-login-tool.js");

    const mockRpcCall = vi.fn(async () => ({
      authUrl: "https://example.com/auth",
      status: "pending",
    }));
    const tool = createMcpLoginTool(mockRpcCall as never);

    await runWithContext(makeAdminContext(), () =>
      tool.execute("call-5", { server_name: "my-server" }),
    );

    expect(mockRpcCall).toHaveBeenCalledOnce();
    expect(mockRpcCall).toHaveBeenCalledWith("mcp.oauth_login", { server_name: "my-server" });
  });
});
