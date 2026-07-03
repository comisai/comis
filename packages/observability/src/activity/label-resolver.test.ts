// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the typed-first label-resolver.
 *
 * Behavior under test:
 *   - typed-first: a registered `mcp_manage` LabelSpec + `applyTemplate` yields
 *     ``"configuring MCP server `X`"`` from `{action:"set", name:"X"}`.
 *   - unknown tool → a semantic-derived fallback label (via classifySemanticPhase
 *     + humanized tool name), never null.
 *   - `metadata.suppressActivity === true` → returns `null` (no activity).
 *   - `resolveLabelDetailed` surfaces `redactionsApplied` upward so the
 *     ActivityStream owns the redaction WARN (the resolver stays pure, no logger).
 */
import { describe, it, expect } from "vitest";
import { registerActivityLabelSpec } from "@comis/core";
import { resolveLabel, resolveLabelDetailed } from "./label-resolver.js";

// The label-spec registry is a module-level singleton with no barrel-exported
// reset (`_clearActivityLabelSpecsForTest` is intentionally NOT public).
// Each test registers a UNIQUE tool name so there is zero cross-test
// interference without needing a registry clear.

describe("resolveLabel (typed-first)", () => {
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
    registerActivityLabelSpec("channels_manage", {
      actions: {
        set: { label: "configuring channel `{name}`", detailKeys: ["name"] },
      },
    });
    const label = resolveLabel(
      "channels_manage",
      { action: "set", name: "X", command: "should-be-dropped" },
      {},
    );
    expect(label).toBe("configuring channel `X`");
  });

  it("surfaces redactionsApplied upward via resolveLabelDetailed for the redaction WARN", () => {
    registerActivityLabelSpec("secrets_manage", {
      actions: {
        set: { label: "configuring `{token}`", detailKeys: ["token"] },
      },
    });
    const detailed = resolveLabelDetailed(
      "secrets_manage",
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
