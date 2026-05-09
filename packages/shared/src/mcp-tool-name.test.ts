// SPDX-License-Identifier: Apache-2.0
//
// Canonical sanitized MCP tool name parser tests.

import { describe, it, expect } from "vitest";
import { extractMcpServerName, parseSanitizedMcpToolName } from "./mcp-tool-name.js";

describe("extractMcpServerName", () => {
  it.each([
    ["mcp__foo--bar",                       "foo"],
    ["mcp__foo-bar--baz",                   "foo-bar"],          // hyphenated server name
    ["mcp__foo_bar--baz_qux",               "foo_bar"],          // underscored server name
    ["mcp__foo--bar--baz",                  "foo"],              // splits on FIRST "--"
    ["mcp__srv__v2--ns--tool",              "srv__v2"],          // colon-replaced server name
    ["mcp__context7--resolve-library-id",   "context7"],
    ["mcp__foo--",                          "foo"],              // empty tool: server still returned (asymmetry)
    // malformed
    ["Read",                                undefined],
    ["bash",                                undefined],
    ["",                                    undefined],
    ["mcp__",                               undefined],          // no separator
    ["mcp__foo",                            undefined],          // no separator
    ["mcp__--baz",                          undefined],          // empty server (sepIdx === 0)
    ["mcp:foo/bar",                         undefined],          // pre-sanitization form
  ] as const)("extractMcpServerName(%j) -> %j", (input, expected) => {
    expect(extractMcpServerName(input)).toBe(expected);
  });
});

describe("parseSanitizedMcpToolName", () => {
  it.each([
    ["mcp__foo--bar",                       { server: "foo",     tool: "bar" }],
    ["mcp__foo-bar--baz",                   { server: "foo-bar", tool: "baz" }],
    ["mcp__foo_bar--baz_qux",               { server: "foo_bar", tool: "baz_qux" }],
    ["mcp__foo--bar--baz",                  { server: "foo",     tool: "bar--baz" }],
    ["mcp__srv__v2--ns--tool",              { server: "srv__v2", tool: "ns--tool" }],
    ["mcp__context7--resolve-library-id",   { server: "context7", tool: "resolve-library-id" }],
    // malformed (asymmetry: empty tool rejected)
    ["mcp__foo--",                          undefined],          // empty tool (stricter than extract)
    ["Read",                                undefined],
    ["",                                    undefined],
    ["mcp__",                               undefined],
    ["mcp__foo",                            undefined],
    ["mcp__--baz",                          undefined],
    ["mcp:foo/bar",                         undefined],
  ] as const)("parseSanitizedMcpToolName(%j) -> %j", (input, expected) => {
    expect(parseSanitizedMcpToolName(input)).toEqual(expected);
  });
});

describe("extractMcpServerName / parseSanitizedMcpToolName asymmetry", () => {
  it("documents the empty-tool case where the two functions diverge", () => {
    // extractMcpServerName tolerates empty tool — group-by-server callers
    // (tool-deferral.ts:293,912,917) tolerate malformed names that still
    // identify a server. Do NOT "fix" this to also return undefined.
    expect(extractMcpServerName("mcp__foo--")).toBe("foo");
    // parseSanitizedMcpToolName rejects empty tool — pair-extracting callers
    // (install-detour parser) require BOTH halves to be non-empty.
    expect(parseSanitizedMcpToolName("mcp__foo--")).toBeUndefined();
  });
});
