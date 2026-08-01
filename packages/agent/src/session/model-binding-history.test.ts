// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolvePreviousModelBinding } from "./model-binding-history.js";

function updateCall(
  callId: string,
  provider: string,
  model: string,
): Record<string, unknown> {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: callId,
        name: "agents_manage",
        arguments: {
          action: "update",
          agent_id: "agent_a",
          config: { provider, model },
        },
      }],
    },
  };
}

function successfulUpdate(callId: string): Record<string, unknown> {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "agents_manage",
      isError: false,
      details: {
        agentId: "agent_a",
        updated: true,
      },
    },
  };
}

describe("model binding history", () => {
  it("resolves the previous proven binding from successful agent updates", () => {
    const entries = [
      updateCall("call_1", "provider_a", "model_one"),
      successfulUpdate("call_1"),
      updateCall("call_2", "provider_b", "model_two"),
      successfulUpdate("call_2"),
    ];

    const result = resolvePreviousModelBinding(
      entries,
      "agent_a",
      { provider: "provider_b", model: "model_two" },
    );

    expect(result).toEqual({
      ok: true,
      value: { provider: "provider_a", model: "model_one" },
    });
  });

  it("does not infer previous state when the current binding is unreconciled", () => {
    const entries = [
      updateCall("call_1", "provider_a", "model_one"),
      successfulUpdate("call_1"),
      updateCall("call_2", "provider_b", "model_two"),
      {
        ...successfulUpdate("call_2"),
        message: {
          ...(successfulUpdate("call_2").message as Record<string, unknown>),
          isError: true,
        },
      },
    ];

    const result = resolvePreviousModelBinding(
      entries,
      "agent_a",
      { provider: "provider_b", model: "model_two" },
    );

    expect(result).toEqual({ ok: true, value: undefined });
  });
});
