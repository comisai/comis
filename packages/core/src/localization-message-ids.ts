// SPDX-License-Identifier: Apache-2.0

/** Locale-pack ids consumed by deterministic inbound platform replies. */
export const DETERMINISTIC_LOCALIZATION_MESSAGE_IDS = [
  "approval.none_pending",
  "approval.none_pending_resolve",
  "approval.resolved_one.approved",
  "approval.resolved_one.denied",
  "approval.multiple",
  "approval.resolved_many.approved",
  "approval.resolved_many.denied",
  "approval.not_found",
  "attention.response_bound",
  "attention.multiple",
  "attention.not_found",
  "attention.already_answered",
  "attention.usage",
  "attention.unavailable",
  "help.commands",
  "error.report_unavailable",
  "error.callback_invalid",
  "session.reset",
] as const;

export type DeterministicLocalizationMessageId =
  typeof DETERMINISTIC_LOCALIZATION_MESSAGE_IDS[number];
