import { describe, it, expect, vi } from "vitest";
import { createMemoryGetTool } from "./memory-get-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "memory.get_file") {
      return {
        path: "notes/preferences.md",
        content: "# User Preferences\n\n- Dark mode: enabled\n- Language: en",
        lines: 4,
      };
    }
    return { stub: true, method, params: _params };
  });
}

describe("memory_get tool", () => {
  it("calls rpcCall with path", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemoryGetTool(rpcCall);

    const result = await tool.execute("call-1", { path: "notes/preferences.md" });

    expect(rpcCall).toHaveBeenCalledWith("memory.get_file", {
      path: "notes/preferences.md",
    });
    expect(result.details).toEqual(
      expect.objectContaining({ path: "notes/preferences.md", lines: 4 }),
    );
  });

  it("passes start_line and end_line when provided", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemoryGetTool(rpcCall);

    await tool.execute("call-2", {
      path: "notes/preferences.md",
      start_line: 2,
      end_line: 4,
    });

    expect(rpcCall).toHaveBeenCalledWith("memory.get_file", {
      path: "notes/preferences.md",
      startLine: 2,
      endLine: 4,
    });
  });

  it("throws when path is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemoryGetTool(rpcCall);

    await expect(tool.execute("call-3", {})).rejects.toThrow("Missing required parameter: path");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("throws on rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("File not found");
    });
    const tool = createMemoryGetTool(rpcCall);

    await expect(tool.execute("call-4", { path: "nonexistent.md" })).rejects.toThrow(
      "File not found",
    );
  });
});
