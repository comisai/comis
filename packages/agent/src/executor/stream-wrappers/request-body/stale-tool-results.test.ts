// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for stale tool-result microcompaction across both provider arrangements.
 *
 * A tool result arrives either as a top-level `role: "tool"` message (Anthropic Messages) or as
 * `{toolResult}` blocks packed into a `user` message (Bedrock Converse). The pre-extraction
 * implementation understood only the first and identified calls by `block.type === "tool_use"`, so on
 * Bedrock the tool-name map came out empty, no message matched `role === "tool"`, and the edit/write
 * input pass found nothing — compaction did not run at all and context grew without bound.
 */
import { describe, it, expect } from "vitest";

import { clearStaleToolResults } from "./tool-result-clearing.js";

const bedrockUser = (text: string) => ({ role: "user", content: [{ text }] });

describe("clearStaleToolResults under the Bedrock Converse shape", () => {
  const big = "R".repeat(4000);
  /** Bedrock packs results as `{toolResult}` blocks inside a USER message, not a `tool` message. */
  const bedrockResult = (id: string, text: string) => ({
    role: "user",
    content: [{ toolResult: { toolUseId: id, content: [{ text }], status: "success" } }],
  });
  const call = (id: string, name: string) => ({
    role: "assistant",
    content: [{ toolUse: { toolUseId: id, name, input: {} } }],
  });

  it("compacts a read-only Bedrock tool result while preserving its protocol fields", () => {
    const messages = [
      bedrockUser("q"), call("t1", "read"), bedrockResult("t1", big),
      call("t2", "read"), bedrockResult("t2", big),
    ];

    // Pre-extraction this was a triple no-op on Bedrock: the name map was empty, no message had
    // role "tool", and the input pass matched nothing — so nothing was ever compacted.
    expect(clearStaleToolResults(messages, 1, -1)).toBe(1);
    const result = (messages[2]!.content as Array<Record<string, unknown>>)[0]!
      .toolResult as Record<string, unknown>;
    expect(result.content).toEqual([{ text: "[Stale tool result cleared: idle > TTL]" }]);
    // Dropping toolUseId/status would unpair the result from its call and the provider rejects it.
    expect(result.toolUseId).toBe("t1");
    expect(result.status).toBe("success");
    // Within the keep window — untouched.
    expect((messages[4]!.content as Array<Record<string, unknown>>)[0]).toHaveProperty("toolResult");
  });

  it("preserves an edit/write Bedrock result, which carries confirmation of the change", () => {
    const messages = [
      bedrockUser("q"), call("t1", "file_write"), bedrockResult("t1", big),
      call("t2", "read"), bedrockResult("t2", big),
    ];
    expect(clearStaleToolResults(messages, 1, -1)).toBe(0);
  });

  it("never compacts a Bedrock result at or below the cache fence", () => {
    const messages = [
      bedrockUser("q"), call("t1", "read"), bedrockResult("t1", big),
      call("t2", "read"), bedrockResult("t2", big),
    ];
    expect(clearStaleToolResults(messages, 1, 2)).toBe(0);
  });

  it("clears a settled Bedrock edit/write call's arguments", () => {
    const messages = [
      bedrockUser("q"),
      { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "file_write", input: { text: big } } }] },
      bedrockResult("t1", "ok"),
      call("t2", "read"),
      bedrockResult("t2", "ok"),
    ];

    expect(clearStaleToolResults(messages, 1, -1)).toBe(1);
    const toolUse = (messages[1]!.content as Array<Record<string, unknown>>)[0]!
      .toolUse as Record<string, unknown>;
    expect(toolUse.input).toEqual({ _cleared: true, reason: "stale edit/write input" });
    expect(toolUse.toolUseId).toBe("t1");
  });
});
