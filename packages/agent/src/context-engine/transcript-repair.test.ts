// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the transcript-repair pairing invariant.
 *
 * `sanitizeToolUseResultPairing(messages, now)` must return a provider-valid
 * pi-ai `Message[]` where every assistant `tool_use` block is immediately
 * followed by its matching `tool_result` message, out-of-order results are
 * re-placed, orphan/duplicate results are dropped, missing results are
 * synthesized (marked `isError: true` + an explicit marker so the model can
 * never read a placeholder as a genuine tool output), and aborted/errored
 * turns leave no dangling unpaired `tool_use`.
 *
 * Eight behaviors:
 *  1. reorder out-of-order results            5. skip/strip aborted (and errored)
 *  2. synthesize a missing result             6. no-op on a well-formed array (idempotent)
 *  3. drop an orphan result                   7. reasoning blocks untouched
 *  4. drop a duplicate result                 8. multi-call turn (results in block order)
 */

import { describe, it, expect } from "vitest";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Test helpers — build minimal pi-ai Message shapes. We `as unknown as
// AgentMessage` because the SDK assistant message carries usage/api/provider
// fields the repair never reads; the repair narrows on `role` + block `.type`.
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const SYNTH_MARKER = "[tool result missing — synthesized placeholder]";

type Block = { type: string; [k: string]: unknown };

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: NOW - 1000 } as unknown as AgentMessage;
}

function toolCallBlock(id: string, name = "do_thing"): Block {
  return { type: "toolCall", id, name, arguments: {} };
}

function textBlock(text: string): Block {
  return { type: "text", text };
}

function thinkingBlock(text: string): Block {
  return { type: "thinking", thinking: text };
}

function assistantMsg(
  content: Block[],
  stopReason: string = "stop",
): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: NOW - 500,
  } as unknown as AgentMessage;
}

function toolResultMsg(toolCallId: string, text = "ok", toolName = "do_thing"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: NOW - 400,
  } as unknown as AgentMessage;
}

// --- narrowing accessors over the opaque AgentMessage --------------------

function role(m: AgentMessage): string {
  return (m as unknown as { role: string }).role;
}

function blocks(m: AgentMessage): Block[] {
  const c = (m as unknown as { content: unknown }).content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

// The call-block type aliases the production `isToolCallBlock` recognizes; the
// helper must match the same set or it would miss an alias-shaped call.
const CALL_BLOCK_TYPES = new Set(["toolCall", "tool_call", "toolUse", "tool_use"]);

function callIdsOf(m: AgentMessage): string[] {
  return blocks(m)
    .filter((b) => CALL_BLOCK_TYPES.has(b.type))
    .map((b) => b.id as string);
}

function resultCallId(m: AgentMessage): string {
  return (m as unknown as { toolCallId: string }).toolCallId;
}

function resultText(m: AgentMessage): string {
  const c = (m as unknown as { content: Block[] }).content;
  return c.map((b) => (b.type === "text" ? (b.text as string) : "")).join("");
}

/**
 * For every tool_result in the output, assert it is the message immediately
 * after the assistant turn that emitted its toolCallId. This is the core
 * provider-validity invariant.
 */
function assertEveryResultFollowsItsCall(out: AgentMessage[]): void {
  for (let i = 0; i < out.length; i++) {
    if (role(out[i]!) !== "toolResult") continue;
    const callId = resultCallId(out[i]!);
    // The first preceding assistant turn that contains this callId.
    let found = false;
    for (let j = i - 1; j >= 0; j--) {
      if (role(out[j]!) === "assistant" && callIdsOf(out[j]!).includes(callId)) {
        // Everything between j and i must be tool_result messages for the
        // same assistant turn's calls — no user/assistant in between.
        for (let k = j + 1; k < i; k++) {
          expect(role(out[k]!)).toBe("toolResult");
        }
        found = true;
        break;
      }
      if (role(out[j]!) === "assistant") break; // a different assistant turn
    }
    expect(found).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sanitizeToolUseResultPairing (pairing invariant)", () => {
  it("reorder: places each out-of-order tool_result immediately after its tool_use", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([toolCallBlock("tu_1")], "toolUse"),
      assistantMsg([toolCallBlock("tu_2")], "toolUse"),
      toolResultMsg("tu_2"),
      toolResultMsg("tu_1"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    // tu_1 result directly after the tu_1 assistant turn; tu_2 after tu_2.
    const idxCall1 = out.findIndex((m) => role(m) === "assistant" && callIdsOf(m).includes("tu_1"));
    const idxCall2 = out.findIndex((m) => role(m) === "assistant" && callIdsOf(m).includes("tu_2"));
    expect(role(out[idxCall1 + 1]!)).toBe("toolResult");
    expect(resultCallId(out[idxCall1 + 1]!)).toBe("tu_1");
    expect(role(out[idxCall2 + 1]!)).toBe("toolResult");
    expect(resultCallId(out[idxCall2 + 1]!)).toBe("tu_2");
    assertEveryResultFollowsItsCall(out);
  });

  it("synthesize-missing: appends a marked error placeholder for an unmatched tool_use", () => {
    const input = [userMsg("hi"), assistantMsg([toolCallBlock("tu_1")], "toolUse")];

    const out = sanitizeToolUseResultPairing(input, NOW);

    const synth = out.find((m) => role(m) === "toolResult" && resultCallId(m) === "tu_1");
    expect(synth).toBeDefined();
    // Marked isError + explicit literal marker so it cannot be read
    // as a genuine tool output.
    expect((synth as unknown as { isError: boolean }).isError).toBe(true);
    expect(resultText(synth!)).toContain(SYNTH_MARKER);
    expect((synth as unknown as { timestamp: number }).timestamp).toBe(NOW);
    // No assistant tool_use is left unpaired.
    assertEveryResultFollowsItsCall(out);
  });

  it("drop-orphan: removes a tool_result whose toolCallId matches no tool_use", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([textBlock("no tools here")], "stop"),
      toolResultMsg("tu_orphan"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    expect(out.some((m) => role(m) === "toolResult" && resultCallId(m) === "tu_orphan")).toBe(false);
    expect(out.some((m) => role(m) === "toolResult")).toBe(false);
  });

  it("alias call types (tool_use|tool_call|toolUse) are recognized, so their paired results are NOT dropped as orphans", () => {
    // The PIPELINE feeds raw, un-normalized messages whose call block may carry
    // any of these `type` aliases (the canonical pi-ai shape is `toolCall`, but
    // the Anthropic Messages shape is `tool_use`). The repair MUST recognize all
    // of them — else it treats a legitimately-paired call as absent and drops the
    // result as an orphan. Every other pipeline layer already accepts these.
    for (const aliasType of ["tool_use", "tool_call", "toolUse"]) {
      const callBlock: Block = { type: aliasType, id: "tu_alias", name: "do_thing", arguments: {} };
      const input = [
        userMsg("hi"),
        assistantMsg([callBlock], "toolUse"),
        toolResultMsg("tu_alias", "ok"),
      ];

      const out = sanitizeToolUseResultPairing(input, NOW);

      const survives = out.some((m) => role(m) === "toolResult" && resultCallId(m) === "tu_alias");
      expect(survives, `alias '${aliasType}' must keep its paired result`).toBe(true);
      expect(out.filter((m) => role(m) === "toolResult")).toHaveLength(1);
      assertEveryResultFollowsItsCall(out);
    }
  });

  it("drop-duplicate: keeps exactly one tool_result per call, placed after its call", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([toolCallBlock("tu_1")], "toolUse"),
      toolResultMsg("tu_1", "first"),
      toolResultMsg("tu_1", "second"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    const results = out.filter((m) => role(m) === "toolResult" && resultCallId(m) === "tu_1");
    expect(results).toHaveLength(1);
    assertEveryResultFollowsItsCall(out);
  });

  it("strip aborted: removes dangling tool_use blocks from an aborted turn, keeping text", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([textBlock("partial answer"), toolCallBlock("tu_1")], "aborted"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    // No tool_use for tu_1 survives; no synthesized result for the aborted call.
    const allCallIds = out.flatMap((m) => (role(m) === "assistant" ? callIdsOf(m) : []));
    expect(allCallIds).not.toContain("tu_1");
    expect(out.some((m) => role(m) === "toolResult" && resultCallId(m) === "tu_1")).toBe(false);
    // Assistant text is preserved.
    const asst = out.find((m) => role(m) === "assistant")!;
    expect(blocks(asst).some((b) => b.type === "text" && b.text === "partial answer")).toBe(true);
    assertEveryResultFollowsItsCall(out);
  });

  it("strip errored: dangling tool_use blocks get the same treatment for stopReason 'error'", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([toolCallBlock("tu_1")], "error"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    const allCallIds = out.flatMap((m) => (role(m) === "assistant" ? callIdsOf(m) : []));
    expect(allCallIds).not.toContain("tu_1");
    expect(out.some((m) => role(m) === "toolResult")).toBe(false);
  });

  it("no-op: a well-formed array round-trips with pairing intact (idempotent)", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([toolCallBlock("tu_1")], "toolUse"),
      toolResultMsg("tu_1"),
      assistantMsg([textBlock("done")], "stop"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    expect(out.map(role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(resultCallId(out[2]!)).toBe("tu_1");
    assertEveryResultFollowsItsCall(out);

    // Idempotent: repairing an already-valid array changes nothing material.
    const out2 = sanitizeToolUseResultPairing(out, NOW);
    expect(out2.map(role)).toEqual(out.map(role));
  });

  it("reasoning untouched: thinking blocks keep their order alongside a tool_use", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([thinkingBlock("let me think"), toolCallBlock("tu_1")], "toolUse"),
      toolResultMsg("tu_1"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    const asst = out.find((m) => role(m) === "assistant")!;
    const bs = blocks(asst);
    // thinking block still present and still before the toolCall block.
    const thinkIdx = bs.findIndex((b) => b.type === "thinking");
    const callIdx = bs.findIndex((b) => b.type === "toolCall");
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(thinkIdx);
    // Exactly one thinking block — repair neither drops nor duplicates reasoning.
    expect(bs.filter((b) => b.type === "thinking")).toHaveLength(1);
    assertEveryResultFollowsItsCall(out);
  });

  it("non-array input passes through unchanged: never nuke the whole context", () => {
    // The SDK contract for the transformContext pipeline is "must not throw …
    // return the original messages or another safe fallback" — NOT discard the
    // context. A malformed non-array input must degrade to a PASS-THROUGH, never
    // be replaced by [] (which would silently drop the entire conversation).
    const notAnArray = { role: "assistant", content: "oops not an array" } as unknown as AgentMessage[];

    const out = sanitizeToolUseResultPairing(notAnArray, NOW);

    // Returned unchanged (referentially the same object), not emptied.
    expect(out).toBe(notAnArray);
  });

  it("empty array still returns an empty array (the well-formed empty case is unchanged)", () => {
    const out = sanitizeToolUseResultPairing([], NOW);
    expect(out).toEqual([]);
  });

  it("multi-call turn: results follow the turn in tool_use block order", () => {
    const input = [
      userMsg("hi"),
      assistantMsg([toolCallBlock("tu_a"), toolCallBlock("tu_b")], "toolUse"),
      toolResultMsg("tu_b", "b-result"),
      toolResultMsg("tu_a", "a-result"),
    ];

    const out = sanitizeToolUseResultPairing(input, NOW);

    const idxCall = out.findIndex((m) => role(m) === "assistant");
    // assistant turn, then tu_a result, then tu_b result (block order, not arrival order).
    expect(role(out[idxCall + 1]!)).toBe("toolResult");
    expect(resultCallId(out[idxCall + 1]!)).toBe("tu_a");
    expect(role(out[idxCall + 2]!)).toBe("toolResult");
    expect(resultCallId(out[idxCall + 2]!)).toBe("tu_b");
    assertEveryResultFollowsItsCall(out);
  });
});
