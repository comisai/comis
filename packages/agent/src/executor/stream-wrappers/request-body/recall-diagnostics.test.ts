// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { findInlineRecallIndices } from "./recall-diagnostics.js";

const RECALL =
  "[Relevant context from memory: user prefers metric units (recorded 2026-07-01)]\n";

describe("findInlineRecallIndices", () => {
  it("reports the index of a string-content user message carrying the recall block", () => {
    const messages = [
      { role: "user", content: "plain question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: `${RECALL}what is the forecast?` },
    ];

    expect(findInlineRecallIndices(messages)).toEqual([2]);
  });

  it("reads a keyed text block with no type discriminator", () => {
    const messages = [
      { role: "user", content: [{ text: `${RECALL}current request` }] },
      { role: "user", content: [{ text: "clean request" }] },
    ];

    expect(findInlineRecallIndices(messages)).toEqual([0]);
  });

  it("ignores recall-shaped text on assistant messages and returns empty when clean", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: `${RECALL}echoed` }] },
      { role: "user", content: "no recall here" },
    ];

    expect(findInlineRecallIndices(messages)).toEqual([]);
  });

  it("bounds the reported list to eight indices", () => {
    const messages = Array.from({ length: 12 }, () => ({
      role: "user",
      content: `${RECALL}query`,
    }));

    expect(findInlineRecallIndices(messages)).toHaveLength(8);
  });
});
