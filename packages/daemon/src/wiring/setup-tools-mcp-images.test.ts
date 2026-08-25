// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the daemon's MCP image-result policy: the shared screenshot
 * sanitizer is the security boundary, and a dropped block is a content-free
 * WARN with an actionable hint.
 */

import { describe, it, expect, vi } from "vitest";
import { sanitizeImageForApi } from "@comis/skills/tools";
import { createMcpImageResultPolicy } from "./setup-tools-mcp-images.js";

describe("createMcpImageResultPolicy", () => {
  it("routes image blocks through the same sanitizer browser screenshots use", () => {
    const policy = createMcpImageResultPolicy({ warn: vi.fn() });
    expect(policy.sanitizeImage).toBe(sanitizeImageForApi);
  });

  it("logs a dropped block as a content-free WARN with hint and errorKind", () => {
    const warn = vi.fn();
    const policy = createMcpImageResultPolicy({ warn });

    policy.onImageDropped?.({
      server: "desktop",
      tool: "screenshot",
      reason: "sanitize_failed",
      mimeType: "image/png",
      bytes: 4096,
      traceId: "trace-9",
    });

    expect(warn).toHaveBeenCalledOnce();
    const [payload, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe("MCP image result block dropped");
    expect(payload).toMatchObject({
      server: "desktop",
      tool: "screenshot",
      reason: "sanitize_failed",
      mimeType: "image/png",
      bytes: 4096,
      traceId: "trace-9",
      errorKind: "validation",
    });
    expect(typeof payload.hint).toBe("string");
    expect(payload).not.toHaveProperty("data");
  });
});
