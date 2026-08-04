// SPDX-License-Identifier: Apache-2.0
/**
 * Pure classification helpers for background task terminal states.
 *
 * Split out of `background-task-manager.ts` to keep that module under its size cap. Both are pure
 * projections over a task's error / serialized result — no I/O, no clock, no logger.
 *
 * @module
 */

import { tryCatch } from "@comis/shared";
import type { BackgroundTaskFailureCode, ErrorKind } from "@comis/core";

const SKILL_IMPORT_INCOMPLETE_PREFIX = "Skill import is incomplete:";
const MCP_CONNECT_MISSING_PARAM_PREFIX = '[missing_param] mcp_manage(action="connect")';
const MCP_SECRET_REFERENCE_MISSING_PREFIX = '[invalid_value] enabled MCP server "';

export function classifyBackgroundTaskFailure(
  toolName: string,
  error: unknown,
): BackgroundTaskFailureCode | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (toolName === "skills_manage" && message.startsWith(SKILL_IMPORT_INCOMPLETE_PREFIX)) {
    return "skill_import_incomplete";
  }
  if (
    toolName === "mcp_manage"
    && message.startsWith(MCP_CONNECT_MISSING_PARAM_PREFIX)
    && message.includes("command or url")
  ) {
    return "mcp_connection_details_missing";
  }
  if (
    toolName === "mcp_manage"
    && message.startsWith(MCP_SECRET_REFERENCE_MISSING_PREFIX)
    && message.includes(" references ")
    && message.includes(" which is not in the secrets store")
  ) {
    return "mcp_secret_reference_missing";
  }
  return undefined;
}

export function projectBackgroundCompletionResult(
  serializedResult: string | undefined,
): {
  resultOutcome?: "success" | "degraded";
  persistence?: "persisted" | "runtime_only" | "skipped";
  errorKind?: ErrorKind;
  failureCode?: Extract<BackgroundTaskFailureCode, "mutation_not_persisted">;
} {
  if (serializedResult === undefined) return {};
  const parsed = tryCatch(() => JSON.parse(serializedResult) as unknown);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") return {};
  const details = (parsed.value as Record<string, unknown>).details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return {};
  const persistence = (details as Record<string, unknown>).persistence;
  if (persistence === "persisted") {
    return { resultOutcome: "success", persistence };
  }
  if (persistence === "runtime_only" || persistence === "skipped") {
    return {
      resultOutcome: "degraded",
      persistence,
      errorKind: "config",
      failureCode: "mutation_not_persisted",
    };
  }
  return {};
}
