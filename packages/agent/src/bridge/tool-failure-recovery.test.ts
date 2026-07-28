// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildToolRecoveryIdentity,
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
