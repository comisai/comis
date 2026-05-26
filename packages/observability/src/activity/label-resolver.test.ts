// SPDX-License-Identifier: Apache-2.0
/**
 * RED test for the typed-first label-resolver (STRAT-10, spec §6.1).
 *
 * Fails on pre-patch code: `./label-resolver.js` does not exist.
 *
 * Behavior under test:
 *   - typed-first: a registered `mcp_manage` LabelSpec + `applyTemplate` yields
 *     ``"configuring MCP server `X`"`` from `{action:"set", name:"X"}`.
 *   - unknown tool → a semantic-derived fallback label (via classifySemanticPhase
 *     + humanized tool name), never null.
 *   - `metadata.suppressActivity === true` → returns `null` (no activity).
 *   - `resolveLabelDetailed` surfaces `redactionsApplied` upward so the
 *     ActivityStream owns the OBS-03 WARN (the resolver stays pure, no logger).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerActivityLabelSpec,
  _clearActivityLabelSpecsForTest,
} from "@comis/core";
import { resolveLabel, resolveLabelDetailed } from "./label-resolver.js";

describe("resolveLabel (STRAT-10 / spec §6.1 — typed-first)", () => {
  beforeEach(() => {
    _clearActivityLabelSpecsForTest();
  });

  it("resolves mcp_manage(action=set, name=X) to the typed template label", () => {
    registerActivityLabelSpec("mcp_manage", {
      semanticPhase: "tool",
      actions: {
        set: { label: "configuring MCP server `{name}`", detailKeys: ["name"] },
      },
    });
    const label = resolveLabel("mcp_manage", { action: "set", name: "X" }, {});
    expect(label).toBe("configuring MCP server `X`");
  });

  it("falls back to a semantic-derived humanized label for an unknown tool", () => {
    const label = resolveLabel("web_search", { query: "anything" }, {});
    // No registered spec → humanized tool name fallback ("web search").
    expect(label).toBe("web search");
  });

  it("returns null when the tool metadata declares suppressActivity:true", () => {
    const label = resolveLabel(
      "memory_search",
      { key: "secret-stuff" },
      { metadata: { suppressActivity: true } },
    );
    expect(label).toBeNull();
  });

  it("renders a label even when params carry an undeclared key (allowlist drops it)", () => {
    registerActivityLabelSpec("mcp_manage", {
      actions: {
        set: { label: "configuring MCP server `{name}`", detailKeys: ["name"] },
      },
    });
    const label = resolveLabel(
      "mcp_manage",
      { action: "set", name: "X", command: "should-be-dropped" },
      {},
    );
    expect(label).toBe("configuring MCP server `X`");
  });

  it("surfaces redactionsApplied upward via resolveLabelDetailed for the OBS-03 WARN", () => {
    registerActivityLabelSpec("mcp_manage", {
      actions: {
        set: { label: "configuring `{token}`", detailKeys: ["token"] },
      },
    });
    const detailed = resolveLabelDetailed(
      "mcp_manage",
      { action: "set", token: "sk-ant-secretsecretsecret" },
      {},
    );
    expect(detailed).not.toBeNull();
    // The `token` key triggers key-based redaction (RedactionReason: secret_key).
    expect(detailed?.redactionsApplied.length).toBeGreaterThan(0);
    expect(detailed?.label).not.toContain("sk-ant-secretsecretsecret");
  });

  it("resolveLabelDetailed returns null under suppressActivity", () => {
    const detailed = resolveLabelDetailed(
      "discover_tools",
      {},
      { metadata: { suppressActivity: true } },
    );
    expect(detailed).toBeNull();
  });
});
