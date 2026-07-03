// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure answer-prompt builder + the deterministic
 * fake-LLM stub.
 *
 * TIER: default CI / fast unit tier (no model, no store). This file imports BOTH
 * `qa-answer-prompt.ts` AND `__fixtures__/qa-judge-stub.ts` so NEITHER is a
 * 0%-coverage file under the agent `all:true` coverage floor (a never-imported
 * src file fails CI's full `pnpm test --coverage`; `__fixtures__` is NOT in
 * vitest.config.ts's coverage `exclude`, so the stub is measured too).
 *
 * Coverage map:
 * - formatAnswerContext: empty -> sentinel (no throw); non-empty -> each
 *   entry.content + a dated anchor derived from occurredAt ?? createdAt,
 * - buildAnswerPrompt: the USER content carries Question / Retrieved Context /
 *   Answer slots with question + context substituted,
 * - the system/user SPLIT: ANSWER_SYSTEM_PROMPT is exported + non-empty,
 *   and its preamble text does NOT appear inside buildAnswerPrompt output,
 * - the stub drives the content-block walk deterministically (round-trip).
 */

import { describe, it, expect } from "vitest";
import type { MemorySearchResult } from "@comis/core";
import {
  ANSWER_SYSTEM_PROMPT,
  formatAnswerContext,
  buildAnswerPrompt,
} from "./qa-answer-prompt.js";
import { fakeComplete } from "./__fixtures__/qa-judge-stub.js";

/** Minimal MemorySearchResult builder — only the fields the formatter reads. */
function result(content: string, createdAt: number, occurredAt?: number): MemorySearchResult {
  return {
    entry: {
      id: "00000000-0000-0000-0000-000000000000",
      tenantId: "default",
      agentId: "bench",
      userId: "user_a",
      content,
      trustLevel: "learned",
      source: { who: "bench" },
      tags: [],
      createdAt,
      ...(occurredAt !== undefined ? { occurredAt } : {}),
    },
  } as MemorySearchResult;
}

/** The content-block walk from memory-review-job.ts:225-241 (duplicated for the round-trip). */
function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

describe("formatAnswerContext (recalled MemorySearchResult[] -> Retrieved-Context block)", () => {
  it("returns an explicit sentinel for the empty-recall case (no throw)", () => {
    const out = formatAnswerContext([]);
    expect(typeof out).toBe("string");
    expect(out).toContain("(no retrieved context)");
  });

  it("includes each entry.content and a dated anchor (occurredAt ?? createdAt)", () => {
    const createdA = Date.UTC(2023, 4, 19, 9, 0);
    const occurredA = Date.UTC(2022, 0, 1, 0, 0); // occurredAt wins when present
    const createdB = Date.UTC(2023, 4, 20, 2, 21);
    const out = formatAnswerContext([
      result("alpha fact", createdA, occurredA),
      result("beta fact", createdB), // no occurredAt -> falls back to createdAt
    ]);
    expect(out).toContain("alpha fact");
    expect(out).toContain("beta fact");
    // occurredAt anchor for A (2022), createdAt anchor for B (2023-05-20)
    expect(out).toContain(new Date(occurredA).toISOString());
    expect(out).toContain(new Date(createdB).toISOString());
  });
});

describe("buildAnswerPrompt (USER content — question + formatted context)", () => {
  it("carries the Question / Retrieved Context / Answer slots with values substituted", () => {
    const ctx = formatAnswerContext([result("alpha fact", Date.UTC(2023, 4, 20, 2, 21))]);
    const p = buildAnswerPrompt("What is the topic?", ctx, "2023/05/21");
    expect(p).toContain("Question: What is the topic?");
    expect(p).toContain("Retrieved Context:");
    expect(p).toContain("alpha fact");
    expect(p).toContain("Answer:");
    expect(p).toContain("Question Date: 2023/05/21");
  });

  it("renders an explicit date sentinel when questionDate is omitted", () => {
    const p = buildAnswerPrompt("q", "ctx");
    expect(p).toContain("Question Date: unknown");
  });
});

describe("ANSWER_SYSTEM_PROMPT (the system/user split)", () => {
  it("is exported and non-empty", () => {
    expect(typeof ANSWER_SYSTEM_PROMPT).toBe("string");
    expect(ANSWER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("does NOT appear inside buildAnswerPrompt output (preamble lives only in the system slot)", () => {
    const p = buildAnswerPrompt("q", "ctx", "2023/05/21");
    // The whole preamble string must not be duplicated into the user turn —
    // so the gated harness's completeSimple({ systemPrompt: ANSWER_SYSTEM_PROMPT,
    // messages:[{role:'user', content: buildAnswerPrompt(...)}] }) is consistent.
    expect(p).not.toContain(ANSWER_SYSTEM_PROMPT);
  });
});

describe("fakeComplete (deterministic fake-LLM stub — drives the pure pipeline)", () => {
  it("returns a {type:'text'} content block whose text round-trips through the walk", async () => {
    const resp = await fakeComplete("hello")();
    expect(extractResponseText(resp)).toBe("hello");
  });

  it("is deterministic across calls and faithful to the judge-verdict shape", async () => {
    const verdictJson = '{ "correct": true, "reasoning": "matches" }';
    const resp = await fakeComplete(verdictJson)();
    expect(extractResponseText(resp)).toBe(verdictJson);
    // same reply text on a second invocation (no hidden state)
    expect(extractResponseText(await fakeComplete(verdictJson)())).toBe(verdictJson);
  });
});
