// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

export type LocalizationKey =
  | "approval.none_pending"
  | "approval.none_pending_resolve"
  | "approval.resolved_one"
  | "approval.multiple"
  | "approval.resolved_many"
  | "approval.not_found"
  | "help.commands"
  | "error.report_unavailable"
  | "error.callback_invalid"
  | "session.reset";

export interface LocalizationRequest {
  readonly key: LocalizationKey;
  readonly locale?: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export type LocalizationError =
  | { readonly kind: "missing_value"; readonly key: LocalizationKey; readonly value: string }
  | { readonly kind: "invalid_value"; readonly key: LocalizationKey; readonly value: string };

/** Renders deterministic runtime replies from a resolved locale. */
export interface LocalizationPort {
  render(request: LocalizationRequest): Result<string, LocalizationError>;
}
