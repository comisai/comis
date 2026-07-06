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

describe("the full disposition table — every branch, named", () => {
  it("passes a non-string name through for the schema to report (no crash)", () => {
    const { specPure, warnings } = mapForeignFrontmatter({ name: 42, description: "d" });
    expect(specPure["name"]).toBe(42);
    expect(warnsFor(warnings, "name")).toBe(false);
  });

  it("keeps an already-valid slug name untouched", () => {
    const { specPure, warnings } = mapForeignFrontmatter({ name: "already-valid", description: "d" });
    expect(specPure["name"]).toBe("already-valid");
    expect(warnsFor(warnings, "name")).toBe(false);
  });

  it("falls back to the original name when a slug cannot be derived", () => {
    const { specPure, warnings } = mapForeignFrontmatter({ name: "!!!", description: "d" });
    expect(specPure["name"]).toBe("!!!");
    expect(warnsFor(warnings, "name")).toBe(true);
  });

  it("joins an array allowed-tools into the canonical space string", () => {
    const { specPure } = mapForeignFrontmatter({ name: "n", "allowed-tools": ["Read", "Write", 5] });
    expect(specPure["allowed-tools"]).toBe("Read Write");
  });

  it("drops a non-string, non-array allowed-tools with a warning", () => {
    const { specPure, warnings } = mapForeignFrontmatter({ name: "n", "allowed-tools": 5 });
    expect(specPure).not.toHaveProperty("allowed-tools");
    expect(warnsFor(warnings, "allowed-tools")).toBe(true);
  });

  it("refuses an all-non-string allowed-tools list rather than coercing it to a no-restriction empty string", () => {
    // An empty internal allowedTools means "no restriction"; coercing a list
    // with no string members to "" would fail OPEN on the tool-restriction
    // boundary and defeat the manifest lift's fail-closed guard. The mapper must
    // preserve the type signal so the lift rejects it.
    const md = toSkillMd(
      mapForeignFrontmatter({ name: "n", description: "d", "allowed-tools": [1, 2, 3] }).specPure,
    );
    expect(parseSkillManifest(md).ok).toBe(false);
  });

  it("warns and does not emit an empty allowed-tools string for a no-string list", () => {
    const { specPure, warnings } = mapForeignFrontmatter({ name: "n", "allowed-tools": [1, 2] });
    expect(specPure["allowed-tools"]).not.toBe("");
    expect(warnsFor(warnings, "allowed-tools")).toBe(true);
  });

  it("warns when non-string entries are dropped from a mixed allowed-tools list", () => {
    const { specPure, warnings } = mapForeignFrontmatter({ name: "n", "allowed-tools": ["Read", 5, "Write"] });
    expect(specPure["allowed-tools"]).toBe("Read Write");
    expect(warnsFor(warnings, "allowed-tools")).toBe(true);
  });

  it("warns when the compatibility prose is over the advisory length", () => {
    const { warnings } = mapForeignFrontmatter({ name: "n", compatibility: "x".repeat(501) });
    expect(warnsFor(warnings, "compatibility")).toBe(true);
  });

  it("drops a metadata block that is not a map", () => {
    const { warnings } = mapForeignFrontmatter({ name: "n", metadata: "not-a-map" });
    expect(warnsFor(warnings, "metadata")).toBe(true);
  });

  it("preserves an already-spec-pure metadata.comis carrier string", () => {
    const carrier = '{"userInvocable":false}';
    const { specPure } = mapForeignFrontmatter({ name: "n", metadata: { comis: carrier } });
    expect((specPure["metadata"] as Record<string, unknown>)["comis"]).toBe(carrier);
  });

  it("flattens a boolean metadata value and drops a null / array value with a warning", () => {
    const { specPure, warnings } = mapForeignFrontmatter({
      name: "n",
      metadata: { flag: true, empty: null, tags: ["a", "b"] },
    });
    expect((specPure["metadata"] as Record<string, unknown>)["flag"]).toBe("true");
    expect(warnsFor(warnings, "metadata.empty")).toBe(true);
    expect(warnsFor(warnings, "metadata.tags")).toBe(true);
  });

  it("drops a non-list platforms with a warning", () => {
    const { warnings } = mapForeignFrontmatter({ name: "n", platforms: 5 });
    expect(warnsFor(warnings, "platforms")).toBe(true);
  });

  it("flattens a scalar version and drops a non-scalar version/author with a warning", () => {
    const flattened = mapForeignFrontmatter({ name: "n", version: 2 });
    expect((flattened.specPure["metadata"] as Record<string, unknown>)["version"]).toBe("2");

    const dropped = mapForeignFrontmatter({ name: "n", version: {}, author: [] });
    expect(warnsFor(dropped.warnings, "version")).toBe(true);
    expect(warnsFor(dropped.warnings, "author")).toBe(true);
  });

  it("maps prerequisites.commands/env_vars into comis requires and drops the rest", () => {
    const { manifest } = mapAndValidate(
      toSkillMd(
        mapForeignFrontmatter({
          name: "prereq-demo",
          description: "d",
          prerequisites: { commands: ["git"], env_vars: ["TOKEN"], nope: 1 },
        }).specPure,
      ),
    );
    expect(manifest.comis?.requires?.bins).toEqual(["git"]);
    expect(manifest.comis?.requires?.env).toEqual(["TOKEN"]);
  });

  it("warns on an unmapped prerequisites key and on a non-object prerequisites", () => {
    const partial = mapForeignFrontmatter({ name: "n", prerequisites: { commands: ["git"], nope: 1 } });
    expect(warnsFor(partial.warnings, "prerequisites.nope")).toBe(true);

    const whole = mapForeignFrontmatter({ name: "n", prerequisites: "not-an-object" });
    expect(warnsFor(whole.warnings, "prerequisites")).toBe(true);
  });

  it("merges prerequisites and sibling-namespace requires (deduped)", () => {
    const { specPure } = mapForeignFrontmatter({
      name: "n",
      prerequisites: { commands: ["git"] },
      metadata: { openclaw: { requires: { bins: ["git", "jq"] } } },
    });
    const carrier = JSON.parse((specPure["metadata"] as Record<string, string>)["comis"]) as {
      comis: { requires: { bins: string[] } };
    };
    expect(carrier.comis.requires.bins).toEqual(["git", "jq"]);
  });

  it("silently drops type:prompt but warns on a non-prompt type", () => {
    const promptType = mapForeignFrontmatter({ name: "n", type: "prompt" });
    expect(promptType.specPure).not.toHaveProperty("type");
    expect(warnsFor(promptType.warnings, "type")).toBe(false);

    const scriptType = mapForeignFrontmatter({ name: "n", type: "python" });
    expect(scriptType.specPure).not.toHaveProperty("type");
    expect(warnsFor(scriptType.warnings, "type")).toBe(true);
  });

  it("drops every executable entrypoint key with a warning, never mapping it", () => {
    const { specPure, warnings } = mapForeignFrontmatter({
      name: "n",
      main: "m.py",
      exec: "e",
      run: "r",
      scripts: { build: "b" },
      command: "c",
      bin: "x",
      binary: "y",
      executable: "z",
    });
    for (const k of ["main", "exec", "run", "scripts", "command", "bin", "binary", "executable"]) {
      expect(specPure).not.toHaveProperty(k);
      expect(warnsFor(warnings, k)).toBe(true);
    }
  });

  it("passes legacy pre-migration Comis top-level fields through untouched", () => {
    const { specPure } = mapForeignFrontmatter({
      name: "n",
      userInvocable: false,
      allowedTools: ["Read"],
      mcpServers: [{ name: "srv", transport: "stdio" }],
    });
    expect(specPure["userInvocable"]).toBe(false);
    expect(specPure["allowedTools"]).toEqual(["Read"]);
    expect(specPure["mcpServers"]).toEqual([{ name: "srv", transport: "stdio" }]);
  });

  it("warns that an imported skill's permissions and inputSchema are accepted but not authoritative", () => {
    // permissions/inputSchema are validated by the strict schema but NEVER
    // projected into the runtime prompt-skill descriptor and read by no runtime
    // path — they are inert for the imported tier. They still pass through (the
    // lift converts them), but the operator must be warned they grant nothing,
    // so an untrusted author cannot imply a runtime effect that does not exist.
    const { specPure, warnings } = mapForeignFrontmatter({
      name: "n",
      description: "d",
      permissions: { network: ["example.com"] },
      inputSchema: { type: "object" },
    });
    expect(specPure["permissions"]).toEqual({ network: ["example.com"] });
    expect(specPure["inputSchema"]).toEqual({ type: "object" });
    expect(warnsFor(warnings, "permissions")).toBe(true);
    expect(warnsFor(warnings, "inputSchema")).toBe(true);
  });

  it("drops an unknown top-level field with a key-naming warning", () => {
    const { specPure, warnings } = mapForeignFrontmatter({ name: "n", weirdField: 1 });
    expect(specPure).not.toHaveProperty("weirdField");
    expect(warnsFor(warnings, "weirdField")).toBe(true);
  });

  it("refuses a __proto__ frontmatter key and never carries it onto the output", () => {
    const raw = JSON.parse('{"name":"n","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const { specPure, warnings } = mapForeignFrontmatter(raw);
    expect(warnsFor(warnings, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(specPure, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("accepts the sibling namespace as a JSON string and drops a non-parseable one", () => {
    const asString = mapForeignFrontmatter({
      name: "n",
      metadata: { openclaw: '{"skillKey":"foo","os":"linux"}' },
    });
    const carrier = JSON.parse((asString.specPure["metadata"] as Record<string, string>)["comis"]) as {
      comis: { "skill-key": string; os: string[] };
    };
    expect(carrier.comis["skill-key"]).toBe("foo");
    expect(carrier.comis.os).toEqual(["linux"]);

    const bad = mapForeignFrontmatter({ name: "n", metadata: { openclaw: "{not json" } });
    expect(warnsFor(bad.warnings, "metadata.openclaw")).toBe(true);

    const scalar = mapForeignFrontmatter({ name: "n", metadata: { openclaw: 5 } });
    expect(warnsFor(scalar.warnings, "metadata.openclaw")).toBe(true);
  });

  it("keeps the sibling-namespace WARN prose generic — the operator message names no reference project", () => {
    // The `key` field stays the real interop identifier for assertions/audit,
    // but the operator-facing message/hint prose (which the pipeline surfaces in
    // StagedImport.warnings) must state the mechanism generically.
    const notObject = mapForeignFrontmatter({ name: "n", metadata: { openclaw: 5 } });
    const nsWarn = notObject.warnings.find((w) => w.key === "metadata.openclaw");
    expect(nsWarn).toBeDefined();
    expect(nsWarn!.message).not.toContain("openclaw");
    expect(nsWarn!.hint).not.toContain("openclaw");

    const unmapped = mapForeignFrontmatter({ name: "n", metadata: { openclaw: { emoji: "MAG" } } });
    const keyWarn = unmapped.warnings.find((w) => w.key === "metadata.openclaw.emoji");
    expect(keyWarn).toBeDefined();
    expect(keyWarn!.message).not.toContain("openclaw");
  });

  it("drops a sibling-namespace requires that is not an object", () => {
    const { warnings } = mapForeignFrontmatter({
      name: "n",
      metadata: { openclaw: { requires: "not-an-object" } },
    });
    expect(warnsFor(warnings, "metadata.openclaw.requires")).toBe(true);
  });

  it("tolerates a non-array requires.bins/env (coerces to an empty list, no crash)", () => {
    const { specPure } = mapForeignFrontmatter({
      name: "n",
      metadata: { openclaw: { requires: { bins: 42, env: ["TOKEN"] } } },
    });
    const carrier = JSON.parse((specPure["metadata"] as Record<string, string>)["comis"]) as {
      comis: { requires: { bins: string[]; env: string[] } };
    };
    expect(carrier.comis.requires.bins).toEqual([]);
    expect(carrier.comis.requires.env).toEqual(["TOKEN"]);
  });
});
