// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LabelSpec registry + theme-merge resolver (ACT-08, spec
 * §6.1/§6.2). Resolution precedence is THEME-OVERRIDE > REGISTERED > SEMANTIC
 * FALLBACK, applied as a deep merge (an override of one field preserves the
 * others). Pure resolution; no logger.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerActivityLabelSpec,
  resolveLabelSpec,
  _clearActivityLabelSpecsForTest,
  type ActivityTheme,
} from "./label-spec.js";

beforeEach(() => {
  _clearActivityLabelSpecsForTest();
});

describe("resolveLabelSpec", () => {
  it("returns the registered tool-level spec when a tool is registered and no theme overrides it", () => {
    registerActivityLabelSpec("mcp_manage", {
      semanticPhase: "tool",
      label: "managing MCP servers",
      detail: "MCP control plane",
    });
    const resolved = resolveLabelSpec("mcp_manage");

    expect(resolved.semanticPhase).toBe("tool");
    expect(resolved.label).toBe("managing MCP servers");
    expect(resolved.detail).toBe("MCP control plane");
  });

  it("selects the per-action registered spec when an action is supplied", () => {
    registerActivityLabelSpec("mcp_manage", {
      semanticPhase: "tool",
      actions: {
        set: { label: "configuring MCP server `{name}`", detailKeys: ["name"] },
        list: { label: "listing MCP servers" },
      },
    });
    const resolved = resolveLabelSpec("mcp_manage", { action: "set" });

    expect(resolved.label).toBe("configuring MCP server `{name}`");
    expect(resolved.detailKeys).toEqual(["name"]);
    expect(resolved.semanticPhase).toBe("tool");
  });

  it("lets a theme override take precedence over the registered spec", () => {
    registerActivityLabelSpec("mcp_manage", {
      semanticPhase: "tool",
      label: "managing MCP servers",
    });
    const theme: ActivityTheme = {
      tools: { mcp_manage: { label: "[mcp] servers" } },
    };
    const resolved = resolveLabelSpec("mcp_manage", { theme });

    // Theme-override wins over the registered label.
    expect(resolved.label).toBe("[mcp] servers");
  });

  it("deep-merges a theme override of one field while inheriting the registered others", () => {
    registerActivityLabelSpec("mcp_manage", {
      semanticPhase: "tool",
      label: "managing MCP servers",
      detail: "MCP control plane",
      detailKeys: ["name"],
    });
    const theme: ActivityTheme = {
      // Theme overrides ONLY the label.
      tools: { mcp_manage: { label: "[mcp]" } },
    };
    const resolved = resolveLabelSpec("mcp_manage", { theme });

    expect(resolved.label).toBe("[mcp]"); // overridden
    expect(resolved.detail).toBe("MCP control plane"); // inherited (merge, not replace)
    expect(resolved.detailKeys).toEqual(["name"]); // inherited
    expect(resolved.semanticPhase).toBe("tool"); // inherited
  });

  it("falls back to a semantic-classifier spec for an unregistered tool", () => {
    // No registration for memory_search → semantic fallback derives the phase
    // from classifySemanticPhase("memory_search") === "memory".
    const resolved = resolveLabelSpec("memory_search");

    expect(resolved.semanticPhase).toBe("memory");
    // The fallback still produces a usable (humanized) label, never undefined.
    expect(typeof resolved.label).toBe("string");
    expect(resolved.label.length).toBeGreaterThan(0);
  });

  it("applies a theme override on top of a semantic fallback for an unregistered tool", () => {
    // Precedence holds even with no registered spec: theme > semantic fallback.
    const theme: ActivityTheme = {
      tools: { web_search: { label: "searching the web" } },
    };
    const resolved = resolveLabelSpec("web_search", { theme });

    expect(resolved.semanticPhase).toBe("web"); // from classifier
    expect(resolved.label).toBe("searching the web"); // from theme
  });

  it("honors a theme-supplied semanticPhase override over the registered phase", () => {
    registerActivityLabelSpec("custom_tool", {
      semanticPhase: "tool",
      label: "running custom tool",
    });
    const theme: ActivityTheme = {
      tools: { custom_tool: { semanticPhase: "coding" } },
    };
    const resolved = resolveLabelSpec("custom_tool", { theme });

    expect(resolved.semanticPhase).toBe("coding"); // theme wins
    expect(resolved.label).toBe("running custom tool"); // inherited from registered
  });
});
