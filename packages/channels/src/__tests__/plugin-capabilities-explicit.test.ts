// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-plugin guard: every in-tree channel plugin declares the
 * `typing` / `threads` / `buttons` capability flags EXPLICITLY.
 *
 * The `ChannelFeaturesSchema` defaults these three fields (`false`/`false`/
 * `"none"`) as a safety net for *future* plugins. For the 11 in-tree
 * plugins, that default is a trap: `selectStrategy(caps)` routes each
 * channel from these flags, so a plugin that silently inherits a default
 * (e.g. Slack defaulting `threads:false`, or Telegram defaulting
 * `buttons:"none"`) would mis-route to the wrong rendering strategy.
 *
 * This test reads each plugin's DECLARED `CAPABILITIES.features` literal
 * straight from source and asserts the three keys are own-properties
 * (declared, not defaulted) and equal the pinned per-plugin value. A plugin
 * that omits any of the three FAILS — that is the regression lock.
 *
 * Why a source walk rather than constructing each plugin: the declared
 * `features` object is the plugin author's literal (it is NOT run through
 * `ChannelCapabilitySchema.parse`, so the schema defaults are never applied
 * to it — reading it genuinely distinguishes "declared" from "defaulted").
 * Constructing the live plugins would also need real adapter deps (Telegram
 * rejects an empty bot token; Email dereferences an auth block), coupling
 * this capability-flag guard to unrelated adapter internals.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

/**
 * The per-plugin capability values — the ground
 * truth this test pins. `dir` is the package sub-directory; the plugin file is
 * `<dir>/<dir>-plugin.ts`. The three asserted fields are the ones added to
 * `ChannelFeaturesSchema`.
 */
interface ExpectedCaps {
  readonly dir: string;
  readonly typing: boolean;
  readonly threads: boolean;
  readonly buttons: "inline" | "components" | "blockkit" | "quickreply" | "none";
}

const EXPECTED: readonly ExpectedCaps[] = [
  { dir: "echo", typing: false, threads: false, buttons: "none" },
  { dir: "telegram", typing: true, threads: false, buttons: "inline" },
  { dir: "discord", typing: true, threads: true, buttons: "components" },
  { dir: "slack", typing: false, threads: true, buttons: "blockkit" },
  { dir: "whatsapp", typing: true, threads: false, buttons: "none" },
  { dir: "signal", typing: true, threads: false, buttons: "none" },
  { dir: "imessage", typing: false, threads: false, buttons: "none" },
  { dir: "line", typing: true, threads: false, buttons: "quickreply" },
  { dir: "irc", typing: false, threads: false, buttons: "none" },
  { dir: "email", typing: false, threads: false, buttons: "none" },
  { dir: "msteams", typing: false, threads: false, buttons: "none" },
];

/** The three fields that MUST be declared (not defaulted) per plugin. */
const REQUIRED_FIELDS = ["typing", "threads", "buttons"] as const;

/**
 * Parse the DECLARED `features: { ... }` object literal out of a plugin's
 * source text into a plain object of literal values.
 *
 * No `eval`/`Function` (banned by AGENTS.md §2.2 / lint:security): the
 * `features` block is a flat object of boolean / string / number literals, so
 * a line-wise key:value reader is sufficient and keeps the assertion operating
 * on the genuine source declaration. Throws (test-only boundary) if the block
 * cannot be located so a refactor that renames the literal fails loudly rather
 * than silently passing.
 */
function readDeclaredFeatures(dir: string): Record<string, boolean | string | number> {
  const file = resolve(SRC_ROOT, dir, `${dir}-plugin.ts`);
  const source = readFileSync(file, "utf8");

  const featuresStart = source.indexOf("features:");
  if (featuresStart === -1) {
    throw new Error(`No 'features:' literal found in ${dir}-plugin.ts`);
  }
  const openBrace = source.indexOf("{", featuresStart);
  if (openBrace === -1) {
    throw new Error(`No '{' after 'features:' in ${dir}-plugin.ts`);
  }
  // Brace-match to find the end of the features object (handles the flat,
  // single-level features literal these plugins use).
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) {
    throw new Error(`Unterminated 'features' object in ${dir}-plugin.ts`);
  }

  const body = source.slice(openBrace + 1, closeBrace);
  const declared: Record<string, boolean | string | number> = {};
  // Match `key: value,` pairs where value is a string / boolean / number
  // literal. Trailing comma optional (last entry). Comments are ignored
  // because they never match the `key: literal` shape.
  const pairRe =
    /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*(true|false|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(body)) !== null) {
    const key = m[1];
    const raw = m[2];
    let value: boolean | string | number;
    if (raw === "true") value = true;
    else if (raw === "false") value = false;
    else if (/^-?\d/.test(raw)) value = Number(raw);
    else value = raw.slice(1, -1); // strip surrounding quotes
    declared[key] = value;
  }
  return declared;
}

describe("every in-tree channel plugin declares typing/threads/buttons explicitly", () => {
  it("walks all 11 plugins and finds typing/threads/buttons as own-properties (not schema defaults)", () => {
    // Sanity: the matrix walks exactly the 11 in-tree plugins.
    expect(EXPECTED).toHaveLength(11);

    const missing: string[] = [];
    for (const { dir } of EXPECTED) {
      const features = readDeclaredFeatures(dir);
      for (const field of REQUIRED_FIELDS) {
        // The explicitness assertion: the field must be an OWN property of the
        // declared literal. If the plugin omits it (relying on the
        // `.default(false)` / `.default("none")` schema default), this is false.
        if (!Object.prototype.hasOwnProperty.call(features, field)) {
          missing.push(`${dir}-plugin.ts is missing explicit '${field}'`);
        }
      }
    }
    expect(
      missing,
      `Plugins must declare typing/threads/buttons explicitly, not rely on the schema default:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it.each(EXPECTED)(
    "$dir plugin declares the expected typing/threads/buttons values explicitly",
    ({ dir, typing, threads, buttons }) => {
      const features = readDeclaredFeatures(dir);

      // Own-property (declared, not defaulted) for each of the three fields.
      expect(Object.prototype.hasOwnProperty.call(features, "typing")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(features, "threads")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(features, "buttons")).toBe(true);

      // Values match the pinned ground truth for this channel.
      expect(features.typing).toBe(typing);
      expect(features.threads).toBe(threads);
      expect(features.buttons).toBe(buttons);
    },
  );
});
