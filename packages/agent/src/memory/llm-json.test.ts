// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the shared lenient JSON recovery (live finding 2026-06-11):
 * claude-sonnet-4-6 at temperature 0 narrates before the JSON payload
 * despite "no commentary" prompts, and the whole-string JSON.parse degraded
 * VALID payloads across the memory pipeline (dialectic abstains, extraction
 * "invalid output, skipping").
 */

import { describe, it, expect } from "vitest";
import { parseLenientJson, extractFirstParseableJsonBlock } from "./llm-json.js";
import { parseExtractionResult } from "./memory-extraction.js";

describe("a narration-prefixed LLM payload still parses", () => {
  it("recovers an object payload after commentary (the live dialectic shape)", () => {
    const raw = [
      "The memories conflict on this date. I defer to the update.",
      "",
      '{ "answer": "June 25, 2026", "citedIds": ["id-1"] }',
    ].join("\n");
    expect(parseLenientJson(raw)).toEqual({ answer: "June 25, 2026", citedIds: ["id-1"] });
  });

  it("recovers an array payload after commentary (relationship/user-rep shape)", () => {
    const raw = 'Here are the candidates I found:\n[{"entryType":"preference","content":"green tea"}]';
    expect(parseLenientJson(raw)).toEqual([{ entryType: "preference", content: "green tea" }]);
  });

  it("skips non-JSON brace groups in the narration", () => {
    const raw = 'Format note {weird} here. {"memories": []}';
    expect(parseLenientJson(raw)).toEqual({ memories: [] });
  });

  it("fenced payloads keep working (fast path)", () => {
    expect(parseLenientJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("pure narration with no payload returns undefined (callers keep their degrade)", () => {
    expect(parseLenientJson("I could not produce a structured result.")).toBeUndefined();
    expect(extractFirstParseableJsonBlock("nothing here")).toBeUndefined();
  });
});

describe("the review extraction survives the live narration shape", () => {
  it("parses memories from a commentary-prefixed envelope (the 'invalid output, skipping' class)", () => {
    const raw = [
      "I reviewed the session and extracted these durable facts:",
      "",
      '{ "memories": [ { "content": "Maya moved to Lisbon", "entities": [{"name":"Maya"},{"name":"Lisbon"},{"name":"user"}] } ] }',
    ].join("\n");

    const parsed = parseExtractionResult(raw);

    expect(parsed).toBeDefined();
    expect(parsed!.memories).toHaveLength(1);
    expect(parsed!.memories[0]!.content).toBe("Maya moved to Lisbon");
    expect(parsed!.memories[0]!.entities.map((e) => e.name)).toContain("Lisbon");
  });
});
