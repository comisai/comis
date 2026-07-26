// SPDX-License-Identifier: Apache-2.0
/**
 * Spec for the structural rules (WS-V2).
 *
 * Pre-patch state: `./bundle-structure.js` does not exist.
 *
 * Structural rules catch what regexes cannot: a native payload, a symlink, a
 * traversal path, a bomb-shaped member count. They run FIRST so an oversized
 * bundle is rejected before any NFKC normalization or regex pass.
 *
 * Severity discipline (R1): only genuinely-unambiguous conditions are
 * CRITICAL. Size and count breaches are WARN — a legitimately large skill is
 * plausible, a Mach-O binary in a prompt skill is not.
 */
import { describe, it, expect } from "vitest";
import { checkBundleStructure, DEFAULT_BUNDLE_LIMITS } from "./bundle-structure.js";
import type { SkillBundleFile } from "./vet-bundle.js";

const SKILL_MD: SkillBundleFile = {
  path: "SKILL.md",
  content: "---\nname: s\ndescription: d\n---\n\nBody.\n",
};

function ids(files: readonly SkillBundleFile[], limits = {}): string[] {
  return checkBundleStructure({ files, limits }).map((f) => f.ruleId);
}

function severityOf(files: readonly SkillBundleFile[], ruleId: string): string | undefined {
  return checkBundleStructure({ files, limits: {} }).find((f) => f.ruleId === ruleId)?.severity;
}

describe("bundle structure — manifest presence", () => {
  it("flags a bundle with no SKILL.md as CRITICAL", () => {
    const findings = checkBundleStructure({ files: [{ path: "notes.md", content: "hi" }], limits: {} });
    expect(findings.map((f) => f.ruleId)).toContain("BUNDLE_MANIFEST_MISSING");
    expect(findings.find((f) => f.ruleId === "BUNDLE_MANIFEST_MISSING")?.severity).toBe("CRITICAL");
  });

  it("accepts SKILL.md at the bundle root", () => {
    expect(ids([SKILL_MD])).not.toContain("BUNDLE_MANIFEST_MISSING");
  });

  it("accepts a case variant with a WARN rather than a hard miss", () => {
    // A case-insensitive filesystem round-trip must not be a hard failure.
    const findings = checkBundleStructure({ files: [{ path: "skill.md", content: "x" }], limits: {} });
    expect(findings.map((f) => f.ruleId)).not.toContain("BUNDLE_MANIFEST_MISSING");
    expect(findings.map((f) => f.ruleId)).toContain("BUNDLE_MANIFEST_CASE");
    expect(findings.find((f) => f.ruleId === "BUNDLE_MANIFEST_CASE")?.severity).toBe("WARN");
  });

  it("prefers the canonical manifest when a case variant appears first", () => {
    const findings = checkBundleStructure({
      files: [
        { path: "skill.md", content: "case variant" },
        SKILL_MD,
      ],
      limits: {},
    });

    expect(findings.map((finding) => finding.ruleId)).not.toContain("BUNDLE_MANIFEST_CASE");
  });

  it("does NOT accept a nested SKILL.md as the bundle root", () => {
    // Root resolution / stripComponents is the archive reader's job; by the
    // time the gate runs, SKILL.md must be at the root.
    expect(ids([{ path: "inner/SKILL.md", content: "x" }])).toContain("BUNDLE_MANIFEST_MISSING");
  });
});

describe("bundle structure — path safety (all CRITICAL)", () => {
  it.each([
    ["absolute path", "/etc/passwd"],
    ["parent traversal", "../escape.md"],
    ["nested traversal", "references/../../escape.md"],
    ["windows drive prefix", "C:/windows/system32/evil.dll"],
    ["backslash traversal", "references\\..\\..\\escape.md"],
  ])("rejects %s", (_label, path) => {
    const findings = checkBundleStructure({ files: [SKILL_MD, { path, content: "x" }], limits: {} });
    const hit = findings.find((f) => f.ruleId === "BUNDLE_PATH_UNSAFE");
    expect(hit, `expected BUNDLE_PATH_UNSAFE for ${path}`).toBeDefined();
    expect(hit?.severity).toBe("CRITICAL");
  });

  it("rejects a path deeper than maxPathDepth", () => {
    const deep = Array.from({ length: 12 }, (_, i) => `d${i}`).join("/") + "/x.md";
    expect(ids([SKILL_MD, { path: deep, content: "x" }])).toContain("BUNDLE_PATH_UNSAFE");
  });

  it("warns (not rejects) on merely deep nesting inside the depth cap", () => {
    const nested = "a/b/c/d/e/f/g/x.md"; // depth 8: past the WARN threshold, inside the cap of 10
    const findings = checkBundleStructure({ files: [SKILL_MD, { path: nested, content: "x" }], limits: {} });
    expect(findings.map((f) => f.ruleId)).toContain("BUNDLE_DEEP_NEST");
    expect(findings.map((f) => f.ruleId)).not.toContain("BUNDLE_PATH_UNSAFE");
  });

  it("accepts the conventional support directories", () => {
    const files = [
      SKILL_MD,
      { path: "references/notes.md", content: "x" },
      { path: "templates/report.md", content: "x" },
      { path: "scripts/run.sh", content: "x" },
      { path: "assets/diagram.txt", content: "x" },
      { path: "examples/demo.md", content: "x" },
    ];
    expect(ids(files)).not.toContain("BUNDLE_PATH_UNSAFE");
  });
});

describe("bundle structure — member type", () => {
  it("rejects a symlink member as CRITICAL", () => {
    expect(
      severityOf([SKILL_MD, { path: "link.md", content: "x", type: "symlink" }], "BUNDLE_SYMLINK_MEMBER"),
    ).toBe("CRITICAL");
  });

  it("rejects a hardlink member as CRITICAL", () => {
    expect(
      severityOf([SKILL_MD, { path: "link.md", content: "x", type: "hardlink" }], "BUNDLE_SYMLINK_MEMBER"),
    ).toBe("CRITICAL");
  });

  it("rejects an ELF binary by MAGIC BYTES even when named .md", () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);
    expect(severityOf([SKILL_MD, { path: "notes.md", content: elf }], "BUNDLE_BINARY_MEMBER")).toBe("CRITICAL");
  });

  it("rejects a Mach-O binary by magic bytes", () => {
    const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0x00, 0x00]);
    expect(severityOf([SKILL_MD, { path: "helper", content: macho }], "BUNDLE_BINARY_MEMBER")).toBe("CRITICAL");
  });

  it("rejects a PE binary by magic bytes", () => {
    const pe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
    expect(severityOf([SKILL_MD, { path: "tool.exe", content: pe }], "BUNDLE_BINARY_MEMBER")).toBe("CRITICAL");
  });

  it("does NOT flag UTF-8 text containing non-ASCII as binary", () => {
    const files = [SKILL_MD, { path: "references/i18n.md", content: "Grüße — 日本語 — emoji 🎉" }];
    expect(ids(files)).not.toContain("BUNDLE_BINARY_MEMBER");
  });

  it("warns on an exec bit set on a non-script member", () => {
    const findings = checkBundleStructure({
      files: [SKILL_MD, { path: "references/notes.md", content: "x", mode: 0o755 }],
      limits: {},
    });
    expect(findings.map((f) => f.ruleId)).toContain("BUNDLE_EXEC_BIT");
    expect(findings.find((f) => f.ruleId === "BUNDLE_EXEC_BIT")?.severity).toBe("WARN");
  });

  it("does not warn on an exec bit set on a recognized script member", () => {
    expect(ids([SKILL_MD, { path: "scripts/run.sh", content: "#!/bin/sh\n", mode: 0o755 }])).not.toContain(
      "BUNDLE_EXEC_BIT",
    );
  });
});

describe("bundle structure — bounds (limit breaches BLOCK)", () => {
  // A cap that is exceeded and then allowed anyway is not a cap. Limit
  // breaches are CRITICAL so they block; the tunability the operator needs
  // comes from the config knobs, not from making the breach advisory.
  // Genuinely-advisory rules (EXEC_BIT, DEEP_NEST, MANIFEST_CASE) stay WARN.
  it("passes at exactly maxEntries and blocks at one over", () => {
    const at = [SKILL_MD, ...Array.from({ length: DEFAULT_BUNDLE_LIMITS.maxEntries - 1 }, (_, i) => ({
      path: `references/f${i}.md`,
      content: "x",
    }))];
    expect(ids(at)).not.toContain("BUNDLE_TOO_MANY_FILES");

    const over = [...at, { path: "references/one-more.md", content: "x" }];
    expect(ids(over)).toContain("BUNDLE_TOO_MANY_FILES");
    expect(severityOf(over, "BUNDLE_TOO_MANY_FILES")).toBe("CRITICAL");
  });

  it("warns when a single member exceeds maxEntryBytes", () => {
    const big = "a".repeat(DEFAULT_BUNDLE_LIMITS.maxEntryBytes + 1);
    expect(ids([SKILL_MD, { path: "references/big.md", content: big }])).toContain("BUNDLE_FILE_TOO_LARGE");
  });

  it("warns when the bundle total exceeds maxBundleBytes", () => {
    // Each member is under the per-entry cap; the TOTAL is what breaches.
    const per = Math.floor(DEFAULT_BUNDLE_LIMITS.maxEntryBytes / 2);
    const count = Math.ceil(DEFAULT_BUNDLE_LIMITS.maxBundleBytes / per) + 1;
    const files = [
      SKILL_MD,
      ...Array.from({ length: count }, (_, i) => ({ path: `references/f${i}.md`, content: "a".repeat(per) })),
    ];
    expect(ids(files)).toContain("BUNDLE_TOO_LARGE");
  });

  it("measures size in BYTES, not characters", () => {
    // A 4-byte-per-char string must not slip under a byte cap by char count.
    const fourByte = "𝄞".repeat(Math.ceil(DEFAULT_BUNDLE_LIMITS.maxEntryBytes / 4) + 1);
    expect(ids([SKILL_MD, { path: "references/music.md", content: fourByte }])).toContain(
      "BUNDLE_FILE_TOO_LARGE",
    );
  });

  it("honors caller-supplied limit overrides", () => {
    const files = [SKILL_MD, { path: "references/a.md", content: "x" }, { path: "references/b.md", content: "x" }];
    expect(ids(files, { maxEntries: 2 })).toContain("BUNDLE_TOO_MANY_FILES");
    expect(ids(files, { maxEntries: 99 })).not.toContain("BUNDLE_TOO_MANY_FILES");
  });
});

describe("bundle structure — .skillignore", () => {
  const IGNORE: SkillBundleFile = { path: ".skillignore", content: "docs/\n*.draft.md\n" };

  it("excludes ignored members from counts", () => {
    const files = [
      SKILL_MD,
      IGNORE,
      { path: "docs/plan.md", content: "x" },
      { path: "notes.draft.md", content: "x" },
    ];
    const findings = checkBundleStructure({ files, limits: { maxEntries: 2 } });
    // SKILL.md alone counts: the ignore file itself and both matches are excluded.
    expect(findings.map((f) => f.ruleId)).not.toContain("BUNDLE_TOO_MANY_FILES");
  });

  it("CANNOT exclude SKILL.md — otherwise the ignore file is the bypass", () => {
    const files = [SKILL_MD, { path: ".skillignore", content: "SKILL.md\n*\n" }];
    expect(checkBundleStructure({ files, limits: {} }).map((f) => f.ruleId)).not.toContain(
      "BUNDLE_MANIFEST_MISSING",
    );
  });

  it("still rejects an unsafe path even when the ignore file lists it", () => {
    // Structural CRITICALs on path shape are not ignorable: an attacker who
    // can ship .skillignore must not be able to ship a traversal with it.
    const files = [SKILL_MD, { path: ".skillignore", content: "*\n" }, { path: "../escape.md", content: "x" }];
    expect(checkBundleStructure({ files, limits: {} }).map((f) => f.ruleId)).toContain("BUNDLE_PATH_UNSAFE");
  });

  it("still rejects a link member matched by the ignore file", () => {
    const files = [
      SKILL_MD,
      { path: ".skillignore", content: "ignored/**\n" },
      { path: "ignored/link.md", content: "target", type: "symlink" as const },
    ];

    expect(checkBundleStructure({ files, limits: {} }).map((finding) => finding.ruleId)).toContain(
      "BUNDLE_SYMLINK_MEMBER",
    );
  });

  it("still rejects binary bytes matched by the ignore file", () => {
    const files = [
      SKILL_MD,
      { path: ".skillignore", content: "ignored/**\n" },
      {
        path: "ignored/payload.md",
        content: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]),
      },
    ];

    expect(checkBundleStructure({ files, limits: {} }).map((finding) => finding.ruleId)).toContain(
      "BUNDLE_BINARY_MEMBER",
    );
  });
});

describe("bundle structure — purity", () => {
  it("does not mutate the input file list", () => {
    const files: SkillBundleFile[] = [SKILL_MD, { path: "references/a.md", content: "x" }];
    const snapshot = JSON.stringify(files);
    checkBundleStructure({ files, limits: {} });
    expect(JSON.stringify(files)).toBe(snapshot);
  });

  it("returns findings in a stable order for identical input", () => {
    const files = [{ path: "../a.md", content: "x" }, { path: "../b.md", content: "x" }];
    const a = checkBundleStructure({ files, limits: {} });
    const b = checkBundleStructure({ files, limits: {} });
    expect(a).toEqual(b);
  });
});
