// SPDX-License-Identifier: Apache-2.0
/**
 * Configuration command parsers/formatters (Phase 43 split per FILE-SPLIT-10).
 *
 * Extracted from `config.ts` to drop it below the 800L cap. These are pure
 * transformations: no RPC calls, no fs I/O, no side effects beyond the
 * documented in-place mutation in `resolveEnvRefs` (which mirrors the
 * original inline behavior — the caller passes a transient merge result).
 *
 * @module
 */
import { isMap, isPair, isScalar, type parseDocument } from "yaml";

/** Pattern matching `${VAR_NAME}` env var references. */
const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Deep-walk an object and resolve `${VAR}` references using process.env.
 * Mutates in place for efficiency since the input is a transient merge result.
 */
export function resolveEnvRefs(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.includes("${")) {
      obj[key] = value.replace(ENV_REF_RE, (match, varName: string) => {
        // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
        return process.env[varName] ?? match;
      });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      resolveEnvRefs(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          resolveEnvRefs(item as Record<string, unknown>);
        }
      }
    }
  }
}

/**
 * Read the keys of an existing `tooling.*.capabilityHints` map from a
 * yaml@2.8.4 Document. Returns an empty array if the path is absent or
 * the value at the path is not a YAMLMap. Local helper (avoids exposing
 * a mutation-AST utility from the sync-tooling barrel).
 */
export function readHintKeysForInspect(
  doc: ReturnType<typeof parseDocument>,
  hintMapPath: string[],
): string[] {
  if (!doc.hasIn(hintMapPath)) return [];
  const node = doc.getIn(hintMapPath, true);
  if (!isMap(node)) return [];
  const keys: string[] = [];
  for (const p of node.items) {
    if (!isPair(p)) continue;
    const k = isScalar(p.key) ? p.key.value : p.key;
    if (typeof k === "string") keys.push(k);
  }
  return keys;
}

/**
 * Truncate a string to a maximum length with ellipsis.
 */
export function truncate(str: string, maxLength: number): string {
  const oneLine = str.replace(/\n/g, " ");
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 3) + "...";
}

/**
 * Format an ISO date string for display.
 */
export function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString();
  } catch {
    return dateStr;
  }
}
