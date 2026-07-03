// SPDX-License-Identifier: Apache-2.0
/**
 * label-resolver — the typed-first, ActivityStream-side label producer.
 *
 * Resolution is typed-first, deterministic-second:
 *
 *   1. `metadata.suppressActivity === true` → `null` (the tool produces NO
 *      activity at all — e.g. `memory_search` from consolidation,
 *      `discover_tools`, cron poll ticks).
 *   2. `resolveLabelSpec(toolName, { action, theme })` → the effective LabelSpec
 *      (theme override > registered spec > semantic fallback — resolved in core).
 *   3. `applyTemplate(spec, params, { homeDir })` → the redacted, length-capped
 *      label. The allowlist filter inside `applyTemplate` drops every params key
 *      the spec did not declare (the raw message body included).
 *   4. An unknown tool with no registered spec still resolves: `resolveLabelSpec`
 *      returns a semantic-fallback spec (humanized tool name) so a label always
 *      exists.
 *
 * This module is PURE — no logger, no I/O. It consumes the `@comis/core` helpers
 * (`resolveLabelSpec` + `applyTemplate`, themselves pure). Redaction-WARN
 * ownership: the resolver does NOT log the redaction WARN. {@link resolveLabelDetailed} returns
 * `redactionsApplied` upward so the ActivityStream (which holds the injected
 * logger) emits the single WARN when non-empty. It never imports
 * `channels` (the hexagonal boundary).
 *
 * @module
 */
import {
  applyTemplate,
  resolveLabelSpec,
  type ActivityTheme,
  type RedactionReason,
} from "@comis/core";

/**
 * The metadata subset the resolver reads. Mirrors the `suppressActivity?` field
 * on `ComisToolMetadata` (`@comis/core/tool-metadata`) — typed
 * here as the minimal shape so the resolver does not depend on the full
 * metadata interface.
 */
export interface ResolveLabelMetadata {
  /** When true the tool produces no activity. */
  readonly suppressActivity?: boolean;
}

/** Options for {@link resolveLabel} / {@link resolveLabelDetailed}. */
export interface ResolveLabelOpts {
  /** The active operator theme (highest-precedence label override layer). */
  readonly theme?: ActivityTheme;
  /** The tool's metadata (read for `suppressActivity`). */
  readonly metadata?: ResolveLabelMetadata;
  /** Home directory for `$HOME`→`~` path compaction. Injected; no env read here. */
  readonly homeDir?: string;
}

/** The detailed resolver result — surfaces redaction telemetry for the redaction WARN. */
export interface ResolvedLabel {
  /** The redacted, length-capped label (≤120). */
  readonly label: string;
  /** Optional redacted detail line (≤280). */
  readonly detail?: string;
  /** Every redaction the template engine applied to substituted values. */
  readonly redactionsApplied: readonly { key: string; reason: RedactionReason }[];
  /** True when the label/detail was truncated to its length cap. */
  readonly truncated: boolean;
}

/**
 * Resolve the user-visible activity label for a tool call.
 *
 * @returns the label string, or `null` when the tool suppresses activity.
 */
export function resolveLabel(
  toolName: string,
  params: Readonly<Record<string, unknown>>,
  opts: ResolveLabelOpts = {},
): string | null {
  const detailed = resolveLabelDetailed(toolName, params, opts);
  return detailed === null ? null : detailed.label;
}

/**
 * Resolve the activity label AND its redaction telemetry. The ActivityStream
 * calls this so it can emit the redaction WARN when `redactionsApplied` is
 * non-empty (the resolver itself stays pure / loggerless).
 *
 * @returns the resolved label + redaction records, or `null` under suppression.
 */
export function resolveLabelDetailed(
  toolName: string,
  params: Readonly<Record<string, unknown>>,
  opts: ResolveLabelOpts = {},
): ResolvedLabel | null {
  // (1) suppressActivity short-circuit — no activity at all.
  if (opts.metadata?.suppressActivity === true) return null;

  // (2) The action discriminator (if present) selects a per-action spec.
  const action = typeof params.action === "string" ? params.action : undefined;

  // (3) Typed-first resolution in core: theme > registered > semantic fallback.
  const spec = resolveLabelSpec(toolName, {
    ...(action !== undefined ? { action } : {}),
    ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
  });

  // (4) Apply the template (allowlist filter + redact + substitute + cap).
  const result = applyTemplate(
    spec,
    params,
    opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {},
  );
  if (!result.ok) {
    // A template referenced a placeholder its spec did not allowlist. Fall back
    // to the bare (humanized / semantic) label so an activity still renders —
    // never surface raw params. The semantic label has no placeholders.
    return {
      label: spec.label.replace(/\{[A-Za-z0-9_]+\}/g, "").trim(),
      redactionsApplied: [],
      truncated: false,
    };
  }

  return {
    label: result.value.defaultLabel,
    ...(result.value.defaultDetail !== undefined ? { detail: result.value.defaultDetail } : {}),
    redactionsApplied: result.value.redactionsApplied,
    truncated: result.value.truncated,
  };
}
