// SPDX-License-Identifier: Apache-2.0
/**
 * Bundled-corpus spec-conformance gate — every SKILL.md the platform bundles
 * and seeds must carry ONLY the community-spec six top-level frontmatter fields
 * (name, description, license, compatibility, metadata, allowed-tools). A
 * bundled manifest with any other top-level key (a stray `type`, a top-level
 * `version`, or a smuggled extension) both fails the community allowed-set rule
 * and teaches every author who copies it the wrong shape. This test fails the
 * build on any such drift.
 *
 * The allowed-set rule is IMPORTED from the shipped package
 * (`SPEC_PURE_TOP_LEVEL_FIELDS` from `@comis/skills`), never hardcoded here — a
 * duplicated field list would reintroduce the very drift it exists to prevent.
 * Same fs-read-of-source + `@comis/skills`-dist discipline as
 * `autonomy-skill-no-drift.test.ts`; same corpus-walk + `formatViolations`
 * citation shape as `no-backward-compat.test.ts`.
 *
 * RED-provable: on a corpus where a bundled skill still carries a top-level
 * `type`/`version`, the scan reports a violation and the assertion fails. A
 * non-vacuity guard fails the suite if the walk finds fewer SKILL.md files than
 * the platform bundles, so an empty or mis-resolved walk cannot pass silently.
 *
 * The gate also parses the spec's minimal and optional-fields example manifests
 * through the shipped `parseSkillManifest`, proving the six-field authored form
 * (with `allowed-tools`, `compatibility`, and `metadata.version`) loads.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSpecPureFrontmatter,
  SPEC_PURE_TOP_LEVEL_FIELDS,
  parseSkillManifest,
} from "@comis/skills";
import {
  formatViolations,
  type ViolationCitation,
} from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const BUNDLED_ROOT = resolve(REPO_ROOT, "packages/daemon/bundled-skills");

/** The allowed top-level keys, as a runtime Set (rule imported, never hardcoded). */
const ALLOWED_TOP_LEVEL: ReadonlySet<string> = new Set<string>(
  SPEC_PURE_TOP_LEVEL_FIELDS,
);

/** Every `<name>/SKILL.md` under the bundled-skills root. */
function listBundledSkillFiles(): readonly { name: string; path: string }[] {
  return readdirSync(BUNDLED_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: resolve(BUNDLED_ROOT, e.name, "SKILL.md") }))
    .filter((s) => existsSync(s.path));
}

/**
 * The unindented (column-0) keys of a file's leading frontmatter block. An
 * indented `  version:` under a `metadata:` block is correctly NOT a top-level
 * key; a column-0 `version:` or `type:` is.
 */
function topLevelFrontmatterKeys(content: string): string[] {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return [];
  const keys: string[] = [];
  for (const line of block[1].split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe("every bundled SKILL.md uses only the spec's six top-level fields", () => {
  const files = listBundledSkillFiles();

  it("scans the whole bundled corpus (non-vacuous)", () => {
    expect(
      files.length,
      "the bundled-skills walk found too few SKILL.md files — an empty or mis-resolved corpus must not pass",
    ).toBeGreaterThanOrEqual(5);
  });

  it("carries no top-level frontmatter key outside the community allowed set", () => {
    const violations: ViolationCitation[] = [];
    for (const { name, path } of files) {
      const content = readFileSync(path, "utf8");
      const topLevelKeys = topLevelFrontmatterKeys(content);
      // Verdict from the shipped predicate, driven with the file's actual
      // top-level keys; the offending-key list drives the citation.
      const keyObject = Object.fromEntries(topLevelKeys.map((k) => [k, null]));
      const offending = [...new Set(topLevelKeys)].filter(
        (key) => !ALLOWED_TOP_LEVEL.has(key),
      );
      if (!isSpecPureFrontmatter(keyObject)) {
        violations.push({
          file: `packages/daemon/bundled-skills/${name}/SKILL.md`,
          line: 0,
          snippet: `non-spec top-level key(s): ${offending.join(", ")}`,
        });
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "Bundled SKILL.md frontmatter must carry only the community-spec top-level fields; every extension rides under metadata.comis and version under metadata.version.",
        violations,
        suggestedFix:
          "Drop the top-level `type:` line and move `version:` under a `metadata:` block as `metadata.version`. Keep only: " +
          SPEC_PURE_TOP_LEVEL_FIELDS.join(", ") +
          ".",
        designRef:
          "the shared skill-manifest allowed-set rule (SPEC_PURE_TOP_LEVEL_FIELDS, @comis/skills)",
      }),
    ).toEqual([]);
  });

  it("parses the spec's minimal and optional-fields example manifests verbatim", () => {
    const minimal = [
      "---",
      "name: example-minimal",
      "description: A minimal spec-pure skill manifest with only the required fields.",
      "---",
      "",
      "# Example",
      "",
      "Body content.",
      "",
    ].join("\n");
    const optional = [
      "---",
      "name: example-optional",
      "description: A spec-pure skill manifest exercising the optional top-level fields.",
      "license: Apache-2.0",
      "compatibility: Runs wherever the platform runs.",
      "allowed-tools: read web_search",
      "metadata:",
      '  version: "1.0.0"',
      "---",
      "",
      "# Example",
      "",
      "Body content.",
      "",
    ].join("\n");

    const minimalResult = parseSkillManifest(minimal);
    const optionalResult = parseSkillManifest(optional);

    expect(
      minimalResult.ok,
      minimalResult.ok
        ? ""
        : `minimal example must parse: ${minimalResult.error.message}`,
    ).toBe(true);
    expect(
      optionalResult.ok,
      optionalResult.ok
        ? ""
        : `optional-fields example must parse: ${optionalResult.error.message}`,
    ).toBe(true);
  });
});
