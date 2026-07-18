// SPDX-License-Identifier: Apache-2.0
/** Domain-neutral runtime boundary and retired-surface guard. */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SCANNED_ROOTS = [
  "CLAUDE.md",
  "README.md",
  "docs",
  "grafana",
  "packages",
  "prometheus",
  "scripts",
  "test",
] as const;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".planning",
  "coverage",
  "dist",
  "node_modules",
  "runs",
]);

function listTextFiles(path: string): string[] {
  const entries = readdirSync(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...listTextFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function scannedFiles(): string[] {
  return SCANNED_ROOTS.flatMap((entry) => {
    const fullPath = resolve(REPO_ROOT, entry);
    return entry.includes(".") ? [fullPath] : listTextFiles(fullPath);
  });
}

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("generic runtime specialization boundary", () => {
  it("contains no retired domain terms or health surface identifiers", () => {
    const removedTerms = [
      "f" + "leet",
      "itu" + "ran",
      "license" + " plate",
      "geo" + "fence",
      "immo" + "bilize",
    ];
    const retiredIdentifiers = [
      "F" + "leetHealth",
      "obs_" + "f" + "leet_health",
      "f" + "leet" + "_health",
      "obs." + "f" + "leet.health",
    ];
    const violations: string[] = [];
    for (const file of scannedFiles()) {
      const rel = relative(REPO_ROOT, file);
      const haystack = `${rel}\n${readFileSync(file, "utf8")}`.toLowerCase();
      for (const denied of [...removedTerms, ...retiredIdentifiers]) {
        if (haystack.includes(denied.toLowerCase())) violations.push(`${rel}: ${denied}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps starter workspaces neutral and omits unchanged placeholders", () => {
    const templates = source("packages/core/src/workspace/templates.ts");
    expect(templates).toContain('"BOOTSTRAP.md": ""');
    expect(templates).toContain("isUntouchedWorkspaceTemplate");
    expect(templates).not.toMatch(/personal assistant|industry|preferred language/iu);
  });

  it("wraps server instructions before prompt exposure", () => {
    const promptAssembly = source("packages/agent/src/executor/prompt-assembly.ts");
    expect(promptAssembly).toContain("compileMcpInstructionSection");
    expect(promptAssembly).toMatch(/wrapExternalContent\([\s\S]*server/iu);
  });

  it("uses an open locale schema and never reparses prompt headings for locale state", () => {
    const locale = source("packages/core/src/domain/response-locale-policy.ts");
    expect(locale).toContain("Intl.getCanonicalLocales");
    expect(locale).not.toMatch(/ReplyLanguage|english.*hebrew.*arabic.*russian/isu);
    for (const path of [
      "packages/agent/src/rag/hybrid-memory-injector.ts",
      "packages/agent/src/executor/prompt-runner/output-escalation.ts",
      "packages/agent/src/executor/stream-wrappers/request-body/tool-result-clearing.ts",
    ]) {
      expect(source(path)).not.toMatch(/response language|reply language/iu);
    }
  });
});
