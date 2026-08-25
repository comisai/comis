// SPDX-License-Identifier: Apache-2.0
import type {
  DeterministicLocalizationMessageId,
  LocalizationError,
  LocalizationPort,
  LocalizationRequest,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

type RawLocalePacks = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface DeterministicLocaleConfig {
  readonly language?: string;
  readonly localePacks?: RawLocalePacks;
}

export interface DeterministicLocalizationOptions {
  readonly getLocaleConfig?: (
    agentId: string | undefined,
  ) => DeterministicLocaleConfig | undefined;
}

const ENGLISH_TEMPLATES: Readonly<Record<DeterministicLocalizationMessageId, string>> = {
  "approval.none_pending": "No pending approvals.",
  "approval.none_pending_resolve": "No pending approvals to resolve.",
  "approval.resolved_one.approved": "Approved: {action} ({id})",
  "approval.resolved_one.denied": "Denied: {action} ({id})",
  "approval.multiple": "Multiple pending approvals. Specify an ID or use \"{command} all\":\n{choices}",
  "approval.resolved_many.approved": "Approved {count} pending approval(s).",
  "approval.resolved_many.denied": "Denied {count} pending approval(s).",
  "approval.not_found": "No pending approval found for ID: {id} (may have already been resolved or timed out).",
  "attention.response_bound": "Response recorded for attention request {id}.",
  "attention.multiple": "Multiple attention requests are open. Reply with /attention <ID> <response>:\n{choices}",
  "attention.not_found": "No open attention request was found for ID: {id}.",
  "attention.already_answered": "Attention request {id} has already been answered or closed.",
  "attention.usage": "Reply with /attention <ID> <response>.",
  "attention.unavailable": "The attention response could not be recorded. Please retry.",
  "help.commands": "Commands: /approve [ID|all], /deny [ID|all], /new, /reset, /status, /stop, /compact, /export.",
  "error.report_unavailable": "This report is no longer available.",
  "error.callback_invalid": "This callback is no longer valid (it may have already been resolved or expired).",
  "session.reset": "Session reset.",
};

function canonicalLocale(raw: string): string | undefined {
  const canonical = tryCatch(() => Intl.getCanonicalLocales(raw.trim()));
  return canonical.ok && canonical.value.length === 1 ? canonical.value[0] : undefined;
}

function localeCandidates(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const canonical = canonicalLocale(raw);
  if (canonical === undefined) return [];
  const candidates = [canonical];
  const locale = tryCatch(() => new Intl.Locale(canonical));
  if (locale.ok) {
    if (locale.value.language !== "und") candidates.push(locale.value.language);
    const maximized = tryCatch(() => locale.value.maximize().language);
    if (maximized.ok && maximized.value !== "und") candidates.push(maximized.value);
  }
  return [...new Set(candidates)];
}

function findPack(
  packs: RawLocalePacks | undefined,
  locale: string,
): Readonly<Record<string, string>> | undefined {
  if (packs === undefined) return undefined;
  return Object.entries(packs).find(
    ([configuredLocale]) => canonicalLocale(configuredLocale) === locale,
  )?.[1];
}

function resolveTemplate(
  options: DeterministicLocalizationOptions,
  request: LocalizationRequest,
  messageId: DeterministicLocalizationMessageId,
): string {
  const config = options.getLocaleConfig?.(request.agentId);
  const locale = config?.language ?? request.locale;
  for (const candidate of localeCandidates(locale)) {
    const configured = findPack(config?.localePacks, candidate)?.[messageId];
    if (configured !== undefined && configured.trim().length > 0) return configured;
  }
  return ENGLISH_TEMPLATES[messageId];
}

function required(
  request: LocalizationRequest,
  value: string,
): Result<string, LocalizationError> {
  const resolved = request.values?.[value];
  return resolved === undefined
    ? err({ kind: "missing_value", key: request.key, value })
    : ok(String(resolved));
}

function renderMessage(
  options: DeterministicLocalizationOptions,
  request: LocalizationRequest,
  messageId: DeterministicLocalizationMessageId,
  valueNames: readonly string[] = [],
): Result<string, LocalizationError> {
  const values = new Map<string, string>();
  for (const name of valueNames) {
    const value = required(request, name);
    if (!value.ok) return value;
    values.set(name, value.value);
  }
  const fallback = ENGLISH_TEMPLATES[messageId];
  const configured = resolveTemplate(options, request, messageId);
  const template = valueNames.every((name) => configured.includes(`{${name}}`))
    ? configured
    : fallback;
  let rendered = template;
  for (const [name, value] of values) {
    rendered = rendered.replaceAll(`{${name}}`, value);
  }
  return ok(rendered);
}

function renderTemplate(
  options: DeterministicLocalizationOptions,
  request: LocalizationRequest,
): Result<string, LocalizationError> {
  switch (request.key) {
    case "approval.none_pending":
    case "approval.none_pending_resolve":
    case "attention.usage":
    case "attention.unavailable":
    case "help.commands":
    case "error.report_unavailable":
    case "error.callback_invalid":
    case "session.reset":
      return renderMessage(options, request, request.key);
    case "approval.resolved_one": {
      const outcome = required(request, "outcome");
      if (!outcome.ok) return outcome;
      if (outcome.value !== "approved" && outcome.value !== "denied") {
        return err({ kind: "invalid_value", key: request.key, value: "outcome" });
      }
      return renderMessage(
        options,
        request,
        `approval.resolved_one.${outcome.value}`,
        ["action", "id"],
      );
    }
    case "approval.multiple":
      return renderMessage(options, request, "approval.multiple", ["command", "choices"]);
    case "approval.resolved_many": {
      const outcome = required(request, "outcome");
      if (!outcome.ok) return outcome;
      if (outcome.value !== "approved" && outcome.value !== "denied") {
        return err({ kind: "invalid_value", key: request.key, value: "outcome" });
      }
      return renderMessage(
        options,
        request,
        `approval.resolved_many.${outcome.value}`,
        ["count"],
      );
    }
    case "approval.not_found":
      return renderMessage(options, request, "approval.not_found", ["id"]);
    case "attention.response_bound":
    case "attention.not_found":
    case "attention.already_answered":
      return renderMessage(options, request, request.key, ["id"]);
    case "attention.multiple":
      return renderMessage(options, request, "attention.multiple", ["choices"]);
    default: {
      const exhaustive: never = request.key;
      return exhaustive;
    }
  }
}

export function createDeterministicLocalization(
  options: DeterministicLocalizationOptions = {},
): LocalizationPort {
  return { render: (request) => renderTemplate(options, request) };
}

export function renderLocalized(port: LocalizationPort, request: LocalizationRequest): string {
  const rendered = port.render(request);
  return rendered.ok ? rendered.value : "The requested response could not be rendered.";
}
