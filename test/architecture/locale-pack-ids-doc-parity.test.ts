// SPDX-License-Identifier: Apache-2.0
/**
 * `localePacks` message-id documentation parity.
 *
 * The `localePacks` row in `docs/reference/config-yaml.mdx` is the
 * authoritative operator-facing catalogue of the ids a pack may define —
 * an operator cannot author a pack without it. It hand-copies the
 * `LocaleMessageId` closed union, and the docs tree sits outside the
 * build, lint, and coverage gates, so an id added to the runtime drifts
 * out of the reference silently.
 *
 * This gate pins the doc list to the runtime value: same ids, same order,
 * and the count stated in the prose. `LOCALE_MESSAGE_IDS` is the right
 * source to read — `ENGLISH_PACK` is typed
 * `Record<LocaleMessageId, string>`, so the compiler already rejects any
 * pack key the union does not declare and any union member the pack omits,
 * and `LOCALE_MESSAGE_IDS` is that pack's keys. Reading the exported array
 * rather than the union's source text keeps a behavior-preserving refactor
 * of the declaration from moving this gate.
 *
 * The doc row is parsed as text because it is the owned operator contract
 * under test: an operator authoring a pack reads exactly those tokens.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALE_MESSAGE_IDS } from "../../packages/agent/src/executor/degraded-reply-i18n.js";

const root = resolve(import.meta.dirname, "../..");
const configDoc = readFileSync(resolve(root, "docs/reference/config-yaml.mdx"), "utf8");

function section(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Section is missing: ${startMarker}`);
  return document.slice(start, end);
}

/** Every operator-settable id the runtime string table declares, in order. */
const unionIds: readonly string[] = LOCALE_MESSAGE_IDS;

const localePacksRow = section(configDoc, "| `localePacks` |", "\n|");

/**
 * The documented ids: the unbroken run of backticked, comma-separated
 * tokens after the `Valid ids (N):` marker. The run terminates at the
 * first token not followed by `, `, which is the sentence's final id.
 */
function documentedIds(row: string): { declaredCount: number; ids: string[] } {
  const marker = /Valid ids \((\d+)\):\s*/u.exec(row);
  if (!marker) throw new Error("The `localePacks` row no longer states `Valid ids (N):`");
  const ids: string[] = [];
  let cursor = row.slice(marker.index + marker[0].length);
  for (;;) {
    const token = /^`([a-z0-9_]+)`(, )?/u.exec(cursor);
    if (!token) break;
    ids.push(token[1]);
    if (!token[2]) break;
    cursor = cursor.slice(token[0].length);
  }
  return { declaredCount: Number(marker[1]), ids };
}

describe("localePacks message-id documentation parity", () => {
  it("reads a non-empty closed union from the runtime string table", () => {
    expect(unionIds.length).toBeGreaterThan(0);
    expect(new Set(unionIds).size).toBe(unionIds.length);
  });

  it("documents every operator-settable id, in union order", () => {
    const { ids } = documentedIds(localePacksRow);
    expect(ids).toEqual([...unionIds]);
  });

  it("states an id count matching the union", () => {
    const { declaredCount, ids } = documentedIds(localePacksRow);
    expect(declaredCount).toBe(unionIds.length);
    expect(declaredCount).toBe(ids.length);
  });

  it("keeps the activity-card ids last, as the row's trailing prose claims", () => {
    const { ids } = documentedIds(localePacksRow);
    expect(localePacksRow).toContain("The last five cover the **activity/approval card**");
    expect(ids.slice(-5).every((id) => id.startsWith("activity_card_"))).toBe(true);
    expect(ids.filter((id) => id.startsWith("activity_card_"))).toHaveLength(5);
  });
});
