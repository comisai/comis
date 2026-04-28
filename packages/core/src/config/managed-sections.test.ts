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
  // 260428-oyc Task 1.4: rephrased Recovery wording -- single-step "Recovery: call <tool>(<example>)."
  // (the discover_tools clause is dropped; on Anthropic Sonnet/Opus 4.x the model never has a
  // discover_tools tool to call, and on every provider the dedicated tool auto-loads on first
  // direct invocation).
  it("emits single-step Recovery framing for fullyManaged entries", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain('Use the "agents_manage" tool');
    expect(hint).toContain("Recovery: call agents_manage(");
    expect(hint).toContain('"action":"create"');
    expect(hint).toContain('"agent_id":"<new-agent-id>"');
    // The literal "discover_tools" must NOT appear -- regression pin for 260428-oyc.
    expect(hint).not.toContain("discover_tools");
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

  it("emits 'Call <tool> directly' when redirect has no exampleArgs (no discover_tools mention)", () => {
    const redirect = getManagedSectionRedirect("channels", "telegram.allowFrom")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).not.toContain("Recovery: call");
    expect(hint).toContain("Call channels_manage directly");
    expect(hint).toContain("auto-load on first invocation");
    expect(hint).not.toContain("discover_tools");
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

  // -------------------------------------------------------------------------
  // 260428-oyc Task 1.5: D1-D5 regression tests (drop discover_tools from
  // every formatRedirectHint output path).
  // -------------------------------------------------------------------------

  it("D1: NO MANAGED_SECTIONS entry produces a hint containing 'discover_tools'", () => {
    for (const entry of MANAGED_SECTIONS) {
      const hint = formatRedirectHint(entry);
      expect(hint, `entry pathPrefix=${entry.pathPrefix}`).not.toContain("discover_tools");
      // Also test the mutablePaths variant.
      const hintWithPaths = formatRedirectHint(entry, [`${entry.pathPrefix}.someField`]);
      expect(hintWithPaths, `entry pathPrefix=${entry.pathPrefix} (with mutablePaths)`).not.toContain(
        "discover_tools",
      );
    }
  });

  it("D2: WITH exampleArgs -> 'Recovery: call <tool>(<example>).' single-step framing (no parenthesized numbering)", () => {
    for (const entry of MANAGED_SECTIONS) {
      if (!entry.exampleArgs) continue;
      const hint = formatRedirectHint(entry);
      expect(hint, `entry ${entry.pathPrefix}`).toContain(`Recovery: call ${entry.tool}(`);
      // No "(1)" / "(2)" parenthesized step numbering.
      expect(hint, `entry ${entry.pathPrefix}`).not.toContain("(1)");
      expect(hint, `entry ${entry.pathPrefix}`).not.toContain("(2)");
      expect(hint, `entry ${entry.pathPrefix}`).not.toContain("then");
    }
  });

  it("D3: WITHOUT exampleArgs -> 'Call <tool> directly; it will auto-load on first invocation.'", () => {
    const channelsRedirect = getManagedSectionRedirect("channels", "telegram.allowFrom")!;
    expect(channelsRedirect.exampleArgs).toBeUndefined();
    const hint = formatRedirectHint(channelsRedirect);
    expect(hint).toContain("Call channels_manage directly");
    expect(hint).toContain("auto-load on first invocation");
  });

  it("D4: schemaFragment lines (Tool actions / Required fields) still emitted on agents entry", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain(
      "Tool actions: create, get, update, delete, suspend, resume",
    );
    expect(hint).toContain("Required fields for `create`: agent_id, config");
  });

  it("D5: JSON-stringified exampleArgs round-trips through formatted output", () => {
    for (const entry of MANAGED_SECTIONS) {
      if (!entry.exampleArgs) continue;
      const hint = formatRedirectHint(entry);
      // Extract the JSON object inside `Recovery: call <tool>(...).`. The example
      // is the largest balanced { ... } in the hint; a regex that captures
      // everything between the first '{' after the tool name and the matching '})' is sufficient.
      const recoveryToken = `Recovery: call ${entry.tool}(`;
      const start = hint.indexOf(recoveryToken);
      expect(start, `entry ${entry.pathPrefix}: Recovery prefix missing`).toBeGreaterThanOrEqual(0);
      const jsonStart = start + recoveryToken.length;
      // Walk forward to find the matching ')' that closes the call (after the JSON object).
      // Since the JSON is compact JSON.stringify output, brace-counting is sufficient.
      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < hint.length; i++) {
        const ch = hint[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      expect(jsonEnd, `entry ${entry.pathPrefix}: balanced JSON not found`).toBeGreaterThan(0);
      const jsonText = hint.slice(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonText);
      expect(parsed, `entry ${entry.pathPrefix}: round-trip mismatch`).toEqual(entry.exampleArgs);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug B (260428-gj6): schemaFragment inline in rejection hint
// ---------------------------------------------------------------------------

describe("schemaFragment (Bug B)", () => {
  it("agents (agents_manage) lists exact action enum from agents-manage-tool.ts", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    expect(redirect.schemaFragment).toBeDefined();
    // Pinned to the TypeBox Union literals in agents-manage-tool.ts:25-33.
    expect(redirect.schemaFragment!.actions).toEqual([
      "create",
      "get",
      "update",
      "delete",
      "suspend",
      "resume",
    ]);
    // Required fields for create -- agent_id is required (Type.String, not Optional);
    // config is logically required for create even though Type.Optional in the schema
    // (the action handler rejects create without a config payload).
    expect(redirect.schemaFragment!.requiredByAction).toBeDefined();
    expect(redirect.schemaFragment!.requiredByAction!.create).toEqual([
      "agent_id",
      "config",
    ]);
  });

  it("integrations.mcp.servers (mcp_manage) lists exact action enum from mcp-manage-tool.ts", () => {
    const redirect = getManagedSectionRedirect("integrations", "mcp.servers")!;
    expect(redirect.schemaFragment).toBeDefined();
    // Pinned to the TypeBox Union literals in mcp-manage-tool.ts:25-31.
    expect(redirect.schemaFragment!.actions).toEqual([
      "list",
      "status",
      "connect",
      "disconnect",
      "reconnect",
    ]);
    // Required-for-stdio-connect set: name + transport always; command for stdio.
    expect(redirect.schemaFragment!.requiredByAction!.connect).toEqual([
      "name",
      "transport",
      "command",
    ]);
  });

  it("gateway.tokens (tokens_manage) lists exact action enum from tokens-manage-tool.ts", () => {
    const redirect = getManagedSectionRedirect("gateway", "tokens")!;
    expect(redirect.schemaFragment).toBeDefined();
    // Pinned to the TypeBox Union literals in tokens-manage-tool.ts:25-31.
    expect(redirect.schemaFragment!.actions).toEqual([
      "list",
      "create",
      "revoke",
      "rotate",
    ]);
    // token_id is genuinely Optional (auto-generated when omitted); the schema
    // description at L41 marks scopes as required for create.
    expect(redirect.schemaFragment!.requiredByAction!.create).toEqual(["scopes"]);
  });

  it("channels (channels_manage) lists exact action enum from channels-manage-tool.ts", () => {
    const redirect = getManagedSectionRedirect("channels", "telegram.allowFrom")!;
    expect(redirect.schemaFragment).toBeDefined();
    // Pinned to the TypeBox Union literals in channels-manage-tool.ts:32-37.
    expect(redirect.schemaFragment!.actions).toEqual([
      "list",
      "get",
      "enable",
      "disable",
      "restart",
      "configure",
    ]);
    // No requiredByAction -- channels_manage operates on existing entries only,
    // no create-equivalent action.
    expect(redirect.schemaFragment!.requiredByAction).toBeUndefined();
  });

  it("formatRedirectHint includes a 'Tool actions:' line listing the enum when schemaFragment is present", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain("Tool actions:");
    expect(hint).toContain("create");
    expect(hint).toContain("update");
    expect(hint).toContain("suspend");
  });

  it("formatRedirectHint includes a 'Required fields for `<action>`:' line per requiredByAction entry", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    const hint = formatRedirectHint(redirect);
    expect(hint).toContain("Required fields for `create`: agent_id, config");
  });

  it("formatRedirectHint omits the 'Tool actions:' line when schemaFragment is absent", () => {
    const fakeRedirect = {
      pathPrefix: "synthetic",
      tool: "synthetic_tool",
      description: "Synthetic test tool.",
      fullyManaged: true,
      exampleArgs: { action: "noop" },
    } as const;
    const hint = formatRedirectHint(fakeRedirect);
    expect(hint).not.toContain("Tool actions:");
    expect(hint).not.toContain("Required fields for");
  });

  it("formatRedirectHint positions schema fragment AFTER Recovery example and BEFORE mutablePaths block", () => {
    const redirect = getManagedSectionRedirect("agents")!;
    const hint = formatRedirectHint(redirect, ["agents.coding.model"]);
    // 260428-oyc: Recovery is now a single-step "Recovery: call <tool>(<example>)." line.
    const recoveryIdx = hint.indexOf("Recovery: call agents_manage(");
    const actionsIdx = hint.indexOf("Tool actions:");
    const mutableIdx = hint.indexOf("entry that ALREADY exists");
    expect(recoveryIdx).toBeGreaterThanOrEqual(0);
    expect(actionsIdx).toBeGreaterThan(recoveryIdx);
    expect(mutableIdx).toBeGreaterThan(actionsIdx);
  });

  it("schemaFragment lines emit deterministic order matching the actions tuple", () => {
    const redirect = getManagedSectionRedirect("integrations", "mcp.servers")!;
    const hint = formatRedirectHint(redirect);
    // Verify the comma-joined list matches the tuple order exactly.
    expect(hint).toContain(
      "Tool actions: list, status, connect, disconnect, reconnect",
    );
    expect(hint).toContain(
      "Required fields for `connect`: name, transport, command",
    );
  });
});
