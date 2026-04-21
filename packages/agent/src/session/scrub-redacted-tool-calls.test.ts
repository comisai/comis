// SPDX-License-Identifier: Apache-2.0
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { scrubRedactedToolCalls } from "./scrub-redacted-tool-calls.js";

function msg(role: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: "message", message: { role, content, ...extra } };
}

function toolResult(toolCallId: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "gateway",
      content: [{ type: "text", text }],
      ...extra,
    },
  };
}

describe("scrubRedactedToolCalls", () => {
  it("no-ops on missing/invalid shape without throwing", () => {
    expect(scrubRedactedToolCalls({} as any)).toEqual({
      scrubbed: false,
      blocksRewritten: 0,
      resultsRewritten: 0,
    });
    expect(scrubRedactedToolCalls(null as any)).toEqual({
      scrubbed: false,
      blocksRewritten: 0,
      resultsRewritten: 0,
    });
    expect(scrubRedactedToolCalls({ fileEntries: "not-an-array" } as any)).toEqual({
      scrubbed: false,
      blocksRewritten: 0,
      resultsRewritten: 0,
    });
  });

  it("leaves clean sessions untouched", () => {
    const fileEntries = [
      msg("user", [{ type: "text", text: "hi" }]),
      msg("assistant", [{ type: "text", text: "hi back" }]),
    ];
    const before = JSON.stringify(fileEntries);
    const result = scrubRedactedToolCalls({ fileEntries } as any);
    expect(result.scrubbed).toBe(false);
    expect(JSON.stringify(fileEntries)).toBe(before);
  });

  it("rewrites a single env_set tool_use + its tool_result (full poison)", () => {
    const fileEntries = [
      msg(
        "assistant",
        [
          {
            type: "toolCall",
            id: "tc1",
            name: "gateway",
            arguments: {
              action: "env_set",
              env_key: "CLOUDFLARE_API_TOKEN",
              env_value: "[REDACTED]",
              _confirmed: true,
            },
          },
        ],
        { usage: { input: 1, output: 2 }, provider: "anthropic" },
      ),
      toolResult("tc1", '{"set":true,"key":"CLOUDFLARE_API_TOKEN"}'),
    ];

    const result = scrubRedactedToolCalls({ fileEntries } as any);

    expect(result.scrubbed).toBe(true);
    expect(result.blocksRewritten).toBe(1);
    expect(result.resultsRewritten).toBe(1);

    // Assistant content fully replaced with a single text block mentioning the key.
    const assistantContent = (fileEntries[0] as any).message.content;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0].type).toBe("text");
    expect(assistantContent[0].text).toContain("CLOUDFLARE_API_TOKEN");
    expect(assistantContent[0].text).toContain("[REDACTED]"); // warning text mentions the placeholder
    expect(JSON.stringify(assistantContent)).not.toContain("env_value");
    expect(JSON.stringify(assistantContent)).not.toContain("toolCall");

    // Metadata preserved.
    expect((fileEntries[0] as any).message.usage).toEqual({ input: 1, output: 2 });
    expect((fileEntries[0] as any).message.provider).toBe("anthropic");

    // Tool result converted to a plain user text message (no dangling tool_result).
    const resultMsg = (fileEntries[1] as any).message;
    expect(resultMsg.role).toBe("user");
    expect(resultMsg.toolCallId).toBeUndefined();
    expect(resultMsg.content[0].type).toBe("text");
  });

  it("rewrites the two sequential env_set calls from the reported incident", () => {
    // Mirror of the user's session lines 65-78: first CLOUDFLARE_API_TOKEN,
    // then CLOUDFLARE_ACCOUNT_ID. Both must be neutralized.
    const fileEntries = [
      msg("user", [{ type: "text", text: "here is the token" }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "tc1",
          name: "gateway",
          input: {
            action: "env_set",
            env_key: "CLOUDFLARE_API_TOKEN",
            env_value: "[REDACTED]",
            _confirmed: true,
          },
        },
      ]),
      toolResult("tc1", '{"set":true}'),
      msg("user", [{ type: "text", text: "account id: d1a847acf..." }]),
      msg("assistant", [
        {
          type: "tool_use",
          id: "tc2",
          name: "gateway",
          input: {
            action: "env_set",
            env_key: "CLOUDFLARE_ACCOUNT_ID",
            env_value: "[REDACTED]",
            _confirmed: true,
          },
        },
      ]),
      toolResult("tc2", '{"set":true}'),
    ];

    const result = scrubRedactedToolCalls({ fileEntries } as any);
    expect(result.blocksRewritten).toBe(2);
    expect(result.resultsRewritten).toBe(2);

    // Neither assistant message contains any tool_use block any more.
    const serialized = JSON.stringify(fileEntries);
    expect(serialized).not.toMatch(/tool_use|toolCall/);
    // Neither assistant message contains the raw env_value field.
    expect(serialized).not.toContain("env_value");
    // The fact of each action survives as text so the model keeps memory.
    expect(serialized).toContain("CLOUDFLARE_API_TOKEN");
    expect(serialized).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("skips mixed assistant messages (env_set + non-env_set tool_use)", () => {
    // Rewriting a single tool_use block while preserving a sibling
    // tool_use/tool_result pair risks a dangling tool_result_id. Mixed
    // env_set in a single assistant turn is vanishingly rare in practice
    // (env_set follows a confirmation flow and is always emitted standalone),
    // so the scrub opts to leave the message intact here and relies on the
    // RPC+tool guards as defense in depth.
    const fileEntries = [
      msg("assistant", [
        {
          type: "tool_use",
          id: "tc_env",
          name: "gateway",
          input: {
            action: "env_set",
            env_key: "X",
            env_value: "[REDACTED]",
          },
        },
        {
          type: "tool_use",
          id: "tc_exec",
          name: "exec",
          input: { command: "ls -la" },
        },
      ]),
      toolResult("tc_env", "{}"),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_exec",
          toolName: "exec",
          content: [{ type: "text", text: "file1\nfile2" }],
        },
      },
    ];
    const snapshot = JSON.stringify(fileEntries);

    const result = scrubRedactedToolCalls({ fileEntries } as any);

    // No rewrites happen in the mixed case.
    expect(result.scrubbed).toBe(false);
    expect(result.blocksRewritten).toBe(0);
    expect(result.resultsRewritten).toBe(0);
    expect(JSON.stringify(fileEntries)).toBe(snapshot);
  });

  it("catches exec commands whose keys were redacted inline", () => {
    // Simulates sanitize-session-secrets.ts rule 4 (exec-command-keys).
    const fileEntries = [
      msg("assistant", [
        {
          type: "tool_use",
          id: "tc1",
          name: "exec",
          input: { command: "curl -H 'Authorization: Bearer [REDACTED]' api" },
        },
      ]),
      toolResult("tc1", "{}"),
    ];

    const result = scrubRedactedToolCalls({ fileEntries } as any);
    expect(result.scrubbed).toBe(true);
    expect(result.blocksRewritten).toBe(1);
    const content = (fileEntries[0] as any).message.content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("exec");
  });

  it("is idempotent: running twice yields the same fileEntries", () => {
    const fileEntries = [
      msg("assistant", [
        {
          type: "tool_use",
          id: "tc1",
          name: "gateway",
          input: {
            action: "env_set",
            env_key: "X",
            env_value: "[REDACTED]",
          },
        },
      ]),
      toolResult("tc1", "{}"),
    ];

    const first = scrubRedactedToolCalls({ fileEntries } as any);
    expect(first.scrubbed).toBe(true);
    const snapshot = JSON.stringify(fileEntries);

    const second = scrubRedactedToolCalls({ fileEntries } as any);
    expect(second.scrubbed).toBe(false);
    expect(JSON.stringify(fileEntries)).toBe(snapshot);
  });

  it("does NOT call _rewriteFile — on-disk JSONL stays as audit record", () => {
    let rewriteCalls = 0;
    const fileEntries = [
      msg("assistant", [
        {
          type: "tool_use",
          id: "tc1",
          name: "gateway",
          input: {
            action: "env_set",
            env_key: "X",
            env_value: "[REDACTED]",
          },
        },
      ]),
      toolResult("tc1", "{}"),
    ];

    scrubRedactedToolCalls({
      fileEntries,
      _rewriteFile: () => {
        rewriteCalls += 1;
      },
    } as any);

    expect(rewriteCalls).toBe(0);
  });
});
