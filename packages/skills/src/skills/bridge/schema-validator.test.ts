// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { ComisToolMetadata } from "@comis/core";
import { validateToolEntry } from "./schema-validator.js";

// ---------------------------------------------------------------------------
// Fixture: mcp_manage entry-shape metadata.
// ---------------------------------------------------------------------------

const MCP_META: ComisToolMetadata = {
  validActions: ["list", "status", "connect", "disconnect", "reconnect"],
  validKeys: ["action", "name", "transport", "command", "args", "url", "headers"],
  requiredByAction: {
    status: ["name"],
    connect: ["name", "transport"],
    disconnect: ["name"],
    reconnect: ["name"],
  },
};

const ACTIONS_ONLY_META: ComisToolMetadata = {
  validActions: ["list", "connect", "disconnect"],
};

// Metadata with NO entry-shape fields registered (e.g. exec, cron pre-existing
// tools). The validator MUST be a silent no-op for these.
const NO_SHAPE_META: ComisToolMetadata = {
  isReadOnly: true,
  maxResultSizeChars: 1000,
};

// ---------------------------------------------------------------------------
// Shape errors
// ---------------------------------------------------------------------------

describe("validateToolEntry -- shape errors", () => {
  it("rejects null params", () => {
    const result = validateToolEntry(null, MCP_META);
    expect(result).toContain("params must be an object");
  });

  it("rejects undefined params", () => {
    const result = validateToolEntry(undefined, MCP_META);
    expect(result).toContain("params must be an object");
  });

  it("rejects primitive params (string)", () => {
    const result = validateToolEntry("hi", MCP_META);
    expect(result).toContain("params must be an object");
  });

  it("rejects array params (Array.isArray gate)", () => {
    const result = validateToolEntry([], MCP_META);
    expect(result).toContain("params must be an object");
  });
});

// ---------------------------------------------------------------------------
// Action gate (validActions registered)
// ---------------------------------------------------------------------------

describe("validateToolEntry -- action gate", () => {
  it("rejects missing action with valid-action list", () => {
    const result = validateToolEntry({}, MCP_META);
    expect(result).toContain("Missing required parameter: action");
    expect(result).toContain("list");
    expect(result).toContain("connect");
  });

  it("rejects non-string action", () => {
    const result = validateToolEntry({ action: 42 }, MCP_META);
    expect(result).toContain("action must be a string");
  });

  it("rejects typo action with did-you-mean suggestion", () => {
    const result = validateToolEntry({ action: "conect" }, ACTIONS_ONLY_META);
    expect(result).toContain("invalid action 'conect'");
    expect(result).toContain("did you mean 'connect'?");
    // Full valid-action list surfaces in the message.
    expect(result).toContain("list");
    expect(result).toContain("connect");
    expect(result).toContain("disconnect");
  });

  it("rejects unrelated action without misleading did-you-mean", () => {
    const result = validateToolEntry({ action: "foobar" }, ACTIONS_ONLY_META);
    expect(result).toContain("invalid action 'foobar'");
    expect(result).not.toContain("did you mean");
    expect(result).toContain("list");
    expect(result).toContain("connect");
  });
});

// ---------------------------------------------------------------------------
// Unknown-key gate (validKeys registered)
// ---------------------------------------------------------------------------

describe("validateToolEntry -- unknown key gate", () => {
  it("flags unknown 'server_name' with did-you-mean 'name'", () => {
    const result = validateToolEntry(
      { action: "connect", server_name: "x", transport: "stdio", command: "/usr/bin/x" },
      MCP_META,
    );
    expect(result).toContain("unknown key 'server_name'");
    expect(result).toContain("did you mean 'name'?");
    expect(result).toContain("valid keys:");
    expect(result).toContain("name");
    expect(result).toContain("transport");
  });

  it("flags unknown short key without misleading did-you-mean", () => {
    const result = validateToolEntry(
      { action: "connect", name: "x", transport: "stdio", x: 1 },
      MCP_META,
    );
    expect(result).toContain("unknown key 'x'");
    expect(result).not.toContain("did you mean");
  });

  it("reports multiple unknown keys in one message", () => {
    const result = validateToolEntry(
      { action: "connect", name: "x", transport: "stdio", server_name: "y", srver: "z" },
      MCP_META,
    );
    expect(result).toContain("unknown key 'server_name'");
    expect(result).toContain("unknown key 'srver'");
  });
});

// ---------------------------------------------------------------------------
// Required-fields gate (requiredByAction registered)
// ---------------------------------------------------------------------------

describe("validateToolEntry -- required-fields gate", () => {
  it("lists all missing required fields for connect", () => {
    const result = validateToolEntry({ action: "connect" }, MCP_META);
    expect(result).toContain("missing for action='connect':");
    expect(result).toContain("name");
    expect(result).toContain("transport");
  });

  it("lists only the still-missing subset", () => {
    const result = validateToolEntry({ action: "connect", name: "x" }, MCP_META);
    expect(result).toContain("missing for action='connect':");
    expect(result).toContain("transport");
    // 'name' is satisfied -- it must not appear in the missing list.
    // Use a regex anchored at "missing for action='connect': " to scope.
    const missingSection = /missing for action='connect': ([^.]+)/.exec(result ?? "");
    expect(missingSection).not.toBeNull();
    expect(missingSection![1]).not.toContain("name");
  });

  it("returns undefined for action with no required-fields entry (list)", () => {
    const result = validateToolEntry({ action: "list" }, MCP_META);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combined error (malformed connect-with-server_name shape)
// ---------------------------------------------------------------------------

describe("validateToolEntry -- malformed connect payload", () => {
  it("emits a single multi-segment message for {action:connect, server_name:yfinance}", () => {
    const result = validateToolEntry(
      { action: "connect", server_name: "yfinance" },
      MCP_META,
    );
    // Pinned substrings -- the regression assertion for this whole feature.
    expect(result).toContain("unknown key 'server_name'");
    expect(result).toContain("did you mean 'name'?");
    expect(result).toContain("missing for action='connect':");
    expect(result).toContain("transport");
    expect(result).toContain("valid keys:");
    // The closing valid-keys list contains every registered key.
    for (const key of MCP_META.validKeys!) {
      expect(result).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// No-op cases
// ---------------------------------------------------------------------------

describe("validateToolEntry -- no-op cases", () => {
  it("returns undefined when meta has no entry-shape fields (exec/cron parity)", () => {
    expect(validateToolEntry({ anything: "goes" }, NO_SHAPE_META)).toBeUndefined();
    // Even null params pass through when the validator is configured to skip.
    expect(validateToolEntry(null, NO_SHAPE_META)).toBeUndefined();
  });

  it("returns undefined when meta is undefined (no metadata registered)", () => {
    expect(validateToolEntry({ anything: "goes" }, undefined)).toBeUndefined();
  });

  it("empty requiredByAction -- valid action passes silently", () => {
    const meta: ComisToolMetadata = {
      validActions: ["get", "update", "status", "trigger"],
      validKeys: ["action", "agent_id"],
      requiredByAction: {},
    };
    expect(validateToolEntry({ action: "get" }, meta)).toBeUndefined();
  });

  it("validActions registered, action present and valid -> undefined", () => {
    const result = validateToolEntry({ action: "list" }, ACTIONS_ONLY_META);
    expect(result).toBeUndefined();
  });
});
