// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import type {
  ErrorKind,
  ModelOperationType,
  ToolFailureDisclosure,
} from "@comis/core";

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
const TOOL_ATTRIBUTABLE_SUBAGENT_FINISH_REASONS = new Set([
  "completed_with_tool_errors",
  "error",
  "prompt_timeout",
] as const);

export type MessageRecoveryAction =
  | "send"
  | "reply"
  | "react"
  | "edit"
  | "delete"
  | "fetch"
  | "attach";

export interface MessageRecoveryIdentity {
  readonly kind: "message_route";
  readonly action: MessageRecoveryAction;
  readonly routeTargetDigest: string;
}

export interface ExecRecoveryIdentity {
  readonly kind: "exec_command";
  readonly commandDigest: string;
}

export type ToolRecoveryIdentity = MessageRecoveryIdentity | ExecRecoveryIdentity;

export type SchedulerPolicyEvidence = "holiday" | "weekday" | "weekend";

/** Closed, content-free limitations carried by a model-facing observability receipt. */
export interface ObservabilityEvidenceLimits {
  readonly cost?: "runtime_estimate";
  readonly providerInvoice?: "unverified";
  readonly crossExecutionDurationRanking?: "unavailable";
}

// @optional-field-count: A tool-result receipt aggregates independently conditional evidence from message, exec, web, scheduler, background, and observability boundaries; fields stay absent unless the trusted boundary emitted them.
export interface ToolExecutionResultRecord {
  readonly toolName: string;
  /** Bounded structured action discriminator from the tool arguments. */
  readonly action?: string;
  readonly success: boolean;
  /** Whether a successful side-effecting tool changed its target state. */
  readonly changed?: boolean;
  /** True when this record is a non-terminal background handoff placeholder. */
  readonly backgrounded?: boolean;
  /** True when the trusted tool boundary stopped before a gated side effect. */
  readonly requiresConfirmation?: boolean;
  readonly durationMs: number;
  readonly invocationSequence?: number;
  readonly errorText?: string;
  readonly errorKind?: ErrorKind;
  /** Bounded snake_case terminal code emitted by the trusted tool boundary. */
  readonly failureCode?: string;
  /** Trusted, bounded adapter classification; never raw tool/provider prose. */
  readonly failureDisclosure?: ToolFailureDisclosure;
  readonly recoveryIdentity?: ToolRecoveryIdentity;
  /** SHA-256 of the exact final URL for a successful web_fetch. */
  readonly citationUrlDigest?: string;
  /** SHA-256 of the canonical query for a successful web_search. */
  readonly webSearchQueryDigest?: string;
  /** Closed, content-free policy classifications from a current cron-list receipt. */
  readonly schedulerPolicyEvidence?: readonly SchedulerPolicyEvidence[];
  /** Closed qualifications that prevent a self-report from overstating the receipt. */
  readonly observabilityEvidenceLimits?: ObservabilityEvidenceLimits;
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
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const values = args as Record<string, unknown>;
  if (toolName === "exec") {
    const command = boundedIdentityField(values.command);
    if (command === undefined) return undefined;
    return {
      kind: "exec_command",
      commandDigest: createHmac("sha256", identitySalt)
        .update(command, "utf8")
        .digest("hex"),
    };
  }
  if (toolName !== "message") {
    return undefined;
  }
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
  if (failure.toolName !== "message" && failure.toolName !== "exec") return true;
  const failedIdentity = failure.recoveryIdentity;
  const successfulIdentity = success.recoveryIdentity;
  if (failedIdentity === undefined || successfulIdentity === undefined) {
    return false;
  }
  if (
    failedIdentity.kind === "exec_command"
    && successfulIdentity.kind === "exec_command"
  ) {
    return failedIdentity.commandDigest === successfulIdentity.commandDigest;
  }
  return failedIdentity.kind === "message_route"
    && successfulIdentity.kind === "message_route"
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
    const failure = results.at(failureIndex);
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

const MAX_CONFIG_KEY_CHARS = 256;

function isConfigKeySegment(value: string): boolean {
  if (value.length === 0) return false;
  const first = value.charCodeAt(0);
  const firstIsLetter =
    (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (!firstIsLetter) return false;
  for (const character of value.slice(1)) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || character === "_"
      || character === "-";
    if (!allowed) return false;
  }
  return true;
}

/** Accept only closed, content-free disclosure facts from trusted tool metadata. */
export function normalizeToolFailureDisclosure(
  value: unknown,
): ToolFailureDisclosure | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { kind?: unknown; configKey?: unknown };
  if (
    typeof candidate.configKey !== "string"
    || candidate.configKey.length > MAX_CONFIG_KEY_CHARS
  ) {
    return undefined;
  }
  const segments = candidate.configKey.split(".");
  if (
    segments.length < 2
    || segments.length > 9
    || !segments.every(isConfigKeySegment)
  ) {
    return undefined;
  }
  switch (candidate.kind) {
    case "missing_configuration":
    case "quota_exhausted":
    case "provider_unavailable":
      return {
        kind: candidate.kind,
        configKey: candidate.configKey,
      };
    default:
      return undefined;
  }
}

function latestUnrecoveredDisclosure(
  failedTools: readonly string[],
  toolExecResults: readonly ToolExecutionResultRecord[] | undefined,
): ToolExecutionResultRecord | undefined {
  const unrecovered = new Set(
    classifyToolFailureRecovery(failedTools, toolExecResults).unrecoveredToolNames,
  );
  const results = toolExecResults ?? [];
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results.at(index);
    if (
      result !== undefined
      && !result.success
      && result.failureDisclosure !== undefined
      && unrecovered.has(result.toolName)
    ) {
      return result;
    }
  }
  return undefined;
}

/** Build an actionable foreground reply when a tool stall has a trusted recovery key. */
export function buildToolInvocationStallFailureReply(params: {
  failedTools: readonly string[];
  toolExecResults: readonly ToolExecutionResultRecord[] | undefined;
}): string | undefined {
  const failure = latestUnrecoveredDisclosure(
    params.failedTools,
    params.toolExecResults,
  );
  const disclosure = failure?.failureDisclosure;
  if (failure === undefined || disclosure === undefined) return undefined;

  switch (disclosure.kind) {
    case "missing_configuration":
      return (
        `I could not complete the request because ${failure.toolName} is not configured. `
        + `Configure ${disclosure.configKey} before retrying.`
      );
    case "quota_exhausted":
    case "provider_unavailable":
      return undefined;
    default: {
      const _exhaustive: never = disclosure;
      return _exhaustive;
    }
  }
}

export interface SubagentTerminalToolFailure {
  readonly toolName: string;
  readonly errorKind?: ErrorKind;
  readonly disclosure: ToolFailureDisclosure;
}

/**
 * Preserve trusted upstream failure facts only when the terminal reason can
 * represent a tool-caused settlement. Direct resource aborts remain
 * authoritative even when earlier tool calls also failed.
 */
export function classifySubagentTerminalToolFailure(params: {
  operationType: ModelOperationType | undefined;
  finishReason: string;
  failedTools: readonly string[];
  toolExecResults: readonly ToolExecutionResultRecord[] | undefined;
}): SubagentTerminalToolFailure | undefined {
  if (
    params.operationType !== "subagent"
    || !TOOL_ATTRIBUTABLE_SUBAGENT_FINISH_REASONS.has(
      params.finishReason as "completed_with_tool_errors" | "error" | "prompt_timeout",
    )
  ) {
    return undefined;
  }
  const failure = latestUnrecoveredDisclosure(
    params.failedTools,
    params.toolExecResults,
  );
  const disclosure = failure?.failureDisclosure;
  if (failure === undefined || disclosure === undefined) return undefined;
  return {
    toolName: failure.toolName,
    ...(failure.errorKind === undefined ? {} : { errorKind: failure.errorKind }),
    disclosure,
  };
}

/**
 * Preserve the upstream tool cause when a sub-agent's later model call times
 * out. This text is parent-rewrite input, not a direct localized platform
 * reply; it carries only fixed runtime prose plus a validated config key.
 */
export function buildSubagentTerminalToolFailureReply(params: {
  operationType: ModelOperationType | undefined;
  finishReason: string;
  failedTools: readonly string[];
  toolExecResults: readonly ToolExecutionResultRecord[] | undefined;
}): string | undefined {
  if (
    params.operationType !== "subagent"
    || params.finishReason !== "prompt_timeout"
  ) {
    return undefined;
  }
  const failure = classifySubagentTerminalToolFailure(params);
  const disclosure = failure?.disclosure;
  if (failure === undefined || disclosure === undefined) return undefined;

  switch (disclosure.kind) {
    case "missing_configuration":
      return (
        `The sub-agent could not complete the task because ${failure.toolName} is not configured. `
        + `Configure ${disclosure.configKey} before retrying. Splitting or narrowing the same request `
        + "will not fix the missing configuration."
      );
    case "quota_exhausted":
      return (
        `The sub-agent could not complete the task because ${failure.toolName} exhausted its provider `
        + `quota or plan capacity. Restore provider capacity or configure another provider under `
        + `${disclosure.configKey} before retrying. Splitting or narrowing the same request will not fix `
        + "this provider failure."
      );
    case "provider_unavailable":
      return (
        `The sub-agent could not complete the task because every available provider for `
        + `${failure.toolName} failed. Restore provider access or configure another provider under `
        + `${disclosure.configKey} before retrying. Splitting or narrowing the same request will not fix `
        + "this provider failure."
      );
    default: {
      const _exhaustive: never = disclosure;
      return _exhaustive;
    }
  }
}
