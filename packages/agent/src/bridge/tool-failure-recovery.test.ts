// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildToolInvocationStallFailureReply,
  buildToolRecoveryIdentity,
  classifySubagentTerminalToolFailure,
  classifyToolFailureRecovery,
  type ToolExecutionResultRecord,
} from "./tool-failure-recovery.js";

const IDENTITY_SALT = "identity-salt-a";

function messageResult(input: {
  success: boolean;
  action: "send" | "reply" | "attach";
  channelId?: string;
  attachmentUrl?: string;
  messageId?: string;
  invocationSequence: number;
}): ToolExecutionResultRecord {
  const args = {
    action: input.action,
    channel_type: "telegram",
    channel_id: input.channelId ?? "channel-a",
    ...(input.attachmentUrl === undefined ? {} : { attachment_url: input.attachmentUrl }),
    ...(input.messageId === undefined ? {} : { message_id: input.messageId }),
  };
  return {
    toolName: "message",
    success: input.success,
    durationMs: 1,
    invocationSequence: input.invocationSequence,
    recoveryIdentity: buildToolRecoveryIdentity("message", args, IDENTITY_SALT),
  };
}

describe("tool failure recovery classification", () => {
  it("keeps an attach failure unrecovered after an unrelated send succeeds", () => {
    const classification = classifyToolFailureRecovery(
      ["message"],
      [
        messageResult({ success: false, action: "attach", attachmentUrl: "/workspace/report.pdf", invocationSequence: 0 }),
        messageResult({ success: true, action: "send", invocationSequence: 1 }),
      ],
    );

    expect(classification).toEqual({
      recoveredFailureCount: 0,
      unrecoveredFailureCount: 1,
      recoveredToolNames: [],
      unrecoveredToolNames: ["message"],
    });
  });

  it("recovers only after the same message operation and exact target succeeds", () => {
    const failed = messageResult({
      success: false,
      action: "attach",
      attachmentUrl: "/workspace/report.pdf",
      invocationSequence: 0,
    });
    const succeeded = messageResult({
      success: true,
      action: "attach",
      attachmentUrl: "/workspace/report.pdf",
      invocationSequence: 1,
    });

    expect(classifyToolFailureRecovery(["message"], [failed, succeeded])).toEqual({
      recoveredFailureCount: 1,
      unrecoveredFailureCount: 0,
      recoveredToolNames: ["message"],
      unrecoveredToolNames: [],
    });
  });

  it("does not let success before failure erase the later failure", () => {
    const succeeded = messageResult({ success: true, action: "send", invocationSequence: 0 });
    const failed = messageResult({ success: false, action: "send", invocationSequence: 1 });

    expect(classifyToolFailureRecovery(["message"], [succeeded, failed])).toMatchObject({
      recoveredFailureCount: 0,
      unrecoveredFailureCount: 1,
      unrecoveredToolNames: ["message"],
    });
  });

  it("does not let an earlier invocation finishing later recover a failure", () => {
    const failed = messageResult({ success: false, action: "send", invocationSequence: 1 });
    const earlierSuccess = messageResult({ success: true, action: "send", invocationSequence: 0 });

    expect(classifyToolFailureRecovery(["message"], [failed, earlierSuccess])).toMatchObject({
      recoveredFailureCount: 0,
      unrecoveredFailureCount: 1,
      unrecoveredToolNames: ["message"],
    });
  });

  it("keeps a failure unrecovered when invocation evidence is missing", () => {
    const failed = messageResult({ success: false, action: "send", invocationSequence: 0 });
    const succeeded = messageResult({ success: true, action: "send", invocationSequence: 1 });
    const withoutInvocationEvidence = { ...succeeded, invocationSequence: undefined };

    expect(
      classifyToolFailureRecovery(["message"], [failed, withoutInvocationEvidence]),
    ).toMatchObject({
      recoveredFailureCount: 0,
      unrecoveredFailureCount: 1,
      unrecoveredToolNames: ["message"],
    });
  });

  it("does not recover message failures across actions routes or targets", () => {
    const failures = [
      messageResult({ success: false, action: "attach", attachmentUrl: "/workspace/report.pdf", invocationSequence: 0 }),
      messageResult({ success: false, action: "reply", messageId: "message-a", invocationSequence: 1 }),
      messageResult({ success: false, action: "send", channelId: "channel-b", invocationSequence: 2 }),
    ];
    const unrelatedSuccesses = [
      messageResult({ success: true, action: "send", invocationSequence: 3 }),
      messageResult({ success: true, action: "reply", messageId: "message-b", invocationSequence: 4 }),
      messageResult({ success: true, action: "send", channelId: "channel-c", invocationSequence: 5 }),
    ];

    expect(
      classifyToolFailureRecovery(["message"], [...failures, ...unrelatedSuccesses]),
    ).toMatchObject({
      recoveredFailureCount: 0,
      unrecoveredFailureCount: 3,
      unrecoveredToolNames: ["message"],
    });
  });

  it("retains ordered same-tool recovery for tools without delivery routes", () => {
    expect(classifyToolFailureRecovery(
      ["write"],
      [
        { toolName: "write", success: false, durationMs: 1, invocationSequence: 0 },
        { toolName: "write", success: true, durationMs: 1, invocationSequence: 1 },
      ],
    )).toMatchObject({
      recoveredFailureCount: 1,
      unrecoveredFailureCount: 0,
      recoveredToolNames: ["write"],
    });
  });

  it("does not let a different exec command hide a prior exec failure", () => {
    const blocked = buildToolRecoveryIdentity(
      "exec",
      { command: 'find "$HOME/Downloads" -exec rm -rf -- {} +' },
      IDENTITY_SALT,
    );
    const noEffect = buildToolRecoveryIdentity(
      "exec",
      { command: 'rm -rf -- "$HOME/Downloads"/*' },
      IDENTITY_SALT,
    );

    expect(classifyToolFailureRecovery(
      ["exec"],
      [
        {
          toolName: "exec",
          success: false,
          durationMs: 1,
          invocationSequence: 0,
          recoveryIdentity: blocked,
        },
        {
          toolName: "exec",
          success: true,
          durationMs: 1,
          invocationSequence: 1,
          recoveryIdentity: noEffect,
        },
      ],
    )).toMatchObject({
      recoveredFailureCount: 0,
      unrecoveredFailureCount: 1,
      recoveredToolNames: [],
      unrecoveredToolNames: ["exec"],
    });
  });

  it("recovers an exec failure only when the exact command later succeeds", () => {
    const identity = buildToolRecoveryIdentity(
      "exec",
      { command: "pnpm test" },
      IDENTITY_SALT,
    );

    expect(classifyToolFailureRecovery(
      ["exec"],
      [
        {
          toolName: "exec",
          success: false,
          durationMs: 1,
          invocationSequence: 0,
          recoveryIdentity: identity,
        },
        {
          toolName: "exec",
          success: true,
          durationMs: 1,
          invocationSequence: 1,
          recoveryIdentity: identity,
        },
      ],
    )).toMatchObject({
      recoveredFailureCount: 1,
      unrecoveredFailureCount: 0,
      recoveredToolNames: ["exec"],
    });
  });

  it("keeps exec identities content-free while binding the exact command", () => {
    const identity = buildToolRecoveryIdentity(
      "exec",
      { command: "rm -rf private-folder" },
      IDENTITY_SALT,
    );
    const serialized = JSON.stringify(identity);

    expect(identity).toMatchObject({
      kind: "exec_command",
      commandDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(serialized).not.toContain("private-folder");
    expect(serialized).not.toContain("rm -rf");
  });

  it("keeps recovery identities bounded and free of raw route values", () => {
    const identity = buildToolRecoveryIdentity("message", {
      action: "attach",
      channel_type: "telegram",
      channel_id: "private-channel-a",
      attachment_url: "/workspace/private-report.pdf",
      caption: "private message body",
    }, IDENTITY_SALT);
    const serialized = JSON.stringify(identity);

    expect(identity).toMatchObject({
      kind: "message_route",
      action: "attach",
      routeTargetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(serialized).not.toContain("private-channel-a");
    expect(serialized).not.toContain("private-report.pdf");
    expect(serialized).not.toContain("private message body");
  });
});

describe("subagent terminal tool failure classification", () => {
  const failedSearch: ToolExecutionResultRecord = {
    toolName: "web_search",
    success: false,
    durationMs: 25,
    errorKind: "resource",
    failureDisclosure: {
      kind: "quota_exhausted",
      configKey: "tools.web.search",
    },
  };

  it("retains actionable disclosure when a subagent completes with tool errors", () => {
    expect(
      classifySubagentTerminalToolFailure({
        operationType: "subagent",
        finishReason: "completed_with_tool_errors",
        failedTools: ["web_search"],
        toolExecResults: [failedSearch],
      }),
    ).toEqual({
      toolName: "web_search",
      errorKind: "resource",
      disclosure: {
        kind: "quota_exhausted",
        configKey: "tools.web.search",
      },
    });
  });

  it("ignores successful or recovered subagent settlements", () => {
    expect(
      classifySubagentTerminalToolFailure({
        operationType: "subagent",
        finishReason: "stop",
        failedTools: ["web_search"],
        toolExecResults: [failedSearch],
      }),
    ).toBeUndefined();

    expect(
      classifySubagentTerminalToolFailure({
        operationType: "subagent",
        finishReason: "completed_with_tool_errors",
        failedTools: [],
        toolExecResults: [
          { ...failedSearch, invocationSequence: 1 },
          {
            toolName: "web_search",
            success: true,
            durationMs: 18,
            invocationSequence: 2,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("keeps direct resource aborts authoritative over earlier tool failures", () => {
    for (const finishReason of [
      "max_steps",
      "budget_exceeded",
      "budget_exhausted",
      "spend_exceeded",
      "context_loop",
      "context_exhausted",
      "loop_detected",
      "circuit_open",
      "provider_degraded",
      "input_too_large",
    ]) {
      expect(
        classifySubagentTerminalToolFailure({
          operationType: "subagent",
          finishReason,
          failedTools: ["web_search"],
          toolExecResults: [failedSearch],
        }),
        finishReason,
      ).toBeUndefined();
    }
  });
});

describe("foreground tool invocation stall disclosure", () => {
  it("names the missing provider secret without copying upstream prose", () => {
    const reply = buildToolInvocationStallFailureReply({
      failedTools: ["web_search"],
      toolExecResults: [{
        toolName: "web_search",
        success: false,
        durationMs: 10,
        errorText: "private upstream response",
        failureDisclosure: {
          kind: "missing_configuration",
          configKey: "secrets.SEARCH_API_KEY",
        },
      }],
    });

    expect(reply).toContain("web_search");
    expect(reply).toContain("secrets.SEARCH_API_KEY");
    expect(reply).toContain("could not complete");
    expect(reply).not.toContain("private upstream response");
  });
});
