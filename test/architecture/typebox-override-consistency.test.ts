// SPDX-License-Identifier: Apache-2.0
/**
 * Guards the forced `typebox` version against the version pi-ai was built for.
 *
 * `pnpm.overrides.typebox` forces ONE typebox across the whole workspace,
 * including the copy pi-ai resolves. pi-ai compiles tool-argument schemas with
 * it, so that single pin decides whether tool-call validation works — and
 * nothing else checks it. An override below what pi-ai declares installs a
 * validator pi never tested against, and pnpm reports nothing: the override is
 * doing exactly what it was told.
 *
 * The concrete failure this pin controls: on typebox 1.3.6, compiled validation
 * of a nullable array tool argument — `{ type: ["array", "null"] }`, the shape
 * MCP servers emit for an optional list — does not return `false` for `null`,
 * it throws `TypeError: Cannot read properties of null (reading 'every')`.
 * `HasTypeName` matched a multi-type schema if ANY member matched, so the
 * schema was treated as both `array` and `null` at once. typebox 1.3.7 requires
 * every member to match and validates the value correctly. A validator that
 * throws instead of rejecting escapes the `validation` error path entirely and
 * surfaces as an internal crash.
 *
 * Comis's own converter (`jsonSchemaToTypeBox`) expands a multi-type `type`
 * into a union, so tools bridged through it never reach that branch. This guard
 * covers the paths inside pi that receive raw JSON Schema, where Comis has no
 * converter in front of the validator.
 *
 * Two ways the pin drifts, both seen in this repo:
 *   - pi is upgraded and the override is left behind (pi-ai declared 1.3.7
 *     while the override still forced 1.3.6).
 *   - a workspace manifest keeps a stale literal pin that the override silently
 *     overrules (`typebox: 1.1.39` in two manifests while 1.3.6 was installed),
 *     so the manifest documents a version that never runs.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly pnpm?: { readonly overrides?: Record<string, string> };
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** The version pi-ai itself declares — ground truth, never a hard-coded copy. */
function piAiDeclaredTypebox(): string | undefined {
  const abs = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai", "package.json");
  return existsSync(abs) ? readJson(abs).dependencies?.typebox : undefined;
}

/** Every workspace manifest that pins `typebox` literally. */
function workspaceTypeboxPins(): { file: string; pin: string }[] {
  const out: { file: string; pin: string }[] = [];
  for (const pkg of readdirSync(join(REPO_ROOT, "packages")).sort()) {
    const file = join("packages", pkg, "package.json");
    const abs = join(REPO_ROOT, file);
    if (!existsSync(abs)) {
      continue;
    }
    const pin = readJson(abs).dependencies?.typebox;
    if (pin !== undefined && !pin.startsWith("workspace:")) {
      out.push({ file, pin });
    }
  }
  return out;
}

describe("typebox override consistency", () => {
  it("forces a typebox at least as new as the version pi-ai declares", () => {
    const forced = readJson(join(REPO_ROOT, "package.json")).pnpm?.overrides?.typebox;
    const declared = piAiDeclaredTypebox();
    const violations: ViolationCitation[] = [];

    // Both sides must be present for the comparison to mean anything. A missing
    // override or an uninstalled pi-ai is a real finding, not a skip.
    if (forced === undefined) {
      violations.push({
        file: "package.json",
        line: 0,
        snippet: "pnpm.overrides.typebox is absent — nothing pins the typebox pi-ai compiles tool schemas with",
      });
    } else if (declared === undefined) {
      violations.push({
        file: "package.json",
        line: 0,
        snippet: "@earendil-works/pi-ai is not installed — cannot verify the forced typebox against it (run pnpm install)",
      });
    } else if (!semver.satisfies(forced, `>=${declared}`)) {
      violations.push({
        file: "package.json",
        line: 0,
        snippet: `pnpm.overrides.typebox forces ${forced}, below the ${declared} @earendil-works/pi-ai declares — pi compiles tool-argument schemas with the forced copy, and a nullable array argument throws instead of validating`,
      });
    }

    expect(
      violations,
      formatViolations({
        description: "The forced typebox is older than the version pi-ai was built against.",
        violations,
        suggestedFix:
          "Raise pnpm.overrides.typebox in the root package.json to the version @earendil-works/pi-ai declares, then pnpm install. Bump this override in the same change as every pi SDK upgrade — the override wins over pi's own dependency, so leaving it behind silently downgrades the validator pi uses for tool arguments.",
        designRef:
          "AGENTS.md 2.15 — dependency and supply-chain invariants: exact pins, and the version we force is the version that runs",
      }),
    ).toEqual([]);
  });

  it("keeps every workspace typebox pin equal to the forced override", () => {
    const forced = readJson(join(REPO_ROOT, "package.json")).pnpm?.overrides?.typebox;
    const violations: ViolationCitation[] = [];

    if (forced !== undefined) {
      for (const { file, pin } of workspaceTypeboxPins()) {
        if (pin !== forced) {
          violations.push({
            file,
            line: 0,
            snippet: `pins typebox ${pin} but pnpm.overrides.typebox forces ${forced} — this manifest documents a version that never runs`,
          });
        }
      }
    }

    expect(
      violations,
      formatViolations({
        description: "A workspace manifest pins a typebox version the root override overrules.",
        violations,
        suggestedFix:
          "Set the manifest's typebox pin to the same version as pnpm.overrides.typebox. A pin the override silently replaces is worse than no pin: it reports a version that is not installed, and the published manifest carries it to users of the umbrella package.",
        designRef:
          "AGENTS.md 2.15 — dependency and supply-chain invariants: every dependency is exact-pinned",
      }),
    ).toEqual([]);
  });
});
