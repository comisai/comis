// SPDX-License-Identifier: Apache-2.0
/**
 * Theme registry — a name→bundle lookup over the four
 * bundled activity themes.
 *
 * Mirrors the verified module-level-registry idiom (`core/tool-metadata.ts`):
 * a static, closed lookup that returns a known bundle (never `{}`). The four
 * bundles are a CLOSED set, so this uses a static `Record<ThemeName,
 * ActivityTheme>` rather than a mutable `Map` — there is no runtime
 * registration. Pure data; no logger, no I/O, no channel coupling.
 *
 * The `ThemeName` union is derived LOCALLY from the four literals. The
 * authoritative source of these literals is `ActivityConfigSchema.theme`
 * (`config/schema-agent/schema-agent-runtime.ts`); the keys here MUST match
 * those four literals exactly. We do not import that schema (it is a Zod
 * enum, not a type source) — the lookup below is type-checked against this
 * union, so a drift between the two surfaces as a compile error in the
 * `THEMES` record literal.
 *
 * @module
 */
import type { ActivityTheme } from "../label-spec.js";
import { asciiTheme } from "./ascii.js";
import { defaultTheme } from "./default.js";
import { playfulTheme } from "./playful.js";
import { terminalMinimalTheme } from "./terminal-minimal.js";

/**
 * The four bundled activity theme names. Matches
 * `ActivityConfigSchema.theme` exactly.
 */
export type ThemeName = "default" | "terminal-minimal" | "playful" | "ascii";

/**
 * Static lookup of the four bundled themes. `satisfies` pins that every
 * `ThemeName` literal has a bundle (and only those) — a missing or extra key
 * is a compile error.
 */
const THEMES = {
  default: defaultTheme,
  "terminal-minimal": terminalMinimalTheme,
  playful: playfulTheme,
  ascii: asciiTheme,
} satisfies Record<ThemeName, ActivityTheme>;

/**
 * Resolve a bundled {@link ActivityTheme} by name. The four `ThemeName`
 * literals always resolve to a bundle (never `undefined`). Uses an
 * own-property guard mirroring `label-spec.ts` `lookup()` to keep the access
 * free of an object-injection sink, even though `name` is a closed union.
 */
export function themeForName(name: ThemeName): ActivityTheme {
  if (!Object.prototype.hasOwnProperty.call(THEMES, name)) {
    // Unreachable for a well-typed `ThemeName`; defaultTheme is the safe floor.
    return defaultTheme;
  }
  return Object.entries(THEMES).find(([key]) => key === name)?.[1] ?? defaultTheme;
}
