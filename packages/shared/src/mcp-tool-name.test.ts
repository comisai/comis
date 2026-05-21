// SPDX-License-Identifier: Apache-2.0
//
// Canonical sanitized MCP tool name parser tests.

import { describe, it, expect } from "vitest";
import { extractMcpServerName } from "./mcp-tool-name.js";

describe("extractMcpServerName", () => {
  it.each([
    ["mcp__foo--bar",                       "foo"],
    ["mcp__foo-bar--baz",                   "foo-bar"],          // hyphenated server name
    ["mcp__foo_bar--baz_qux",               "foo_bar"],          // underscored server name
    ["mcp__foo--bar--baz",                  "foo"],              // splits on FIRST "--"
    ["mcp__srv__v2--ns--tool",              "srv__v2"],          // colon-replaced server name
    ["mcp__context7--resolve-library-id",   "context7"],
    ["mcp__foo--",                          "foo"],              // empty tool: server still returned
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

