// SPDX-License-Identifier: Apache-2.0
/**
 * Prompting snapshot builder for trace.metadata.
 *
 * Any string-typed input MUST flow through the redactor before being
 * assigned to a field — defense-in-depth. The bundle-time pass is the
 * secondary redaction layer.
 *
 * @module
 */
import { redactString, substitutePathsInString } from "@comis/observability";

/**
 * Build the trace.metadata.prompting sub-object.
 *
 * - `systemPromptDigest` and `systemPromptByteLen` are non-PII envelope fields
 *   and are passed through unchanged.
 * - `userPromptPrefixText`, when provided, is routed through `redactString`
 *   (value-shape patterns) followed by `substitutePathsInString` (path
 *   placeholder substitution) BEFORE being assigned. This ensures no PII
 *   leaks into the trajectory via the prompting field.
 *
 * Currently no live config path populates `userPromptPrefixText` into the
 * executor. The scaffold is in place so future writers
 * cannot bypass the redactor. When wired, pass the raw value via the
 * `userPromptPrefixText` field and the optional `pathOpts` for path
 * substitution context.
 */
export function buildPromptingSnapshot(state: {
  systemPromptDigest?: string;
  systemPromptByteLen?: number;
  userPromptPrefixText?: string;
  pathOpts?: { workspaceDir?: string; homeDir?: string; stateDir?: string };
}): {
  systemPromptDigest?: string;
  systemPromptByteLen?: number;
  userPromptPrefixText?: string;
} {
  const out: Record<string, unknown> = {};

  if (state.systemPromptDigest !== undefined) {
    out.systemPromptDigest = state.systemPromptDigest;
  }
  if (state.systemPromptByteLen !== undefined) {
    out.systemPromptByteLen = state.systemPromptByteLen;
  }
  if (state.userPromptPrefixText !== undefined) {
    const opts = state.pathOpts ?? {};
    // Route through value-shape redactor FIRST, then path substitution.
    // Defense-in-depth: credentials embedded in path-like strings are caught
    // by redactString before substitutePathsInString normalizes the prefix.
    out.userPromptPrefixText = substitutePathsInString(
      redactString(state.userPromptPrefixText),
      opts,
    );
  }

  return out as {
    systemPromptDigest?: string;
    systemPromptByteLen?: number;
    userPromptPrefixText?: string;
  };
}
