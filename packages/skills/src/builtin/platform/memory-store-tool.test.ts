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

  it("warns when content contains a Google API key", async () => {
    const rpcCall = vi.fn(async () => ({ stored: true, id: "mem-006" }));
    const tool = createMemoryStoreTool(rpcCall);

    const result = await tool.execute("call-6", {
      content: "Here is my Gemini API key AIzaSyCe8FynsFS4XSnMdShiJuuujxVhViwSh_I",
    });

    // Should still store it
    expect(rpcCall).toHaveBeenCalledOnce();
    // But should include a warning
    expect(result.details).toEqual(
      expect.objectContaining({
        warning: expect.stringContaining("API key"),
      }),
    );
  });

  it("warns when content contains an OpenAI API key", async () => {
    const rpcCall = vi.fn(async () => ({ stored: true }));
    const tool = createMemoryStoreTool(rpcCall);

    const result = await tool.execute("call-7", {
      content: "My OpenAI key is sk-abcdefghij1234567890abcdefghij",
    });

    expect(rpcCall).toHaveBeenCalledOnce();
    expect(result.details).toEqual(
      expect.objectContaining({
        warning: expect.stringContaining("API key"),
      }),
    );
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
