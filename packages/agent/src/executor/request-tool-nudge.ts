// SPDX-License-Identifier: Apache-2.0
/** Bounded recovery for small models that repeat an old answer instead of acting. */

import { getToolMetadata, type ComisLogger } from "@comis/core";
import {
  runContinuationTurn,
  type ContinuationTurnSession,
} from "./continuation-turn.js";
import type { ProviderDispatchGuard } from "./provider-dispatch.js";

export interface RequestToolNudgeOutcome {
  fired: boolean;
  recovered: boolean;
  response?: string;
  matchedToolNames: readonly string[];
  outcome:
    | "not_small_class"
    | "no_mutating_match"
    | "tool_already_called"
    | "not_repeated"
    | "recovered"
    | "still_no_tool"
    | "followup_error";
}

export interface RunRequestToolNudgeDeps {
  session: ContinuationTurnSession;
  messages: unknown[];
  capabilityClass: string | undefined;
  requestRelevantToolNames: readonly string[];
  currentToolCallCount: () => number;
  logger: ComisLogger;
  agentId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getVisibleAssistantText: (session: any) => string;
  guardProviderDispatch: ProviderDispatchGuard;
}

const SUBMODULE = "executor.request-tool-nudge";

/* eslint-disable @typescript-eslint/no-explicit-any */
function visibleTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ");
}

function hasToolCallBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as any[]).some(
    (block) => block?.type === "toolCall" || block?.type === "tool_use",
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function repeatsEarlierAssistantAnswer(messages: unknown[]): boolean {
  const entries = messages as Array<{ role?: unknown; content?: unknown }>;
  const last = entries.at(-1);
  if (last?.role !== "assistant" || hasToolCallBlock(last.content)) return false;
  const current = visibleTextOf(last.content).trim();
  if (current.length === 0) return false;
  return entries.slice(0, -1).some(
    (entry) =>
      entry.role === "assistant"
      && visibleTextOf(entry.content).trim() === current,
  );
}

function buildDirective(toolNames: readonly string[]): string {
  return [
    "[comis: continuation — the current request still needs tool-backed action]",
    "Your last answer exactly repeated an earlier assistant answer and no tool was called.",
    `The active mutating tools matched to the current request are: ${toolNames.join(", ")}.`,
    "If the request is applicable, invoke the matching tool now.",
    "Otherwise, state the exact current blocker.",
    "Do not repeat the prior answer and do not claim success without a successful current-turn tool result.",
  ].join("\n");
}

export async function runRequestToolNudge(
  deps: RunRequestToolNudgeDeps,
): Promise<RequestToolNudgeOutcome> {
  const {
    capabilityClass,
    requestRelevantToolNames,
    currentToolCallCount,
    logger,
    agentId,
  } = deps;
  if (capabilityClass !== "small" && capabilityClass !== "nano") {
    return {
      fired: false,
      recovered: false,
      matchedToolNames: [],
      outcome: "not_small_class",
    };
  }

  const matchedToolNames = requestRelevantToolNames.filter(
    (toolName) => getToolMetadata(toolName)?.isReadOnly === false,
  );
  if (matchedToolNames.length === 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "no_mutating_match",
    };
  }
  if (currentToolCallCount() > 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "tool_already_called",
    };
  }
  if (!repeatsEarlierAssistantAnswer(deps.messages)) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "not_repeated",
    };
  }

  logger.info(
    {
      submodule: SUBMODULE,
      step: "request-tool-nudge",
      agentId,
      decision: "fire",
      reason: "repeated_prior_answer_without_tool",
      capabilityClass,
      matchedToolNames,
    },
    "Request-tool nudge firing",
  );

  const toolCallCountBefore = currentToolCallCount();
  const continuation = await runContinuationTurn(
    deps.session,
    buildDirective(matchedToolNames),
    deps.guardProviderDispatch,
  );
  if (!continuation.ok) {
    logger.warn(
      {
        submodule: SUBMODULE,
        step: "request-tool-nudge",
        agentId,
        matchedToolNames,
        errorKind: "internal" as const,
        hint:
          "The bounded request-tool continuation failed; inspect provider admission "
          + "and the matched tool inventory in comis explain.",
      },
      "Request-tool nudge continuation failed",
    );
    return {
      fired: true,
      recovered: false,
      matchedToolNames,
      outcome: "followup_error",
    };
  }

  const response = deps.getVisibleAssistantText(deps.session);
  const recovered =
    currentToolCallCount() > toolCallCountBefore
    && response.trim().length > 0;
  logger.info(
    {
      submodule: SUBMODULE,
      step: "request-tool-nudge",
      agentId,
      matchedToolNames,
      outcome: recovered ? "recovered" : "still_no_tool",
      toolCallCountBefore,
      toolCallCountAfter: currentToolCallCount(),
    },
    "Request-tool nudge completed",
  );
  return recovered
    ? {
        fired: true,
        recovered: true,
        response,
        matchedToolNames,
        outcome: "recovered",
      }
    : {
        fired: true,
        recovered: false,
        matchedToolNames,
        outcome: "still_no_tool",
      };
}
