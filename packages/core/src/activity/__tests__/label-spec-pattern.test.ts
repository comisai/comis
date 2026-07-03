// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the MCP pattern catch-all in resolveLabelSpec.
 *
 * MCP tools are discovered at runtime — they have no co-located source file in
 * this monorepo to register a label spec on. Without the catch-all,
 * resolveLabelSpec falls through to humanizeToolName, which translates `_` →
 * ` ` but leaves the `__` between the `mcp` prefix and the server name
 * (becomes a double space) and the `--` between the server name and the method
 * (left as a literal `--`) — so `mcp__yfinance--get_stock_price` would render
 * as `mcp  yfinance--get stock price` in the scaffold.
 *
 * The pattern `^mcp__<server>--<method>$` synthesizes
 * `using <server> · <method humanized>` as a Layer 2.5 fallback — fires ONLY
 * when no spec is registered for the tool name, preserving Layer 2 (registered)
 * and Layer 3 (theme) precedence above it.
 *
 * Resolution precedence: theme > registered > pattern > semantic fallback.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerActivityLabelSpec,
  resolveLabelSpec,
  _clearActivityLabelSpecsForTest,
  type ActivityTheme,
} from "../label-spec.js";

beforeEach(() => {
  _clearActivityLabelSpecsForTest();
});

describe("resolveLabelSpec — MCP pattern catch-all", () => {
  it("synthesizes 'using <server> · <method>' for mcp__<server>--<method> (yfinance get_stock_price)", () => {
    // Without the pattern hook, humanizeToolName yields
    // `"mcp  yfinance--get stock price"` (double space from `__`, literal `--`
    // preserved). The pattern hook matches first and synthesizes the clean form.
    const resolved = resolveLabelSpec("mcp__yfinance--get_stock_price");

    expect(resolved.semanticPhase).toBe("tool");
    expect(resolved.label).toBe("using yfinance · get stock price");
  });

  it("humanizes underscores within the method segment (github create_pull_request)", () => {
    // Confirms `_` → ` ` translation runs INSIDE the method segment after the
    // `--` separator is consumed, so multi-word methods render naturally.
    const resolved = resolveLabelSpec("mcp__github--create_pull_request");

    expect(resolved.semanticPhase).toBe("tool");
    expect(resolved.label).toBe("using github · create pull request");
  });

  it("does NOT hijack non-MCP tool names — the humanize fallback still wins for 'read'", () => {
    // Guards against the pattern hook accidentally matching arbitrary tool
    // names. `read` has no `mcp__` prefix, so the regex must NOT match and the
    // existing semantic-classifier humanize fallback must produce `"read"`.
    const resolved = resolveLabelSpec("read");

    expect(resolved.label).toBe("read");
  });

  it("yields to an explicitly registered spec for the same tool name (Layer 2 > pattern)", () => {
    // Asserts the pattern hook is gated by `registered === undefined`. If a
    // codebase explicitly registers a spec for an mcp__server--tool name (e.g.
    // a curated, branded label), that registration MUST win over the pattern.
    registerActivityLabelSpec("mcp__special--tool", {
      semanticPhase: "tool",
      label: "doing something special",
    });

    const resolved = resolveLabelSpec("mcp__special--tool");

    expect(resolved.label).toBe("doing something special");
  });

  it("yields to a theme override for the same tool name (Layer 3 > pattern)", () => {
    // Asserts the pattern hook does NOT shadow a theme override. A theme
    // rebrand for a specific MCP tool MUST win over the catch-all — the
    // pattern occupies Layer 2.5, the theme stays on top at Layer 3.
    const theme: ActivityTheme = {
      tools: {
        "mcp__yfinance--get_stock_price": { label: "[yf] stock price" },
      },
    };

    const resolved = resolveLabelSpec("mcp__yfinance--get_stock_price", { theme });

    expect(resolved.label).toBe("[yf] stock price");
  });
});
