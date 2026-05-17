// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import { createBrowserTool } from "./browser-tool.js";
import type { BrowserToolDeps } from "./browser-tool.js";

// Mock validateUrl from @comis/core for SSRF tests
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    validateUrl: vi.fn().mockResolvedValue({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("http://example.com") },
    }),
  };
});

function createMockRpcCall() {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    return { stub: true, method, params };
  });
}

describe("browser-tool", () => {
  it("has correct name, label, description, and parameters", () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    expect(tool.name).toBe("browser");
    expect(tool.label).toBe("Browser");
    expect(tool.description).toContain("headless browser");
    expect(tool.parameters).toBeDefined();
  });

  it("status action delegates to browser.status rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    const result = await tool.execute("call-1", { action: "status" });

    expect(rpcCall).toHaveBeenCalledWith("browser.status", { action: "status" });
    expect(result.details).toEqual(
      expect.objectContaining({ stub: true, method: "browser.status" }),
    );
  });

  it("navigate action calls browser.navigate rpcCall with URL", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    const result = await tool.execute("call-2", {
      action: "navigate",
      targetUrl: "https://example.com",
    });

    expect(rpcCall).toHaveBeenCalledWith("browser.navigate", {
      action: "navigate",
      targetUrl: "https://example.com",
    });
    expect(result.details).toEqual(
      expect.objectContaining({ stub: true, method: "browser.navigate" }),
    );
  });

  it("navigate action with private IP triggers SSRF block", async () => {
    const { validateUrl } = await import("@comis/core");
    vi.mocked(validateUrl).mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 127.0.0.1 is in loopback range"),
    });

    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    await expect(
      tool.execute("call-3", {
        action: "navigate",
        targetUrl: "http://localhost:8080/admin",
      }),
    ).rejects.toThrow("SSRF blocked");

    // rpcCall should NOT have been called
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("navigate action with public URL passes SSRF and delegates to rpcCall", async () => {
    const { validateUrl } = await import("@comis/core");
    vi.mocked(validateUrl).mockResolvedValueOnce({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("https://example.com") },
    });

    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    await tool.execute("call-4", {
      action: "navigate",
      targetUrl: "https://example.com/page",
    });

    expect(rpcCall).toHaveBeenCalledWith("browser.navigate", {
      action: "navigate",
      targetUrl: "https://example.com/page",
    });
  });

  it("open action validates URL through SSRF guard", async () => {
    const { validateUrl } = await import("@comis/core");
    vi.mocked(validateUrl).mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 10.0.0.1 is in private range"),
    });

    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    await expect(
      tool.execute("call-5", {
        action: "open",
        targetUrl: "http://10.0.0.1/internal",
      }),
    ).rejects.toThrow("SSRF blocked");

    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("snapshot action delegates to browser.snapshot rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    const result = await tool.execute("call-6", { action: "snapshot" });

    expect(rpcCall).toHaveBeenCalledWith("browser.snapshot", { action: "snapshot" });
    expect(result.details).toEqual(
      expect.objectContaining({ stub: true, method: "browser.snapshot" }),
    );
  });

  it("screenshot action returns imageResult when rpcCall returns base64", async () => {
    const rpcCall = vi.fn(async () => ({
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAI",
      mimeType: "image/png",
    }));
    const tool = createBrowserTool(rpcCall);

    const result = await tool.execute("call-7", { action: "screenshot" });

    expect(rpcCall).toHaveBeenCalledWith("browser.screenshot", { action: "screenshot" });
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "image",
        data: expect.any(String),
        mimeType: "image/png",
      }),
    );
  });

  it("screenshot action returns jsonResult when rpcCall returns non-image data", async () => {
    const rpcCall = vi.fn(async () => ({
      path: "/tmp/screenshot.png",
    }));
    const tool = createBrowserTool(rpcCall);

    const result = await tool.execute("call-8", { action: "screenshot" });

    // Should fall through to jsonResult since no base64/mimeType
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
  });

  it("act action delegates to browser.act rpcCall with request sub-object", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    const result = await tool.execute("call-9", {
      action: "act",
      request: { kind: "click", ref: "e3" },
    });

    expect(rpcCall).toHaveBeenCalledWith("browser.act", {
      action: "act",
      request: { kind: "click", ref: "e3" },
    });
    expect(result.details).toEqual(
      expect.objectContaining({ stub: true, method: "browser.act" }),
    );
  });

  it("throws on rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Browser service unavailable");
    });
    const tool = createBrowserTool(rpcCall);

    await expect(tool.execute("call-10", { action: "status" })).rejects.toThrow("Browser service unavailable");
  });

  it("tabs action delegates to browser.tabs rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    await tool.execute("call-11", { action: "tabs" });

    expect(rpcCall).toHaveBeenCalledWith("browser.tabs", { action: "tabs" });
  });

  it("start action delegates to browser.start rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    await tool.execute("call-12", { action: "start" });

    expect(rpcCall).toHaveBeenCalledWith("browser.start", { action: "start" });
  });

  it("stop action delegates to browser.stop rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);

    await tool.execute("call-13", { action: "stop" });

    expect(rpcCall).toHaveBeenCalledWith("browser.stop", { action: "stop" });
  });
});

describe("browser-tool deps interface", () => {
  it("createBrowserTool accepts bare rpcCall function (backward compat)", () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool(rpcCall);
    expect(tool.name).toBe("browser");
  });

  it("createBrowserTool accepts BrowserToolDeps object", () => {
    const rpcCall = createMockRpcCall();
    const tool = createBrowserTool({ rpcCall });
    expect(tool.name).toBe("browser");
  });
});

describe("browser-tool screenshot pipeline", () => {
  function createScreenshotRpcCall() {
    return vi.fn(async () => ({
      base64: "rawbase64data",
      mimeType: "image/png",
    }));
  }

  it("screenshot with sanitize+persist returns dualImageResult with 2 content blocks", async () => {
    const rpcCall = createScreenshotRpcCall();
    const deps: BrowserToolDeps = {
      rpcCall,
      sanitizeImage: vi.fn().mockResolvedValue(ok({
        buffer: Buffer.from("sanitized"),
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
        originalBytes: 1000,
        sanitizedBytes: 500,
      })),
      persistMedia: {
        persist: vi.fn().mockResolvedValue(ok({
          filePath: "/workspace/screenshots/abc.jpg",
          relativePath: "screenshots/abc.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 500,
          mediaKind: "image",
          savedAt: Date.now(),
        })),
      },
      workspaceDir: "/workspace",
    };
    const tool = createBrowserTool(deps);

    const result = await tool.execute("call-dual", { action: "screenshot" });

    // Should have 2 content blocks: text (file path) + image (sanitized data)
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("image");

    // Text block should contain the relative path
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("screenshots/abc.jpg");

    // Image block should contain sanitized base64 (not raw)
    const imageBlock = result.content[1] as { type: string; data: string; mimeType: string };
    expect(imageBlock.data).toBe(Buffer.from("sanitized").toString("base64"));
    expect(imageBlock.mimeType).toBe("image/jpeg");
  });

  it("screenshot falls back to sanitized imageResult when persist fails", async () => {
    const rpcCall = createScreenshotRpcCall();
    const deps: BrowserToolDeps = {
      rpcCall,
      sanitizeImage: vi.fn().mockResolvedValue(ok({
        buffer: Buffer.from("sanitized"),
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
        originalBytes: 1000,
        sanitizedBytes: 500,
      })),
      persistMedia: {
        persist: vi.fn().mockResolvedValue(err(new Error("disk full"))),
      },
      workspaceDir: "/workspace",
    };
    const tool = createBrowserTool(deps);

    const result = await tool.execute("call-persist-fail", { action: "screenshot" });

    // Should fall back to single image content block with sanitized data
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("image");
    const imageBlock = result.content[0] as { type: string; data: string; mimeType: string };
    expect(imageBlock.data).toBe(Buffer.from("sanitized").toString("base64"));
    expect(imageBlock.mimeType).toBe("image/jpeg");
  });

  it("screenshot falls back to raw imageResult when sanitize fails", async () => {
    const rpcCall = createScreenshotRpcCall();
    const deps: BrowserToolDeps = {
      rpcCall,
      sanitizeImage: vi.fn().mockResolvedValue(err("corrupt image")),
      persistMedia: {
        persist: vi.fn().mockResolvedValue(ok({
          filePath: "/workspace/screenshots/abc.jpg",
          relativePath: "screenshots/abc.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 500,
          mediaKind: "image",
          savedAt: Date.now(),
        })),
      },
      workspaceDir: "/workspace",
    };
    const tool = createBrowserTool(deps);

    const result = await tool.execute("call-sanitize-fail", { action: "screenshot" });

    // Should fall back to single image content block with raw data
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("image");
    const imageBlock = result.content[0] as { type: string; data: string; mimeType: string };
    expect(imageBlock.data).toBe("rawbase64data");
    expect(imageBlock.mimeType).toBe("image/png");
  });

  it("screenshot falls back to raw imageResult when no deps", async () => {
    const rpcCall = createScreenshotRpcCall();
    const tool = createBrowserTool({ rpcCall });

    const result = await tool.execute("call-no-deps", { action: "screenshot" });

    // Should fall back to single image content block with raw data
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("image");
    const imageBlock = result.content[0] as { type: string; data: string; mimeType: string };
    expect(imageBlock.data).toBe("rawbase64data");
    expect(imageBlock.mimeType).toBe("image/png");
  });
});
