// SPDX-License-Identifier: Apache-2.0
/**
 * Spec for the foreign-frontmatter mapper (WS-V3).
 *
 * Pre-patch state: `./frontmatter-map.js` does not exist.
 *
 * Why this module exists: `SkillManifestSchema` is a `z.strictObject`
 * (`../manifest/schema.ts:168`), so an unknown key is a PARSE FAILURE. The
 * community convention Comis's format is shaped after spells its keys in
 * kebab-case (`allowed-tools`, `argument-hint`). Without this mapper, the
 * vetting gate's "a parse failure is a block" rule would newly reject a large
 * class of perfectly benign skills — which is why the two must ship together.
 *
 * Contract: map what is semantically equivalent, DROP the rest with a named
 * warning, and never reinterpret. Silence is the failure mode to avoid.
 */
import { describe, it, expect } from "vitest";
import { mapForeignFrontmatter } from "./frontmatter-map.js";
import { SkillManifestSchema } from "../manifest/schema.js";

function mapAndParse(fm: Record<string, unknown>) {
  const { frontmatter, warnings } = mapForeignFrontmatter(fm);
  return { parsed: SkillManifestSchema.safeParse(frontmatter), warnings, frontmatter };
}

describe("frontmatter-map — bare convention fields", () => {
  it("passes a minimal name+description manifest through unchanged", () => {
    const { parsed, warnings } = mapAndParse({ name: "my-skill", description: "Does a thing." });
    expect(parsed.success).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("leaves Comis-native camelCase keys untouched", () => {
    const { parsed, warnings } = mapAndParse({
      name: "my-skill",
      description: "d",
      allowedTools: ["read"],
      argumentHint: "[path]",
      userInvocable: false,
      disableModelInvocation: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.allowedTools).toEqual(["read"]);
      expect(parsed.data.userInvocable).toBe(false);
    }
    expect(warnings).toEqual([]);
  });
});

describe("frontmatter-map — kebab-case variants (the reason this exists)", () => {
  it("maps allowed-tools → allowedTools instead of failing the strict parse", () => {
    // Proof of the gap: the RAW frontmatter fails; the MAPPED one succeeds.
    const raw = { name: "my-skill", description: "d", "allowed-tools": ["read", "write"] };
    expect(SkillManifestSchema.safeParse(raw).success).toBe(false);

    const { parsed } = mapAndParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.allowedTools).toEqual(["read", "write"]);
  });

  it.each([
    ["argument-hint", "argumentHint", "[path]"],
    ["user-invocable", "userInvocable", false],
    ["disable-model-invocation", "disableModelInvocation", true],
  ])("maps %s → %s", (kebab, camel, value) => {
    const { parsed, frontmatter } = mapAndParse({ name: "s", description: "d", [kebab]: value });
    expect(parsed.success).toBe(true);
    expect(frontmatter[camel]).toEqual(value);
    expect(frontmatter[kebab]).toBeUndefined();
  });

  it("prefers the camelCase key and warns when BOTH spellings are present", () => {
    // Silent last-write-wins on a security-relevant field is the ambiguity to avoid.
    const { parsed, warnings } = mapAndParse({
      name: "s",
      description: "d",
      allowedTools: ["read"],
      "allowed-tools": ["read", "write", "exec"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.allowedTools).toEqual(["read"]);
    expect(warnings).toEqual([expect.objectContaining({ key: "allowed-tools", action: "duplicate_key" })]);
  });
});

describe("frontmatter-map — host namespaces", () => {
  it("maps an equivalent OS constraint into comis.os", () => {
    const { parsed, frontmatter } = mapAndParse({
      name: "s",
      description: "d",
      metadata: { hostRuntime: { os: "Linux" } },
    });
    expect(parsed.success).toBe(true);
    const comis = frontmatter["comis"] as Record<string, unknown> | undefined;
    expect(comis?.["os"]).toEqual(["linux"]); // lowercased by OsFieldSchema's preprocess
  });

  it("maps an equivalent bin/env prerequisite into comis.requires", () => {
    const { parsed, frontmatter } = mapAndParse({
      name: "s",
      description: "d",
      metadata: { hostRuntime: { requires: { bins: ["ffmpeg"], env: ["API_BASE"] } } },
    });
    expect(parsed.success).toBe(true);
    const comis = frontmatter["comis"] as Record<string, unknown> | undefined;
    expect(comis?.["requires"]).toEqual({ bins: ["ffmpeg"], env: ["API_BASE"] });
  });

  it("does not clobber an author's own comis: block when merging", () => {
    const { frontmatter } = mapAndParse({
      name: "s",
      description: "d",
      comis: { "primary-env": "discord" },
      metadata: { hostRuntime: { os: "linux" } },
    });
    const comis = frontmatter["comis"] as Record<string, unknown>;
    expect(comis["primary-env"]).toBe("discord");
    expect(comis["os"]).toEqual(["linux"]);
  });
});

describe("frontmatter-map — drop, never reinterpret", () => {
  it("drops an unmappable vendor key with a named warning", () => {
    const { parsed, frontmatter, warnings } = mapAndParse({
      name: "s",
      description: "d",
      "x-vendor-routing-policy": { queue: "priority" },
    });
    expect(parsed.success).toBe(true);
    expect(frontmatter["x-vendor-routing-policy"]).toBeUndefined();
    expect(warnings).toEqual([
      expect.objectContaining({ key: "x-vendor-routing-policy", action: "dropped_unmappable" }),
    ]);
  });

  it("does NOT park a dropped key in metadata", () => {
    // `metadata` is Record<string,string>; parking an object there would
    // coerce-or-fail unpredictably and hide the drop from the operator.
    const { frontmatter } = mapAndParse({
      name: "s",
      description: "d",
      "x-vendor-thing": { nested: true },
    });
    const metadata = frontmatter["metadata"] as Record<string, unknown> | undefined;
    expect(metadata?.["x-vendor-thing"]).toBeUndefined();
  });

  it.each([
    ["entrypoint", "main.py"],
    ["run", "python main.py"],
    ["postInstall", "./setup.sh"],
    ["scripts", { install: "npm i" }],
  ])("drops the code-execution key %s with a dropped_executable warning (INV-V4)", (key, value) => {
    const { parsed, frontmatter, warnings } = mapAndParse({ name: "s", description: "d", [key]: value });
    expect(parsed.success).toBe(true);
    expect(frontmatter[key]).toBeUndefined();
    expect(warnings).toEqual([expect.objectContaining({ key, action: "dropped_executable" })]);
  });

  it("names every dropped key so the warning is actionable", () => {
    const { warnings } = mapAndParse({
      name: "s",
      description: "d",
      entrypoint: "main.py",
      "x-vendor-a": 1,
      "x-vendor-b": 2,
    });
    expect(warnings.map((w) => w.key).sort()).toEqual(["entrypoint", "x-vendor-a", "x-vendor-b"]);
  });

  it("carries no VALUES in the warnings — keys and actions only (INV-V5)", () => {
    const { warnings } = mapAndParse({
      name: "s",
      description: "d",
      "x-vendor-secret": "sk-live-do-not-log-this",
    });
    expect(JSON.stringify(warnings)).not.toContain("sk-live-do-not-log-this");
    expect(Object.keys(warnings[0]!).sort()).toEqual(["action", "key"]);
  });
});

describe("frontmatter-map — mcpServers passes through the existing schema", () => {
  it("accepts the Comis-native array form unchanged", () => {
    const { parsed } = mapAndParse({
      name: "s",
      description: "d",
      mcpServers: [{ name: "yf", transport: "stdio", command: "uvx", args: ["yfmcp"] }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mcpServers?.[0]?.name).toBe("yf");
  });

  it("accepts the nested-object form via McpServersBundleSchema's preprocess", () => {
    const { parsed } = mapAndParse({
      name: "s",
      description: "d",
      mcpServers: { yf: { transport: "stdio", command: "uvx", args: ["yfmcp"] } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mcpServers?.[0]?.name).toBe("yf");
  });
});

describe("frontmatter-map — purity", () => {
  it("does not mutate the input frontmatter", () => {
    const input = { name: "s", description: "d", "allowed-tools": ["read"], entrypoint: "main.py" };
    const snapshot = JSON.stringify(input);
    mapForeignFrontmatter(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is deterministic, including warning order", () => {
    const input = { name: "s", description: "d", "x-b": 1, "x-a": 2, entrypoint: "m.py" };
    expect(mapForeignFrontmatter(input)).toEqual(mapForeignFrontmatter(input));
  });
});
