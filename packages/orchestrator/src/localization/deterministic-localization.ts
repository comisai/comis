// SPDX-License-Identifier: Apache-2.0
import type {
  LocalizationError,
  LocalizationPort,
  LocalizationRequest,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

function required(
  request: LocalizationRequest,
  value: string,
): Result<string, LocalizationError> {
  const resolved = request.values?.[value];
  return resolved === undefined
    ? err({ kind: "missing_value", key: request.key, value })
    : ok(String(resolved));
}

function renderTemplate(request: LocalizationRequest): Result<string, LocalizationError> {
  switch (request.key) {
    case "approval.none_pending":
      return ok("No pending approvals.");
    case "approval.none_pending_resolve":
      return ok("No pending approvals to resolve.");
    case "approval.resolved_one": {
      const outcome = required(request, "outcome");
      if (!outcome.ok) return outcome;
      if (outcome.value !== "approved" && outcome.value !== "denied") {
        return err({ kind: "invalid_value", key: request.key, value: "outcome" });
      }
      const action = required(request, "action");
      if (!action.ok) return action;
      const id = required(request, "id");
      if (!id.ok) return id;
      const label = outcome.value === "approved" ? "Approved" : "Denied";
      return ok(`${label}: ${action.value} (${id.value})`);
    }
    case "approval.multiple": {
      const command = required(request, "command");
      if (!command.ok) return command;
      const choices = required(request, "choices");
      if (!choices.ok) return choices;
      return ok(`Multiple pending approvals. Specify an ID or use "${command.value} all":\n${choices.value}`);
    }
    case "approval.resolved_many": {
      const outcome = required(request, "outcome");
      if (!outcome.ok) return outcome;
      if (outcome.value !== "approved" && outcome.value !== "denied") {
        return err({ kind: "invalid_value", key: request.key, value: "outcome" });
      }
      const count = required(request, "count");
      if (!count.ok) return count;
      const label = outcome.value === "approved" ? "Approved" : "Denied";
      return ok(`${label} ${count.value} pending approval(s).`);
    }
    case "approval.not_found": {
      const id = required(request, "id");
      return id.ok
        ? ok(`No pending approval found for ID: ${id.value} (may have already been resolved or timed out).`)
        : id;
    }
    case "help.commands":
      return ok("Commands: /approve [ID|all], /deny [ID|all], /new, /reset, /status, /stop, /compact, /export.");
    case "error.report_unavailable":
      return ok("This report is no longer available.");
    case "error.callback_invalid":
      return ok("This callback is no longer valid (it may have already been resolved or expired).");
    case "session.reset":
      return ok("Session reset.");
    default: {
      const exhaustive: never = request.key;
      return exhaustive;
    }
  }
}

export function createDeterministicLocalization(): LocalizationPort {
  return { render: renderTemplate };
}

export function renderLocalized(port: LocalizationPort, request: LocalizationRequest): string {
  const rendered = port.render(request);
  return rendered.ok ? rendered.value : "The requested response could not be rendered.";
}
