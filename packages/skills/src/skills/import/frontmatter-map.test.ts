// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior + boundary tests for the foreign-frontmatter mapper.
 *
 * The mapper is the format-compatibility gate: it turns a spec-conforming,
 * another-ecosystem, or nested-metadata manifest into the spec-pure carrier the
 * shipped parser validates, WITHOUT ever silently reinterpreting a field. The
 * pre-patch proof is that every fixture is REJECTED when fed straight to
 * `parseSkillManifest` (the strict internal schema is `z.strictObject`); the
 * mapper converges each onto a valid manifest and every dropped field carries a
 * warning naming the key. Executable entrypoints are never mapped (prompt-only
 * import).
 */
import { describe, it, expect } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import type { SkillManifestParsed } from "../manifest/schema.js";
import { parseFrontmatter, parseSkillManifest } from "../manifest/parser.js";
import { mapForeignFrontmatter, type MapWarning } from "./frontmatter-map.js";
import { FOREIGN_FIXTURES } from "./test-fixtures/foreign-frontmatter.js";
import {
  FIXTURE_A_SPEC_CONFORMING,
  FIXTURE_B_SIBLING_NAMESPACE,
  FIXTURE_C_OTHER_HUB_WITH_ENTRYPOINT,
  FIXTURE_D_NESTED_METADATA_VALUE,
  FIXTURE_E_DISPLAY_NAME,
} from "./test-fixtures/foreign-frontmatter.js";

/** Extract the raw YAML frontmatter object from a SKILL.md fixture string. */
function rawFrontmatter(skillMd: string): Record<string, unknown> {
  const parsed = parseFrontmatter<Record<string, unknown>>(skillMd);
  if (!parsed.ok) throw new Error(`fixture frontmatter did not parse: ${parsed.error.message}`);
  return parsed.value.frontmatter;
}

/** Serialize a spec-pure frontmatter object back into a SKILL.md string. */
function toSkillMd(specPure: Record<string, unknown>): string {
  return `---\n${stringifyYaml(specPure)}---\nSkill body instructions.\n`;
}

/** Map a fixture, then validate the emitted spec-pure carrier via the parser. */
function mapAndValidate(skillMd: string): {
  specPure: Record<string, unknown>;
  warnings: MapWarning[];
  manifest: SkillManifestParsed;
} {
  const { specPure, warnings } = mapForeignFrontmatter(rawFrontmatter(skillMd));
  const result = parseSkillManifest(toSkillMd(specPure));
  if (!result.ok) throw new Error(`mapped manifest did not validate: ${result.error.message}`);
  return { specPure, warnings, manifest: result.value };
}

/** True iff some warning names the given key (message, hint, or the key field). */
function warnsFor(warnings: readonly MapWarning[], key: string): boolean {
  return warnings.some(
    (w) => w.key === key || w.hint.includes(key) || w.message.includes(key),
  );
}

describe("the strict schema rejects every foreign fixture raw (the mapper is mandatory)", () => {
  for (const [label, fixture] of Object.entries(FOREIGN_FIXTURES)) {
    it(`rejects the raw ${label} fixture before mapping`, () => {
      const result = parseSkillManifest(fixture);
      expect(result.ok).toBe(false);
    });
  }
});

describe("(a) a spec-conforming manifest with a non-string metadata value", () => {
  it("fails raw but maps to a valid manifest with allowed-tools split and compatibility first-class", () => {
    // Pre-patch proof: the numeric metadata value rejects under record(string,string).
    expect(parseSkillManifest(FIXTURE_A_SPEC_CONFORMING).ok).toBe(false);

    const { manifest } = mapAndValidate(FIXTURE_A_SPEC_CONFORMING);
    expect(manifest.name).toBe("pdf-extractor");
    expect(manifest.allowedTools).toEqual(["Read", "Write", "Bash"]);
    expect(manifest.compatibility).toContain("poppler");
    // The scalar metadata value is flattened to a string, not dropped.
    expect(manifest.metadata?.["api_version"]).toBe("2");
    expect(manifest.metadata?.["category"]).toBe("document-processing");
  });
});

describe("(b) a sibling metadata.openclaw namespace folds into the comis block", () => {
  it("maps skillKey/primaryEnv/os/requires and drops the unmappable keys with a warning naming each", () => {
    const { manifest, warnings } = mapAndValidate(FIXTURE_B_SIBLING_NAMESPACE);

    expect(manifest.comis?.["skill-key"]).toBe("repo-inspector");
    expect(manifest.comis?.["primary-env"]).toBe("cli");
    expect(manifest.comis?.os).toEqual(["linux", "darwin"]);
    expect(manifest.comis?.requires?.bins).toEqual(["git", "jq"]);
    expect(manifest.comis?.requires?.env).toEqual(["GITHUB_TOKEN"]);

    // The checksum-less binary-installer array MUST drop with a warning naming it.
    expect(warnsFor(warnings, "install")).toBe(true);
    // ...as must the other extension keys with no internal semantics.
    expect(warnsFor(warnings, "anyBins")).toBe(true);
    expect(warnsFor(warnings, "config")).toBe(true);
    expect(warnsFor(warnings, "always")).toBe(true);
    expect(warnsFor(warnings, "emoji")).toBe(true);
    expect(warnsFor(warnings, "homepage")).toBe(true);
  });
});

describe("(c) another ecosystem's top-level fields + nested hub dict + executable entrypoint", () => {
  it("imports prompt-only: platforms -> comis.os, version/author -> metadata, dict + entrypoint drop-with-warning", () => {
    const { specPure, manifest, warnings } = mapAndValidate(FIXTURE_C_OTHER_HUB_WITH_ENTRYPOINT);

    expect(manifest.name).toBe("sentiment-scan");
    expect(manifest.comis?.os).toEqual(["linux", "macos"]);
    expect(manifest.version).toBe("0.3.1");
    expect(manifest.metadata?.["author"]).toBe("Data Tools Collective");

    // The nested community-hub dict has no internal semantics -> drops-with-warning.
    expect(warnsFor(warnings, "superhub")).toBe(true);
    // The executable entrypoint fires a drop warning and is NEVER mapped.
    expect(warnsFor(warnings, "entrypoint")).toBe(true);
    expect(specPure).not.toHaveProperty("entrypoint");
  });
});

describe("(d) a nested-object metadata value drops-with-warning (never crashes)", () => {
  it("drops the nested value naming the key while keeping the sibling string entry", () => {
    const { manifest, warnings } = mapAndValidate(FIXTURE_D_NESTED_METADATA_VALUE);

    expect(manifest.name).toBe("cache-warmer");
    expect(manifest.metadata?.["category"]).toBe("performance");
    expect(manifest.metadata?.["config"]).toBeUndefined();
    expect(warnsFor(warnings, "config")).toBe(true);
  });
});

describe("(e) a display-form name normalizes to a valid manifest slug", () => {
  it("normalizes the authored name to the manifest slug (independent of any directory) and names the change", () => {
    const { manifest, warnings } = mapAndValidate(FIXTURE_E_DISPLAY_NAME);

    expect(manifest.name).toBe("log-analyzer");
    // The normalization is not silent: a warning names the field.
    expect(warnsFor(warnings, "name")).toBe(true);
  });
});

describe("invariants across every mapping", () => {
  it("every warning is an actionable config-class warning with a non-empty hint", () => {
    for (const fixture of Object.values(FOREIGN_FIXTURES)) {
      const { warnings } = mapForeignFrontmatter(rawFrontmatter(fixture));
      for (const w of warnings) {
        expect(w.errorKind).toBe("config");
        expect(w.hint.length).toBeGreaterThan(0);
        expect(w.key.length).toBeGreaterThan(0);
      }
    }
  });

  it("never emits an executable entrypoint field into the spec-pure output", () => {
    const execKeys = ["entrypoint", "main", "exec", "run", "scripts", "command", "bin", "binary", "executable"];
    for (const fixture of Object.values(FOREIGN_FIXTURES)) {
      const { specPure } = mapForeignFrontmatter(rawFrontmatter(fixture));
      for (const k of execKeys) {
        expect(specPure).not.toHaveProperty(k);
      }
    }
  });

  it("is a pure function — the same input yields deep-equal output", () => {
    const raw = rawFrontmatter(FIXTURE_B_SIBLING_NAMESPACE);
    const first = mapForeignFrontmatter(raw);
    const second = mapForeignFrontmatter(raw);
    expect(first.specPure).toEqual(second.specPure);
    expect(first.warnings).toEqual(second.warnings);
  });
});
