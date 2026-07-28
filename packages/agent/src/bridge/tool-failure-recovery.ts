// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import type { ErrorKind } from "@comis/core";

const MAX_IDENTITY_FIELD_CHARS = 512;
const MESSAGE_ACTIONS = new Set([
  "send",
  "reply",
  "react",
  "edit",
  "delete",
  "fetch",
  "attach",
] as const);

export type MessageRecoveryAction =
  | "send"
  | "reply"
  | "react"
  | "edit"
  | "delete"
  | "fetch"
  | "attach";

export interface ToolRecoveryIdentity {
  readonly kind: "message_route";
  readonly action: MessageRecoveryAction;
  readonly routeTargetDigest: string;
}

export interface ToolExecutionResultRecord {
  readonly toolName: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly invocationSequence?: number;
  readonly errorText?: string;
  readonly errorKind?: ErrorKind;
  readonly recoveryIdentity?: ToolRecoveryIdentity;
}

export interface ToolFailureRecoveryClassification {
  readonly recoveredFailureCount: number;
  readonly unrecoveredFailureCount: number;
  readonly recoveredToolNames: readonly string[];
  readonly unrecoveredToolNames: readonly string[];
}

function boundedIdentityField(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTITY_FIELD_CHARS
    ? value
    : undefined;
}

function messageAction(value: unknown): MessageRecoveryAction | undefined {
  return typeof value === "string" && MESSAGE_ACTIONS.has(value as MessageRecoveryAction)
    ? value as MessageRecoveryAction
    : undefined;
}

function targetField(
  action: MessageRecoveryAction,
  args: Record<string, unknown>,
): readonly [string, string] | undefined {
  switch (action) {
    case "reply":
    case "react":
    case "edit":
    case "delete":
      {
        const messageId = boundedIdentityField(args.message_id);
        return messageId === undefined ? undefined : ["message", messageId];
      }
    case "attach": {
      const attachmentUrl = boundedIdentityField(args.attachment_url);
      return attachmentUrl === undefined ? undefined : ["attachment", attachmentUrl];
    }
    case "fetch": {
      const before = args.before === undefined ? "" : boundedIdentityField(args.before);
      return before === undefined ? undefined : ["cursor", before];
    }
    case "send":
      return ["channel", ""];
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function buildToolRecoveryIdentity(
  toolName: string,
  args: unknown,
  identitySalt: string,
): ToolRecoveryIdentity | undefined {
  if (toolName !== "message" || typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const values = args as Record<string, unknown>;
  const action = messageAction(values.action);
  const channelType = boundedIdentityField(values.channel_type);
  const channelId = boundedIdentityField(values.channel_id);
  if (action === undefined || channelType === undefined || channelId === undefined) {
    return undefined;
  }
  const target = targetField(action, values);
  if (target === undefined) return undefined;
  const routeTargetDigest = createHmac("sha256", identitySalt)
    .update(JSON.stringify([channelType, channelId, ...target]), "utf8")
    .digest("hex");
  return { kind: "message_route", action, routeTargetDigest };
}

function identitiesMatch(
  failure: ToolExecutionResultRecord,
  success: ToolExecutionResultRecord,
): boolean {
  if (failure.toolName !== success.toolName) return false;
  if (failure.toolName !== "message") return true;
  const failedIdentity = failure.recoveryIdentity;
  const successfulIdentity = success.recoveryIdentity;
  return failedIdentity !== undefined
    && successfulIdentity !== undefined
    && failedIdentity.kind === successfulIdentity.kind
    && failedIdentity.action === successfulIdentity.action
    && failedIdentity.routeTargetDigest === successfulIdentity.routeTargetDigest;
}

function isLaterInvocation(
  failure: ToolExecutionResultRecord,
  success: ToolExecutionResultRecord,
): boolean {
  return failure.invocationSequence !== undefined
    && success.invocationSequence !== undefined
    && success.invocationSequence > failure.invocationSequence;
}

export function classifyToolFailureRecovery(
  failedTools: readonly string[],
  toolExecResults: readonly ToolExecutionResultRecord[] | undefined,
): ToolFailureRecoveryClassification {
  const results = toolExecResults ?? [];
  const failureNames = new Set<string>();
  const unrecoveredNames = new Set<string>();
  let recoveredFailureCount = 0;
  let unrecoveredFailureCount = 0;

  for (let failureIndex = 0; failureIndex < results.length; failureIndex += 1) {
    const failure = results[failureIndex];
    if (failure === undefined || failure.success) continue;
    failureNames.add(failure.toolName);
    const recovered = results.slice(failureIndex + 1).some(
      (candidate) => candidate.success
        && isLaterInvocation(failure, candidate)
        && identitiesMatch(failure, candidate),
    );
    if (recovered) {
      recoveredFailureCount += 1;
    } else {
      unrecoveredFailureCount += 1;
      unrecoveredNames.add(failure.toolName);
    }
  }

  for (const failedTool of new Set(failedTools)) {
    if (failureNames.has(failedTool)) continue;
    failureNames.add(failedTool);
    unrecoveredNames.add(failedTool);
    unrecoveredFailureCount += 1;
  }

  return {
    recoveredFailureCount,
    unrecoveredFailureCount,
    recoveredToolNames: [...failureNames].filter((toolName) => !unrecoveredNames.has(toolName)),
    unrecoveredToolNames: [...unrecoveredNames],
  };
}
