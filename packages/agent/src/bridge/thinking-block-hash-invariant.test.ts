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
