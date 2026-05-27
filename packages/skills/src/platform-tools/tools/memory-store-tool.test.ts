// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createMemoryStoreTool } from "./memory-store-tool.js";

describe("memory_store tool", () => {
  it("calls rpcCall with content and tags on success", async () => {
    const rpcCall = vi.fn(async () => ({ stored: true, id: "mem-001" }));
    const tool = createMemoryStoreTool(rpcCall);

    const result = await tool.execute("call-1", {
      content: "User likes TypeScript",
      tags: ["preference", "tech"],
    });

    expect(rpcCall).toHaveBeenCalledWith("memory.store", {
      content: "User likes TypeScript",
      tags: ["preference", "tech"],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ stored: true, id: "mem-001" }),
    );
  });

  it("throws when content param is missing", async () => {
    const rpcCall = vi.fn();
    const tool = createMemoryStoreTool(rpcCall);

    await expect(tool.execute("call-2", {})).rejects.toThrow(
      "Missing required parameter: content",
    );
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("filters out non-string tags", async () => {
    const rpcCall = vi.fn(async () => ({ stored: true }));
    const tool = createMemoryStoreTool(rpcCall);

    await tool.execute("call-3", {
      content: "Test content",
      tags: ["valid", 123, null, "also-valid", undefined],
    });

    expect(rpcCall).toHaveBeenCalledWith("memory.store", {
      content: "Test content",
      tags: ["valid", "also-valid"],
    });
  });

  it("throws when rpcCall rejects", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Memory service unavailable");
    });
    const tool = createMemoryStoreTool(rpcCall);

    await expect(tool.execute("call-4", { content: "test" })).rejects.toThrow(
      "Memory service unavailable",
    );
  });

  it("passes empty tags array when tags param is missing", async () => {
    const rpcCall = vi.fn(async () => ({ stored: true }));
    const tool = createMemoryStoreTool(rpcCall);

    await tool.execute("call-5", { content: "No tags provided" });

    expect(rpcCall).toHaveBeenCalledWith("memory.store", {
      content: "No tags provided",
      tags: [],
    });
  });

  it("passes content with Google API key directly to rpcCall (R4: in-tool detection retired, daemon-side validateMemoryWrite handles it)", async () => {
    // R4: The private SECRET_PATTERNS / contentLooksLikeSecret check is retired.
    // Secret detection now lives daemon-side in validateMemoryWrite (memory-write-validator.ts).
    // The tool itself no longer intercepts or warns — it passes content through to the RPC.
    const rpcCall = vi.fn(async () => ({ stored: true, id: "mem-006" }));
    const tool = createMemoryStoreTool(rpcCall);

    const result = await tool.execute("call-6", {
      content: "Here is my Gemini API key AIzaFAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_X",
    });

    // Should store it (tool-level warning is retired; daemon validates)
    expect(rpcCall).toHaveBeenCalledOnce();
    // No in-tool warning — secret check is now daemon-side only
    expect(result.details).not.toHaveProperty("warning");
  });

  it("passes content with OpenAI API key directly to rpcCall (R4: in-tool detection retired, daemon-side validateMemoryWrite handles it)", async () => {
    // R4: same as above — tool passes content through, daemon validates.
    const rpcCall = vi.fn(async () => ({ stored: true }));
    const tool = createMemoryStoreTool(rpcCall);

    const result = await tool.execute("call-7", {
      content: "My OpenAI key is sk-abcdefghij1234567890abcdefghij",
    });

    expect(rpcCall).toHaveBeenCalledOnce();
    // No in-tool warning after R4 retirement
    expect(result.details).not.toHaveProperty("warning");
  });

  it("does not warn for normal content", async () => {
    const rpcCall = vi.fn(async () => ({ stored: true, id: "mem-008" }));
    const tool = createMemoryStoreTool(rpcCall);

    const result = await tool.execute("call-8", {
      content: "User prefers dark mode and TypeScript",
    });

    expect(result.details).toEqual(
      expect.objectContaining({ stored: true, id: "mem-008" }),
    );
    expect(result.details).not.toHaveProperty("warning");
  });
});

// ---------------------------------------------------------------------------
// R4 retirement: memory-store-tool SECRET_PATTERNS
// ---------------------------------------------------------------------------

describe("R4 retirement: private SECRET_PATTERNS retired", () => {
  it("does NOT have a private SECRET_PATTERNS constant (retired in favor of validateMemoryWrite)", async () => {
    // Read the actual source file and assert SECRET_PATTERNS is gone
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const sourceText = readFileSync(join(__dirname, "memory-store-tool.ts"), "utf-8");
    expect(sourceText).not.toContain("SECRET_PATTERNS");
  });
});
