// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the thinking-block hash invariant module.
 *
 * Two functions under test:
 * - computeThinkingBlockHashes: pure SHA-256 over the four-field tuple of
 *   each `type:"thinking"` block (skipping redacted blocks and non-thinking
 *   block types).
 * - assertThinkingBlocksUnchanged: compares prior hashes against current
 *   block contents and emits exactly one structured ERROR log per mismatched
 *   index. Never throws.
 *
 * The module is diagnostic instrumentation only -- it must NEVER throw and
 * must NEVER mutate inputs. The "no throws" property is asserted both via
 * runtime test cases and via a source-shape grep at the bottom of this file.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertThinkingBlocksUnchanged,
  computeThinkingBlockHashes,
  diffThinkingBlocksAgainstPersisted,
  restoreCanonicalThinkingBlocks,
  type ThinkingBlockHash,
} from "./thinking-block-hash-invariant.js";

// ---------------------------------------------------------------------------
// Fixtures (neutral placeholders per AGENTS.md §2.2)
// ---------------------------------------------------------------------------

const SIG_A = "test-signature-aaa";
const SIG_B = "test-signature-bbb";
const TEXT_A = "test-thinking-text-alpha";
const TEXT_B = "test-thinking-text-beta";

const blockA = (overrides: Record<string, unknown> = {}) => ({
  type: "thinking",
  thinking: TEXT_A,
  thinkingSignature: SIG_A,
  ...overrides,
});
const blockB = (overrides: Record<string, unknown> = {}) => ({
  type: "thinking",
  thinking: TEXT_B,
  thinkingSignature: SIG_B,
  ...overrides,
});

// ---------------------------------------------------------------------------
// computeThinkingBlockHashes
// ---------------------------------------------------------------------------

describe("computeThinkingBlockHashes", () => {
  it("returns one entry per type:'thinking' block in source order", () => {
    const hashes = computeThinkingBlockHashes([blockA(), blockB()]);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]?.blockIndex).toBe(0);
    expect(hashes[1]?.blockIndex).toBe(1);
    expect(hashes[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips non-thinking blocks (text, tool_use, tool_result)", () => {
    const blocks = [
      { type: "text", text: "preface" },
      blockA(),
      { type: "tool_use", id: "toolu_1", name: "exec", input: {} },
      blockB(),
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
    ];
    const hashes = computeThinkingBlockHashes(blocks);
    expect(hashes).toHaveLength(2);
    // blockIndex tracks position WITHIN the thinking-only stream, not the
    // original mixed-block array, so callers can compare positionally.
    expect(hashes[0]?.blockIndex).toBe(0);
    expect(hashes[1]?.blockIndex).toBe(1);
  });

  it("skips redacted blocks (no readable text to hash)", () => {
    const hashes = computeThinkingBlockHashes([
      blockA(),
      { type: "thinking", redacted: true, thinkingSignature: "redacted-sig" },
      blockB(),
    ]);
    expect(hashes).toHaveLength(2);
  });

  it("is deterministic across calls (same input -> same hashes)", () => {
    const blocks = [blockA(), blockB()];
    const first = computeThinkingBlockHashes(blocks);
    const second = computeThinkingBlockHashes(blocks);
    expect(second.map((h) => h.hash)).toEqual(first.map((h) => h.hash));
  });

  it("hashes (type | thinking | thinkingSignature | redacted) -- mutating any of the four fields changes the hash", () => {
    const base = computeThinkingBlockHashes([blockA()])[0]!.hash;
    const textChanged = computeThinkingBlockHashes([blockA({ thinking: TEXT_A + "X" })])[0]!.hash;
    const sigChanged = computeThinkingBlockHashes([blockA({ thinkingSignature: SIG_A + "X" })])[0]!.hash;
    const redactedChanged = computeThinkingBlockHashes([blockA({ redacted: true })])[0];
    // redacted:true block is skipped entirely, so the result is empty.
    expect(redactedChanged).toBeUndefined();

    expect(textChanged).not.toBe(base);
    expect(sigChanged).not.toBe(base);
  });

  it("captures textFirstChars (first 32 chars) and sigLen for diagnostic on mismatch", () => {
    const longText = "a".repeat(100);
    const hashes = computeThinkingBlockHashes([
      { type: "thinking", thinking: longText, thinkingSignature: SIG_A },
    ]);
    expect(hashes[0]?.textFirstChars).toBe("a".repeat(32));
    expect(hashes[0]?.sigLen).toBe(SIG_A.length);
  });

  it("handles missing thinking/signature fields without throwing", () => {
    const hashes = computeThinkingBlockHashes([
      { type: "thinking" }, // no thinking text, no signature
      { type: "thinking", thinking: "" },
      { type: "thinking", thinkingSignature: "" },
    ]);
    expect(hashes).toHaveLength(3);
    expect(hashes[0]?.textFirstChars).toBe("");
    expect(hashes[0]?.sigLen).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// assertThinkingBlocksUnchanged
// ---------------------------------------------------------------------------

describe("assertThinkingBlocksUnchanged", () => {
  it("produces ZERO log calls when prior and current match", () => {
    const blocks = [blockA(), blockB()];
    const prior = computeThinkingBlockHashes(blocks);
    const error = vi.fn();
    assertThinkingBlocksUnchanged(prior, blocks, "resp_test_1", { logger: { error } });
    expect(error).not.toHaveBeenCalled();
  });

  it("produces exactly ONE error log when one block's text was mutated", () => {
    const original = [blockA(), blockB()];
    const prior = computeThinkingBlockHashes(original);
    const mutated = [blockA(), blockB({ thinking: TEXT_B + "_MUTATED" })];
    const error = vi.fn();
    assertThinkingBlocksUnchanged(prior, mutated, "resp_test_2", { logger: { error } });
    expect(error).toHaveBeenCalledTimes(1);
    const [payload, msg] = error.mock.calls[0]!;
    expect(msg).toBe("Thinking block mutated between turns");
    expect(payload).toMatchObject({
      responseId: "resp_test_2",
      blockIndex: 1,
      oldHash: prior[1]!.hash,
      oldSigLen: SIG_B.length,
      newSigLen: SIG_B.length,
      errorKind: "internal",
      module: "agent.bridge.hash-invariant",
    });
    expect(typeof payload.newHash).toBe("string");
    expect(payload.newHash).not.toBe(prior[1]!.hash);
    expect(typeof payload.hint).toBe("string");
    expect((payload.hint as string).length).toBeGreaterThan(0);
    // text prefixes -- both populated, both up to 32 chars
    expect(payload.oldText).toMatchObject({ firstChars: TEXT_B.slice(0, 32) });
    expect(payload.newText).toMatchObject({
      firstChars: (TEXT_B + "_MUTATED").slice(0, 32),
    });
  });

  it("detects signature changes (different sigLen)", () => {
    const original = [blockA()];
    const prior = computeThinkingBlockHashes(original);
    const mutated = [blockA({ thinkingSignature: SIG_A + "_extra" })];
    const error = vi.fn();
    assertThinkingBlocksUnchanged(prior, mutated, "resp_test_3", { logger: { error } });
    expect(error).toHaveBeenCalledTimes(1);
    const [payload] = error.mock.calls[0]!;
    expect(payload.oldSigLen).toBe(SIG_A.length);
    expect(payload.newSigLen).toBe((SIG_A + "_extra").length);
  });

  it("produces ZERO log calls when prior list is empty (no hashes captured)", () => {
    const error = vi.fn();
    assertThinkingBlocksUnchanged([], [blockA()], "resp_test_4", { logger: { error } });
    expect(error).not.toHaveBeenCalled();
  });

  it("logs ONE error per missing index when current has fewer thinking blocks", () => {
    const original = [blockA(), blockB()];
    const prior = computeThinkingBlockHashes(original);
    const error = vi.fn();
    // Only one thinking block remains in current.
    assertThinkingBlocksUnchanged(prior, [blockA()], "resp_test_5", { logger: { error } });
    expect(error).toHaveBeenCalledTimes(1);
    const [payload] = error.mock.calls[0]!;
    expect(payload.blockIndex).toBe(1);
    expect(payload.newHash).toBeNull();
    expect(payload.newText).toMatchObject({ firstChars: "" });
    expect(payload.newSigLen).toBe(0);
  });

  it("never throws -- mismatch path still returns normally", () => {
    const original = [blockA()];
    const prior = computeThinkingBlockHashes(original);
    const mutated = [blockA({ thinking: "totally-different-text" })];
    // Logger that itself throws -- the asserter must catch and not propagate.
    const error = vi.fn().mockImplementation(() => {
      throw new Error("logger-internal-error");
    });
    expect(() =>
      assertThinkingBlocksUnchanged(prior, mutated, "resp_test_6", { logger: { error } }),
    ).not.toThrow();
  });

  it("never throws when current has malformed/non-array shape", () => {
    const error = vi.fn();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising defensive path
      assertThinkingBlocksUnchanged([], null as any, "resp_test_7", { logger: { error } }),
    ).not.toThrow();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising defensive path
      assertThinkingBlocksUnchanged([], undefined as any, "resp_test_8", { logger: { error } }),
    ).not.toThrow();
  });

  it("synthetic c7b91328-shape repro: 4 signed blocks with index 2 mutated logs blockIndex:2 with intact sigLen", () => {
    const blocks = [
      { type: "thinking", thinking: "block-0", thinkingSignature: "sig-0" },
      { type: "thinking", thinking: "block-1", thinkingSignature: "sig-1" },
      { type: "thinking", thinking: "block-2", thinkingSignature: "sig-2" },
      { type: "thinking", thinking: "block-3", thinkingSignature: "sig-3" },
    ];
    const prior = computeThinkingBlockHashes(blocks);
    const mutated: Record<string, unknown>[] = blocks.map((b) => ({ ...b }));
    // Mutate only block 2's text, preserve its signature exactly.
    mutated[2] = { ...mutated[2], thinking: "block-2-MUTATED" };
    const error = vi.fn();
    assertThinkingBlocksUnchanged(prior, mutated, "c7b91328", { logger: { error } });
    expect(error).toHaveBeenCalledTimes(1);
    const [payload] = error.mock.calls[0]!;
    expect(payload.blockIndex).toBe(2);
    expect(payload.responseId).toBe("c7b91328");
    expect(payload.oldSigLen).toBe(payload.newSigLen); // signature unchanged
    expect(payload.oldHash).toBe(prior[2]!.hash);
    expect(payload.newHash).not.toBe(prior[2]!.hash);
  });

  it("does not mutate inputs (prior + current arrays untouched after call)", () => {
    const blocks = [blockA(), blockB()];
    const prior = computeThinkingBlockHashes(blocks);
    const priorClone: ThinkingBlockHash[] = prior.map((h) => ({ ...h }));
    const blocksClone = blocks.map((b) => ({ ...b }));
    const error = vi.fn();
    assertThinkingBlocksUnchanged(prior, blocks, "resp_test_9", { logger: { error } });
    expect(prior).toEqual(priorClone);
    expect(blocks).toEqual(blocksClone);
  });
});

// ---------------------------------------------------------------------------
// restoreCanonicalThinkingBlocks
// ---------------------------------------------------------------------------

describe("restoreCanonicalThinkingBlocks", () => {
  // Helper: build an assistant message with content blocks + responseId.
  const asstMsg = (responseId: string, content: ReadonlyArray<unknown>) => ({
    role: "assistant" as const,
    responseId,
    content,
  });

  it("returns input ref + zero count when canonical store is empty", () => {
    const messages = [asstMsg("resp_1", [blockA(), blockB()])];
    const store = new Map<string, ReadonlyArray<unknown>>();
    const info = vi.fn();
    const warn = vi.fn();
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn } });
    expect(result.messages).toBe(messages);
    expect(result.restoredCount).toBe(0);
    expect(result.affectedResponseIds).toEqual([]);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns input ref + zero count when canonical matches in-memory exactly (idempotent)", () => {
    const blocks = [blockA(), blockB()];
    const messages = [asstMsg("resp_1", blocks)];
    const store = new Map<string, ReadonlyArray<unknown>>([
      ["resp_1", [blockA(), blockB()]],
    ]);
    const info = vi.fn();
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn: vi.fn() } });
    expect(result.messages).toBe(messages);
    expect(result.restoredCount).toBe(0);
    expect(result.affectedResponseIds).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it("running the restore twice = running once (idempotence)", () => {
    const mutated = [blockA({ thinking: "MUTATED" }), blockB()];
    const messages = [asstMsg("resp_1", mutated)];
    const canonical = [blockA(), blockB()];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const info = vi.fn();
    const first = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn: vi.fn() } });
    expect(first.restoredCount).toBe(1);
    // Second pass against now-healed messages: no further swaps.
    const info2 = vi.fn();
    const second = restoreCanonicalThinkingBlocks(first.messages, store, { logger: { info: info2, warn: vi.fn() } });
    expect(second.restoredCount).toBe(0);
    expect(second.messages).toBe(first.messages);
    expect(info2).not.toHaveBeenCalled();
  });

  it("replaces a mutated thinking block with its canonical counterpart and emits ONE INFO log", () => {
    const mutated = [blockA({ thinking: "MUTATED-text" })];
    const messages = [asstMsg("resp_1", mutated)];
    const canonical = [blockA()];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const info = vi.fn();
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn: vi.fn() } });
    expect(result.restoredCount).toBe(1);
    expect(result.affectedResponseIds).toEqual(["resp_1"]);
    expect(result.messages).not.toBe(messages);
    const healedContent = (result.messages[0] as { content: ReadonlyArray<Record<string, unknown>> }).content;
    expect(healedContent[0]?.thinking).toBe(TEXT_A);
    expect(healedContent[0]?.thinkingSignature).toBe(SIG_A);
    expect(info).toHaveBeenCalledTimes(1);
    const [payload, msg] = info.mock.calls[0]!;
    expect(payload).toMatchObject({
      module: "agent.bridge.canonical-restore",
      restoredCount: 1,
      affectedResponseIds: ["resp_1"],
    });
    expect(typeof msg).toBe("string");
    expect((msg as string).length).toBeGreaterThan(0);
  });

  it("returns NEW top-level array AND NEW content array on swap; does not mutate input arrays", () => {
    const inputBlocks = [blockA({ thinking: "MUTATED" }), blockB()];
    const inputBlocksRef = inputBlocks; // capture
    const messages = [asstMsg("resp_1", inputBlocks)];
    const messagesRef = messages; // capture
    const canonical = [blockA(), blockB()];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    // New top-level + new content reference
    expect(result.messages).not.toBe(messagesRef);
    const healedMsg = result.messages[0] as { content: ReadonlyArray<unknown> };
    expect(healedMsg.content).not.toBe(inputBlocksRef);
    // Original arrays untouched (Object.is references preserved, contents intact).
    expect(messagesRef[0]?.content).toBe(inputBlocksRef);
    expect(inputBlocksRef[0]).toEqual(blockA({ thinking: "MUTATED" }));
    expect(inputBlocksRef[1]).toEqual(blockB());
  });

  it("ignores text blocks, tool_use, tool_result, and redacted_thinking blocks", () => {
    const liveBlocks = [
      { type: "text", text: "preface" },
      blockA({ thinking: "MUTATED-A" }),
      { type: "tool_use", id: "toolu_1", name: "exec", input: { cmd: "ls" } },
      { type: "thinking", redacted: true, thinkingSignature: "redacted-sig" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
    ];
    const canonical = [
      { type: "text", text: "preface" },
      blockA(),
      { type: "tool_use", id: "toolu_1", name: "exec", input: { cmd: "ls" } },
      { type: "thinking", redacted: true, thinkingSignature: "redacted-sig" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
    ];
    const messages = [asstMsg("resp_1", liveBlocks)];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    expect(result.restoredCount).toBe(1); // only the thinking block was healed
    const healed = (result.messages[0] as { content: ReadonlyArray<Record<string, unknown>> }).content;
    // text/tool blocks unchanged (object identity preserved when no swap on that index)
    expect(healed[0]).toBe(liveBlocks[0]);
    expect(healed[2]).toBe(liveBlocks[2]);
    expect(healed[3]).toBe(liveBlocks[3]); // redacted_thinking left alone
    expect(healed[4]).toBe(liveBlocks[4]);
    // thinking block swapped
    expect(healed[1]?.thinking).toBe(TEXT_A);
  });

  it("does NOT swap when positional types disagree (live=thinking, canonical=text)", () => {
    const liveBlocks = [blockA({ thinking: "MUTATED" })];
    const canonical = [{ type: "text", text: "different shape" }];
    const messages = [asstMsg("resp_1", liveBlocks)];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    expect(result.restoredCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("leaves messages with no responseId untouched", () => {
    const liveBlocks = [blockA({ thinking: "MUTATED" })];
    const messages = [{ role: "assistant", content: liveBlocks }]; // no responseId
    const canonical = [blockA()];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    expect(result.restoredCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("leaves messages whose responseId is not in the store untouched", () => {
    const liveBlocks = [blockA({ thinking: "MUTATED" })];
    const messages = [asstMsg("resp_unknown", liveBlocks)];
    const canonical = [blockA()];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    expect(result.restoredCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("ignores user / system / tool messages — only walks role==='assistant'", () => {
    const userMsg = { role: "user", responseId: "resp_1", content: [blockA({ thinking: "MUTATED" })] };
    const systemMsg = { role: "system", responseId: "resp_1", content: [blockA({ thinking: "MUTATED" })] };
    const toolMsg = { role: "tool", responseId: "resp_1", content: [blockA({ thinking: "MUTATED" })] };
    const messages = [userMsg, systemMsg, toolMsg];
    const canonical = [blockA()];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    expect(result.restoredCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("returns accurate restoredCount and affectedResponseIds across multiple messages", () => {
    const m1 = asstMsg("resp_1", [blockA({ thinking: "MUTATED-A" }), blockB({ thinking: "MUTATED-B" })]);
    const m2 = asstMsg("resp_2", [blockA()]); // unchanged
    const m3 = asstMsg("resp_3", [blockA({ thinking: "MUTATED-A" })]);
    const messages = [m1, m2, m3];
    const store = new Map<string, ReadonlyArray<unknown>>([
      ["resp_1", [blockA(), blockB()]],
      ["resp_2", [blockA()]],
      ["resp_3", [blockA()]],
    ]);
    const info = vi.fn();
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn: vi.fn() } });
    expect(result.restoredCount).toBe(3); // 2 in m1 + 0 in m2 + 1 in m3
    expect(result.affectedResponseIds).toEqual(["resp_1", "resp_3"]);
    expect(info).toHaveBeenCalledTimes(1);
    const [payload] = info.mock.calls[0]!;
    expect(payload).toMatchObject({
      module: "agent.bridge.canonical-restore",
      restoredCount: 3,
      affectedResponseIds: ["resp_1", "resp_3"],
    });
  });

  it("emits NO log when restoredCount === 0", () => {
    const messages = [asstMsg("resp_1", [blockA(), blockB()])];
    const store = new Map<string, ReadonlyArray<unknown>>([
      ["resp_1", [blockA(), blockB()]],
    ]);
    const info = vi.fn();
    const warn = vi.fn();
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn } });
    expect(result.restoredCount).toBe(0);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("never throws on malformed canonical entry (non-array store value); emits ONE WARN with errorKind:'internal'", () => {
    const messages = [asstMsg("resp_1", [blockA({ thinking: "MUTATED" })])];
    const store = new Map<string, ReadonlyArray<unknown>>([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising defensive path
      ["resp_1", "not-an-array" as any],
    ]);
    const warn = vi.fn();
    const info = vi.fn();
    expect(() =>
      restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn } }),
    ).not.toThrow();
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn } });
    expect(result.restoredCount).toBe(0);
    expect(result.affectedResponseIds).toEqual([]);
    expect(result.messages).toBe(messages);
    // No INFO (zero swaps); no WARN either because non-array canonical is treated
    // as "no canonical for this responseId" -- not a malformed-input error.
    expect(info).not.toHaveBeenCalled();
  });

  it("never throws when the messages walk hits a malformed block; returns input ref + WARN", () => {
    // Construct an input that causes the internal walk to encounter unexpected
    // shapes. The helper's outer try/catch must swallow any error.
    const liveBlocks: ReadonlyArray<unknown> = [blockA({ thinking: "MUTATED" })];
    const messages = [asstMsg("resp_1", liveBlocks)];
    // canonical[0] is non-object — when the walker tries to read .type it
    // returns undefined; that's a soft no-swap, not a throw. To force the
    // try/catch path we need a value whose `.type` getter throws.
    const trapBlock = new Proxy({}, {
      get() {
        throw new Error("synthetic-trap");
      },
    });
    const canonical: ReadonlyArray<unknown> = [trapBlock];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", canonical]]);
    const warn = vi.fn();
    const info = vi.fn();
    let result;
    expect(() => {
      result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn } });
    }).not.toThrow();
    expect(result!.restoredCount).toBe(0);
    expect(result!.affectedResponseIds).toEqual([]);
    expect(result!.messages).toBe(messages);
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload] = warn.mock.calls[0]!;
    expect(payload).toMatchObject({
      module: "agent.bridge.canonical-restore",
      errorKind: "internal",
    });
    expect(typeof payload.hint).toBe("string");
    expect((payload.hint as string).length).toBeGreaterThan(0);
  });

  it("returns empty array when messages input is not an array (no log)", () => {
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", [blockA()]]]);
    const info = vi.fn();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising defensive path
    const r1 = restoreCanonicalThinkingBlocks(null as any, store, { logger: { info, warn } });
    expect(r1.messages).toEqual([]);
    expect(r1.restoredCount).toBe(0);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising defensive path
    const r2 = restoreCanonicalThinkingBlocks(undefined as any, store, { logger: { info, warn } });
    expect(r2.messages).toEqual([]);
    expect(r2.restoredCount).toBe(0);
  });

  it("works when deps argument omits logger entirely (silent path, no throw)", () => {
    const messages = [asstMsg("resp_1", [blockA({ thinking: "MUTATED" })])];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", [blockA()]]]);
    expect(() => restoreCanonicalThinkingBlocks(messages, store)).not.toThrow();
    expect(() => restoreCanonicalThinkingBlocks(messages, store, {})).not.toThrow();
    const result = restoreCanonicalThinkingBlocks(messages, store);
    expect(result.restoredCount).toBe(1);
  });

  it("integration: assertion-then-restore order produces ERROR followed by healed messages", () => {
    // Set up: capture hashes of canonical, then mutate the live copy.
    const canonicalBlocks = [blockA(), blockB()];
    const priorHashes = computeThinkingBlockHashes(canonicalBlocks);
    // Live (mutated) copy
    const mutatedBlocks = [blockA({ thinking: TEXT_A + "_MUTATED" }), blockB()];
    const messages = [asstMsg("resp_test_int", mutatedBlocks)];

    // Step 1: assertion fires ERROR log identifying the mutation.
    const error = vi.fn();
    assertThinkingBlocksUnchanged(priorHashes, mutatedBlocks, "resp_test_int", { logger: { error } });
    expect(error).toHaveBeenCalledTimes(1);
    const [errPayload] = error.mock.calls[0]!;
    expect(errPayload).toMatchObject({
      module: "agent.bridge.hash-invariant",
      blockIndex: 0,
      responseId: "resp_test_int",
    });

    // Step 2: restoration heals the in-memory shape using the canonical store.
    const store = new Map<string, ReadonlyArray<unknown>>([
      ["resp_test_int", canonicalBlocks],
    ]);
    const info = vi.fn();
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info, warn: vi.fn() } });
    expect(result.restoredCount).toBe(1);
    const healed = (result.messages[0] as { content: ReadonlyArray<Record<string, unknown>> }).content;
    expect(healed[0]?.thinking).toBe(TEXT_A); // restored canonical text
    expect(healed[0]?.thinkingSignature).toBe(SIG_A); // signature intact
    // Expected log shape distinct from assertion: module differs.
    expect(info).toHaveBeenCalledTimes(1);
    const [infoPayload] = info.mock.calls[0]!;
    expect(infoPayload).toMatchObject({
      module: "agent.bridge.canonical-restore",
      restoredCount: 1,
      affectedResponseIds: ["resp_test_int"],
    });
  });

  it("dedupes affectedResponseIds in walk order (multiple swaps for same responseId count once)", () => {
    const messages = [
      asstMsg("resp_1", [blockA({ thinking: "MUTATED-A" }), blockB({ thinking: "MUTATED-B" })]),
    ];
    const store = new Map<string, ReadonlyArray<unknown>>([
      ["resp_1", [blockA(), blockB()]],
    ]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    expect(result.restoredCount).toBe(2);
    expect(result.affectedResponseIds).toEqual(["resp_1"]); // one entry, not two
  });

  it("preserves assistant messages without responseId AFTER a heal happens (copy-on-write boundary)", () => {
    const headlessMsg = { role: "assistant", content: [{ type: "text", text: "no responseId" }] };
    const healable = asstMsg("resp_1", [blockA({ thinking: "MUTATED" })]);
    const messages = [headlessMsg, healable];
    const store = new Map<string, ReadonlyArray<unknown>>([["resp_1", [blockA()]]]);
    const result = restoreCanonicalThinkingBlocks(messages, store, { logger: { info: vi.fn(), warn: vi.fn() } });
    expect(result.restoredCount).toBe(1);
    // headlessMsg passes through with its original reference
    expect(result.messages[0]).toBe(headlessMsg);
    // healable was replaced with a new message reference
    expect(result.messages[1]).not.toBe(healable);
  });
});

// ---------------------------------------------------------------------------
// diffThinkingBlocksAgainstPersisted (260428-iag wire-edge diagnostic)
// ---------------------------------------------------------------------------

describe("diffThinkingBlocksAgainstPersisted", () => {
  // Helper: build a JSONL string from an array of entries. Each entry is wrapped
  // as { type: "message", message: { role: "assistant", responseId, content } }.
  const buildJsonl = (
    messages: ReadonlyArray<{ responseId: string; content: ReadonlyArray<unknown> }>,
    extras: ReadonlyArray<string> = [],
  ): string => {
    const lines = messages.map((m) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", responseId: m.responseId, content: m.content },
      }),
    );
    return [...extras, ...lines].join("\n");
  };

  // Helper: stub readFile that returns the given JSONL contents on any path.
  const stubReadFile = (jsonl: string) => vi.fn().mockResolvedValue(jsonl);

  it("returns [] and emits no logs when persisted matches in-memory exactly", async () => {
    const blocks = [blockA(), blockB()];
    const jsonl = buildJsonl([{ responseId: "resp_1", content: blocks }]);
    const warn = vi.fn();
    const readFile = stubReadFile(jsonl);
    const result = await diffThinkingBlocksAgainstPersisted(
      blocks,
      "resp_1",
      "/test/session.jsonl",
      { logger: { warn }, readFile },
    );
    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns ONE entry with populated firstChars on both sides when text differs at index 0", async () => {
    const persisted = [blockA(), blockB()];
    const inMemory = [blockA({ thinking: TEXT_A + "_MUTATED" }), blockB()];
    const jsonl = buildJsonl([{ responseId: "resp_1", content: persisted }]);
    const warn = vi.fn();
    const result = await diffThinkingBlocksAgainstPersisted(
      inMemory,
      "resp_1",
      "/test/session.jsonl",
      { logger: { warn }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.blockIndex).toBe(0);
    expect(entry.persistedText.firstChars).toBe(TEXT_A.slice(0, 32));
    expect(entry.inMemoryText.firstChars).toBe((TEXT_A + "_MUTATED").slice(0, 32));
    expect(entry.persistedSigLen).toBe(SIG_A.length);
    expect(entry.inMemorySigLen).toBe(SIG_A.length); // same sig
    expect(entry.inMemoryHash).not.toBeNull();
    expect(entry.persistedHash).not.toBe(entry.inMemoryHash);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns ONE entry with distinct sigLen when only signature differs at index 1", async () => {
    const persisted = [blockA(), blockB()];
    const inMemory = [blockA(), blockB({ thinkingSignature: SIG_B + "_extra" })];
    const jsonl = buildJsonl([{ responseId: "resp_2", content: persisted }]);
    const result = await diffThinkingBlocksAgainstPersisted(
      inMemory,
      "resp_2",
      "/test/session.jsonl",
      { logger: { warn: vi.fn() }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.blockIndex).toBe(1);
    expect(entry.persistedSigLen).toBe(SIG_B.length);
    expect(entry.inMemorySigLen).toBe((SIG_B + "_extra").length);
    expect(entry.persistedSigLen).not.toBe(entry.inMemorySigLen);
  });

  it("returns ONE entry with inMemoryHash:null when in-memory has fewer thinking blocks", async () => {
    const persisted = [blockA(), blockB()];
    const inMemory = [blockA()]; // missing index 1
    const jsonl = buildJsonl([{ responseId: "resp_3", content: persisted }]);
    const result = await diffThinkingBlocksAgainstPersisted(
      inMemory,
      "resp_3",
      "/test/session.jsonl",
      { logger: { warn: vi.fn() }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.blockIndex).toBe(1);
    expect(entry.inMemoryHash).toBeNull();
    expect(entry.inMemoryText.firstChars).toBe("");
    expect(entry.inMemorySigLen).toBe(0);
    expect(entry.persistedText.firstChars).toBe(TEXT_B.slice(0, 32));
    expect(entry.persistedSigLen).toBe(SIG_B.length);
  });

  it("returns [] when both sides only contain redacted thinking blocks (mirrors compute skip rule)", async () => {
    const redactedBlocks = [
      { type: "thinking", redacted: true, thinkingSignature: "redacted-sig-1" },
      { type: "thinking", redacted: true, thinkingSignature: "redacted-sig-2" },
    ];
    const jsonl = buildJsonl([{ responseId: "resp_4", content: redactedBlocks }]);
    const warn = vi.fn();
    const result = await diffThinkingBlocksAgainstPersisted(
      redactedBlocks,
      "resp_4",
      "/test/session.jsonl",
      { logger: { warn }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns [] and emits ONE warn (module='agent.bridge.wire-diff') when responseId not found", async () => {
    const jsonl = buildJsonl([{ responseId: "resp_other", content: [blockA()] }]);
    const warn = vi.fn();
    const result = await diffThinkingBlocksAgainstPersisted(
      [blockA()],
      "resp_missing",
      "/test/session.jsonl",
      { logger: { warn }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = warn.mock.calls[0]!;
    expect(payload).toMatchObject({
      module: "agent.bridge.wire-diff",
      errorKind: "internal",
      responseId: "resp_missing",
      jsonlPath: "/test/session.jsonl",
    });
    expect(typeof payload.hint).toBe("string");
    expect((payload.hint as string).length).toBeGreaterThan(0);
    expect(typeof msg).toBe("string");
    expect((msg as string).length).toBeGreaterThan(0);
  });

  it("returns [] and emits ONE warn when readFile rejects with ENOENT", async () => {
    const warn = vi.fn();
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const readFile = vi.fn().mockRejectedValue(enoent);
    const result = await diffThinkingBlocksAgainstPersisted(
      [blockA()],
      "resp_5",
      "/test/missing.jsonl",
      { logger: { warn }, readFile },
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload] = warn.mock.calls[0]!;
    expect(payload).toMatchObject({
      module: "agent.bridge.wire-diff",
      errorKind: "internal",
      jsonlPath: "/test/missing.jsonl",
      responseId: "resp_5",
    });
    expect(typeof payload.hint).toBe("string");
  });

  it("skips malformed JSONL lines silently and still finds the matching message", async () => {
    const blocks = [blockA()];
    const goodLine = JSON.stringify({
      type: "message",
      message: { role: "assistant", responseId: "resp_6", content: blocks },
    });
    const jsonl = ["{this is not valid json", "null", "{}", goodLine, "{also broken"].join("\n");
    const warn = vi.fn();
    const result = await diffThinkingBlocksAgainstPersisted(
      blocks,
      "resp_6",
      "/test/session.jsonl",
      { logger: { warn }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toEqual([]);
    // No WARN — match was found despite malformed lines.
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the FIRST match when JSONL contains two assistant messages with the same responseId", async () => {
    // First persisted entry MATCHES in-memory; second persisted entry has divergent text.
    // The helper must use the FIRST match -> expect [] (no divergence).
    const inMemory = [blockA()];
    const jsonl = buildJsonl([
      { responseId: "resp_7", content: [blockA()] }, // FIRST -- matches
      { responseId: "resp_7", content: [blockA({ thinking: "DIVERGENT" })] }, // SECOND -- ignored
    ]);
    const result = await diffThinkingBlocksAgainstPersisted(
      inMemory,
      "resp_7",
      "/test/session.jsonl",
      { logger: { warn: vi.fn() }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toEqual([]);
  });

  it("works when deps argument omits logger entirely (silent path on read error, no throw)", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("ENOENT"));
    // No logger -- helper must complete without throwing and return [].
    const result = await diffThinkingBlocksAgainstPersisted(
      [blockA()],
      "resp_8",
      "/test/missing.jsonl",
      { readFile }, // no logger
    );
    expect(result).toEqual([]);
    // Sanity: also works when deps argument is omitted entirely (uses real fs,
    // which will reject because the path doesn't exist on disk).
    const result2 = await diffThinkingBlocksAgainstPersisted(
      [blockA()],
      "resp_8",
      "/test/definitely/does/not/exist.jsonl",
    );
    expect(result2).toEqual([]);
  });

  it("ignores non-message and non-assistant JSONL entries", async () => {
    const blocks = [blockA()];
    const headerLine = JSON.stringify({ type: "header", version: 1 });
    const userLine = JSON.stringify({
      type: "message",
      message: { role: "user", responseId: "resp_9", content: [{ type: "text", text: "hi" }] },
    });
    const matchingLine = JSON.stringify({
      type: "message",
      message: { role: "assistant", responseId: "resp_9", content: blocks },
    });
    const jsonl = [headerLine, userLine, matchingLine].join("\n");
    const warn = vi.fn();
    const result = await diffThinkingBlocksAgainstPersisted(
      blocks,
      "resp_9",
      "/test/session.jsonl",
      { logger: { warn }, readFile: stubReadFile(jsonl) },
    );
    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source-shape assertion: the module must contain ZERO `throw` statements.
// This is a structural guard mirroring the JSDoc contract that the helper is
// "diagnostic instrumentation only -- logs but never throws or mutates".
// ---------------------------------------------------------------------------

describe("source-shape: thinking-block-hash-invariant.ts", () => {
  it("contains zero `throw` statements", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const sourcePath = join(__dirname, "thinking-block-hash-invariant.ts");
    const src = readFileSync(sourcePath, "utf8");
    // Strip comments before scanning so `throw` mentions in JSDoc don't
    // false-positive. Only line comments and block comments need stripping
    // for our purposes.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\bthrow\b/);
  });
});
