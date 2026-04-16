import { describe, it, expect } from "vitest";
import { createToolDisplayNames } from "./tool-display-names.js";

describe("createToolDisplayNames", () => {
  it("returns display name for a registered built-in tool", () => {
    const registry = createToolDisplayNames();
    expect(registry.getDisplayName("read")).toBe("Read File");
    expect(registry.getDisplayName("edit")).toBe("Edit File");
    expect(registry.getDisplayName("web_search")).toBe("Web Search");
  });

  it("returns the raw toolName when no mapping exists", () => {
    const registry = createToolDisplayNames();
    expect(registry.getDisplayName("unknown_tool")).toBe("unknown_tool");
    expect(registry.getDisplayName("my_custom_plugin")).toBe("my_custom_plugin");
  });

  it("register adds a new mapping", () => {
    const registry = createToolDisplayNames();
    registry.register("my_tool", "My Custom Tool");
    expect(registry.getDisplayName("my_tool")).toBe("My Custom Tool");
  });

  it("register overwrites an existing mapping", () => {
    const registry = createToolDisplayNames();
    registry.register("read", "File Reader");
    expect(registry.getDisplayName("read")).toBe("File Reader");
  });

  it("registerAll adds multiple mappings at once", () => {
    const registry = createToolDisplayNames();
    registry.registerAll({
      tool_a: "Tool Alpha",
      tool_b: "Tool Beta",
    });
    expect(registry.getDisplayName("tool_a")).toBe("Tool Alpha");
    expect(registry.getDisplayName("tool_b")).toBe("Tool Beta");
  });

  it("registerAll overwrites existing mappings", () => {
    const registry = createToolDisplayNames();
    registry.registerAll({
      read: "Custom Read",
      write: "Custom Write",
    });
    expect(registry.getDisplayName("read")).toBe("Custom Read");
    expect(registry.getDisplayName("write")).toBe("Custom Write");
  });

  it("default builtins are pre-registered", () => {
    const registry = createToolDisplayNames();
    const all = registry.getAll();
    expect(all.get("read")).toBe("Read File");
    expect(all.get("edit")).toBe("Edit File");
    expect(all.get("write")).toBe("Write File");
    expect(all.get("grep")).toBe("Search Files");
    expect(all.get("find")).toBe("Find Files");
    expect(all.get("ls")).toBe("List Directory");
    expect(all.get("web_search")).toBe("Web Search");
    expect(all.get("web_fetch")).toBe("Fetch URL");
    expect(all.get("exec")).toBe("Run Command");
    expect(all.get("process")).toBe("Manage Process");
    expect(all.get("apply_patch")).toBe("Apply Patch");
    expect(all.get("mcp_call")).toBe("MCP Tool Call");
    expect(all.size).toBe(12);
  });

  it("custom defaults override builtins at construction time", () => {
    const registry = createToolDisplayNames({
      read: "Custom Reader",
      special_tool: "Special Tool",
    });
    expect(registry.getDisplayName("read")).toBe("Custom Reader");
    expect(registry.getDisplayName("special_tool")).toBe("Special Tool");
    // Other builtins still present
    expect(registry.getDisplayName("edit")).toBe("Edit File");
  });

  it("getAll returns a ReadonlyMap", () => {
    const registry = createToolDisplayNames();
    const all = registry.getAll();
    // ReadonlyMap should not have set/delete
    expect(typeof (all as any).set).toBe("undefined");
  });

  it("getAll reflects registrations made after construction", () => {
    const registry = createToolDisplayNames();
    registry.register("new_tool", "New Tool");
    const all = registry.getAll();
    expect(all.get("new_tool")).toBe("New Tool");
  });
});
