// SPDX-License-Identifier: Apache-2.0
/**
 * template-engine — the pure, single chokepoint that turns redacted tool params
 * into a user-visible activity label (ACT-06, spec §10.1).
 *
 * `applyTemplate(spec, params)` is the projection-time enforcement of
 * SEC-01/02/03. The pipeline (spec §10.1 lines 1219-1231):
 *
 *   raw params
 *     → allowlist filter   (accept ONLY the keys the LabelSpec declares —
 *                           drops the raw user message body / un-declared keys;
 *                           this is the SEC-03 reflection guard)
 *     → redactValue()      (per surviving value: secret-key + secret-shape +
 *                           absolute-path compaction + PII masks; SEC-01/02)
 *     → static substitution of `{key}` placeholders (a plain string-replace
 *                           callback — NO dynamic code execution of any form,
 *                           §19.4); a referenced placeholder absent from the
 *                           allowlist → unknown_key
 *     → length cap (label ≤ 120, detail ≤ 280) → { …, truncated }
 *
 * It is PURE: no logger, no I/O, no dynamic code execution. It consumes the
 * `redactValue` primitive from `core/security` (plan 70-02) — it does NOT
 * hand-roll redaction. The observability layer (plan 70-08) reads the returned
 * `redactionsApplied` and emits the OBS-03 WARN; this engine never logs.
 *
 * The template engine is the ONLY path from `params` to user-visible strings —
 * raw `params` never reach a channel adapter (spec §10.1 line 1233).
 *
 * @module
 */
import { ok, err, type Result } from "@comis/shared";
import {
  redactValue,
  type RedactionReason,
  type RedactOptions,
} from "../security/redact-value.js";
import type { LabelSpec } from "./label-spec.js";

// ---------------------------------------------------------------------------
// Length caps — match ActivityEvent.defaultLabel/defaultDetail (spec §4.1).
// ---------------------------------------------------------------------------

/** Maximum rendered `defaultLabel` length (spec §10.1; ActivityEvent cap). */
const MAX_LABEL_LENGTH = 120;
/** Maximum rendered `defaultDetail` length (spec §10.1; ActivityEvent cap). */
const MAX_DETAIL_LENGTH = 280;

/**
 * Placeholder token matcher: `{name}` where the name is one or more
 * word characters. A plain regex + `replace` callback — deliberately NOT a
 * template-literal that would execute its contents (§19.4). Capturing group 1
 * is the placeholder key.
 */
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

// ---------------------------------------------------------------------------
// Public contract (spec §10.1 lines 1195-1214)
// ---------------------------------------------------------------------------

/** The pure output of {@link applyTemplate}. Field names match spec §10.1. */
export interface TemplateOutput {
  /** Rendered, redacted, length-capped (≤120) label string. */
  defaultLabel: string;
  /** Rendered, redacted, length-capped (≤280) detail string (when the spec has a `detail`). */
  defaultDetail?: string;
  /** Every redaction the `redactValue` pipeline applied to the substituted values. */
  redactionsApplied: readonly { key: string; reason: RedactionReason }[];
  /** True when the label or detail was truncated to its length cap. */
  truncated: boolean;
}

/**
 * Why a template could not be rendered. Closed union — never widened to
 * `string` (AGENTS.md §2.8). `unknown_key` is the SEC-03 enforcement: a template
 * that references a placeholder the spec did not allowlist is rejected, not
 * silently filled from the raw params.
 */
export type TemplateError = { kind: "unknown_key"; key: string };

/**
 * Apply a {@link LabelSpec} to (untrusted) tool `params`, producing a redacted,
 * length-capped {@link TemplateOutput}. Pure, non-throwing.
 *
 * @param spec   - the resolved label spec (its `label`/`detail` templates +
 *                 `detailKeys` allowlist)
 * @param params - raw, un-filtered tool params (may carry secrets / the message body)
 * @param opts   - redaction options; `homeDir` enables `$HOME`→`~` path compaction
 * @returns `ok(TemplateOutput)` or `err({ kind: "unknown_key", key })`
 */
export function applyTemplate(
  spec: LabelSpec,
  params: Readonly<Record<string, unknown>>,
  opts: RedactOptions = {},
): Result<TemplateOutput, TemplateError> {
  // (1) Allowlist filter (SEC-03): keep ONLY the keys the spec declares. Every
  //     other params key — including the raw user message body — is dropped
  //     here, before any value can reach the substitution step.
  const allowed = new Set<string>(spec.detailKeys ?? []);

  // (2) Redact each surviving value via the core/security primitive (NOT a
  //     hand-rolled regex). Iterate the params' own entries (no attacker-keyed
  //     index access), keeping only allowlisted keys, and build a string view
  //     per key for substitution while accumulating the redaction records.
  const redactionsApplied: { key: string; reason: RedactionReason }[] = [];
  const substitutions = new Map<string, string>();
  for (const [key, raw] of Object.entries(params)) {
    if (!allowed.has(key)) continue;
    // Redact the value IN THE CONTEXT OF ITS KEY so key-based redaction
    // (SEC-01: a value under `token`/`apiKey`/`secret`/... collapses wholesale)
    // fires. Passing the bare value would lose the key and only catch
    // shape-based secrets. The single-key wrapper is then unwrapped via
    // Object.values (no computed index access on the result).
    const redacted = redactValue({ [key]: raw }, opts);
    for (const record of redacted.redactionsApplied) {
      redactionsApplied.push({ key, reason: record.reason });
    }
    const unwrapped = Object.values(redacted.value as Record<string, unknown>)[0];
    substitutions.set(key, stringifyValue(unwrapped));
  }

  // (3) Static substitution of `{key}` placeholders. A referenced placeholder
  //     that is NOT in the allowlist is an unknown_key error (SEC-03) — it is
  //     never resolved from the raw params. A declared-but-absent placeholder
  //     renders as empty (it is allowlisted, just not supplied).
  const labelResult = substitute(spec.label, allowed, substitutions);
  if (!labelResult.ok) return labelResult;

  let detailRendered: string | undefined;
  if (spec.detail !== undefined) {
    const detailResult = substitute(spec.detail, allowed, substitutions);
    if (!detailResult.ok) return detailResult;
    detailRendered = detailResult.value;
  }

  // (4) Length cap (spec §10.1): label ≤ 120, detail ≤ 280; flag truncation.
  let truncated = false;
  let defaultLabel = labelResult.value;
  if (defaultLabel.length > MAX_LABEL_LENGTH) {
    defaultLabel = defaultLabel.slice(0, MAX_LABEL_LENGTH);
    truncated = true;
  }
  let defaultDetail = detailRendered;
  if (defaultDetail !== undefined && defaultDetail.length > MAX_DETAIL_LENGTH) {
    defaultDetail = defaultDetail.slice(0, MAX_DETAIL_LENGTH);
    truncated = true;
  }

  return ok({
    defaultLabel,
    ...(defaultDetail !== undefined ? { defaultDetail } : {}),
    redactionsApplied,
    truncated,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace every `{key}` placeholder in `template` with its redacted
 * substitution. Static — a `String.prototype.replace` callback, never dynamic
 * code execution.
 * Returns `err(unknown_key)` for the FIRST placeholder not in `allowed`.
 */
function substitute(
  template: string,
  allowed: ReadonlySet<string>,
  substitutions: ReadonlyMap<string, string>,
): Result<string, TemplateError> {
  let unknownKey: string | undefined;
  const rendered = template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    if (!allowed.has(key)) {
      if (unknownKey === undefined) unknownKey = key;
      return ""; // discarded — we return err below
    }
    return substitutions.get(key) ?? "";
  });
  if (unknownKey !== undefined) return err({ kind: "unknown_key", key: unknownKey });
  return ok(rendered);
}

/**
 * Render a redacted value (already passed through {@link redactValue}) as a
 * substitution string. Strings pass through; primitives stringify; structured
 * values (arrays/objects survive redaction as bounded graphs) JSON-serialize so
 * a placeholder always resolves to inert text — never code.
 */
function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}
