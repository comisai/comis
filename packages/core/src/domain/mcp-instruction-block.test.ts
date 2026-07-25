// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  McpInstructionBlockSchema,
  parseMcpInstructionBlock,
  type McpInstructionBlock,
} from "./mcp-instruction-block.js";

function validBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverId: "example_operations",
    instructions: "Use the structured tools for the current request.",
    contentHash: "a".repeat(64),
    trust: "external",
    ...overrides,
  };
}

describe("McpInstructionBlock", () => {
  it("accepts attributed external instructions with a sha256 content hash", () => {
    const result = parseMcpInstructionBlock(validBlock());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const block: McpInstructionBlock = result.value;
      expect(block.serverId).toBe("example_operations");
      expect(block.trust).toBe("external");
    }
  });

  it("rejects unknown fields and non-external trust values", () => {
    expect(McpInstructionBlockSchema.safeParse(validBlock({ transportUrl: "https://example.com" })).success).toBe(false);
    expect(McpInstructionBlockSchema.safeParse(validBlock({ trust: "trusted" })).success).toBe(false);
  });

  it("rejects malformed hashes and oversized instruction text", () => {
    expect(McpInstructionBlockSchema.safeParse(validBlock({ contentHash: "not-a-hash" })).success).toBe(false);
    expect(McpInstructionBlockSchema.safeParse(validBlock({ instructions: "x".repeat(4097) })).success).toBe(false);
  });
});
