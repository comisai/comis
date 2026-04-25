// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  MANAGED_SECTIONS,
  getManagedSectionRedirect,
  formatRedirectHint,
} from "./managed-sections.js";

describe("MANAGED_SECTIONS", () => {
  it("entries are ordered longest-prefix-first", () => {
    const lengths = MANAGED_SECTIONS.map((s) => s.pathPrefix.length);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i - 1]).toBeGreaterThanOrEqual(lengths[i]!);
    }
  });

  it("every fullyManaged entry has exampleArgs", () => {
    for (const s of MANAGED_SECTIONS) {
      if (s.fullyManaged) expect(s.exampleArgs).toBeDefined();
    }
  });

  it("exampleArgs always include an action field", () => {
    for (const s of MANAGED_SECTIONS) {
      if (s.exampleArgs) expect(s.exampleArgs).toHaveProperty("action");
    }
  });
});

describe("getManagedSectionRedirect", () => {
  it("redirects gateway/apply on agents to agents_manage", () => {
    expect(getManagedSectionRedirect("agents")?.tool).toBe("agents_manage");
  });

  it("redirects gateway/patch on agents.<newId> to agents_manage", () => {
    expect(getManagedSectionRedirect("agents", "coding")?.tool).toBe("agents_manage");
  });

  it("longer prefix wins: integrations.mcp.servers -> mcp_manage", () => {
    expect(getManagedSectionRedirect("integrations", "mcp.servers")?.tool).toBe(
      "mcp_manage",
    );
    expect(getManagedSectionRedirect("integrations", "mcp.servers.0")?.tool).toBe(
      "mcp_manage",
    );
  });

  it("redirects gateway.tokens to tokens_manage", () => {
    expect(getManagedSectionRedirect("gateway", "tokens")?.tool).toBe("tokens_manage");
  });

  it("redirects channels paths to channels_manage", () => {
    expect(getManagedSectionRedirect("channels", "telegram.allowFrom")?.tool).toBe(
      "channels_manage",
    );
  });

  it("returns undefined for sections without a managed tool", () => {
    expect(getManagedSectionRedirect("security")).toBeUndefined();
    expect(getManagedSectionRedirect("monitoring")).toBeUndefined();
    expect(getManagedSectionRedirect("daemon", "logging")).toBeUndefined();
  });

  it("returns undefined for empty section", () => {
    expect(getManagedSectionRedirect("")).toBeUndefined();
    expect(getManagedSectionRedirect(undefined)).toBeUndefined();
  });

  it("does NOT match parent paths (integrations alone is too broad)", () => {
    expect(getManagedSectionRedirect("integrations")).toBeUndefined();
  });
});

describe("formatRedirectHint", () => {
  it("emits two-step Recovery framing for fullyManaged entries", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain('Use the "agents_manage" tool');
    expect(hint).toContain('Recovery: (1) call discover_tools("agents_manage")');
    expect(hint).toContain("(2) call agents_manage(");
    expect(hint).toContain('"action":"create"');
    expect(hint).toContain('"agent_id":"<new-agent-id>"');
  });

  it("includes mutable paths when provided", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    const hint = formatRedirectHint(redirect, [
      "agents.coding.model",
      "agents.coding.persona",
    ]);
    expect(hint).toContain("agents.coding.model");
    expect(hint).toContain("entry that ALREADY exists");
  });

  it("warns when the tool is not fullyManaged", () => {
    const redirect = getManagedSectionRedirect("channels", "telegram.allowFrom")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain(
      "brand-new platform types still requires operator config edits",
    );
  });

  it("omits Recovery example when redirect has no exampleArgs", () => {
    const redirect = getManagedSectionRedirect("channels", "telegram.allowFrom")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).not.toContain("Recovery: (1)");
    expect(hint).toContain("Load it via discover_tools");
  });

  it("MCP example uses flat parameter shape (not nested config)", () => {
    const redirect = getManagedSectionRedirect("integrations", "mcp.servers")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain('"transport":"stdio"');
    expect(hint).toContain('"command":"<command>"');
    expect(hint).not.toContain('"config":{"transport"');
  });

  it("tokens example uses flat parameter shape", () => {
    const redirect = getManagedSectionRedirect("gateway", "tokens")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain('"action":"create"');
    expect(hint).toContain('"token_id":"<token-id>"');
    expect(hint).toContain('"scopes":["rpc","ws"]');
  });
});
