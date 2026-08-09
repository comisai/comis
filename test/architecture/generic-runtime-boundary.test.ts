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
// Live-drive campaign targets describe concrete operator deployments; their domain
// vocabulary is the fixture content those drives configure into operator workspaces,
// not runtime behavior. The rest of the live kit (harness, sim, scripts) stays scanned.
const SKIP_PATHS = ["test/live/self-driving/targets"] as const;

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
  }).filter((file) => {
    const rel = relative(REPO_ROOT, file);
    return !SKIP_PATHS.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
  });
}

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("generic runtime specialization boundary", () => {
  it("keeps capability-service contracts and conformance surfaces inside the scan", () => {
    const covered = new Set(scannedFiles().map((file) => relative(REPO_ROOT, file)));
    for (const path of [
      "packages/capability-service-sdk/src/constants.ts",
      "packages/capability-service-sdk/src/methods.ts",
      "packages/capability-service-sdk/protocol/manifest.json",
      "packages/capability-service-sdk/protocol/fixtures/valid.json",
      "packages/core/src/domain/managed-run.ts",
      "packages/core/src/domain/managed-run-content.ts",
      "packages/core/src/ports/managed-run.ts",
      "packages/core/src/config/capability-service-contributions.ts",
      "packages/core/src/event-bus/events-capability-service.ts",
      "packages/core/src/event-bus/events-managed-run.ts",
      "packages/core/src/ports/capability-service-control.ts",
      "packages/memory/src/managed-run-store.ts",
      "packages/memory/src/managed-run-content-store.ts",
      "packages/daemon/src/wiring/capability-service-runtime.ts",
      "packages/daemon/src/wiring/managed-run-activation-coordinator.ts",
      "packages/memory/src/managed-run-content-row-schema.ts",
      "packages/memory/src/managed-run-store-record.ts",
      "packages/memory/src/managed-run-row-schema.ts",
      "packages/memory/src/schema-managed-runs.ts",
      "packages/daemon/src/__tests__/capability-service-protocol-fixture-host.ts",
      "packages/daemon/src/__tests__/capability-service-protocol-fixture-server.ts",
      "packages/daemon/src/__tests__/capability-service-protocol-fixture-host-entry.ts",
      "packages/daemon/src/wiring/capability-service-strict-json.ts",
      "packages/daemon/src/wiring/capability-service-unix-host.ts",
      "packages/daemon/src/wiring/setup-capability-services.ts",
    ]) {
      expect(covered.has(path), path).toBe(true);
    }
  });

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

  it("constructs no service-specific worker command line in production source", () => {
    const serviceCommandToken = "dev" + "crew";
    const violations = scannedFiles()
      .filter((file) => relative(REPO_ROOT, file).startsWith("packages/"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(file, "utf8").toLowerCase().includes(serviceCommandToken));

    expect(violations.map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it("keeps starter workspaces neutral while seeding generic first-run setup", () => {
    const templates = source("packages/core/src/workspace/templates.ts");
    expect(templates).not.toContain('"BOOTSTRAP.md": ""');
    expect(templates).toMatch(/"BOOTSTRAP\.md":[\s\S]*new workspace/iu);
    expect(templates).toContain("isUntouchedWorkspaceTemplate");
    expect(templates).not.toMatch(/personal assistant|industry|preferred language|creature|vibe|emoji/iu);
  });

  it("wraps server instructions before prompt exposure", () => {
    const promptAssembly = [
      source("packages/agent/src/executor/prompt-assembly-shared.ts"),
      source("packages/agent/src/executor/prompt-dynamic-preamble.ts"),
    ].join("\n");
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

  it("does not recover control state from workspace headings or rendered skill xml", () => {
    for (const path of [
      "packages/agent/src/executor/prompt-assembly-shared.ts",
      "packages/agent/src/executor/prompt-assembly-runtime.ts",
      "packages/agent/src/executor/prompt-parent-cache.ts",
      "packages/agent/src/executor/prompt-dynamic-preamble.ts",
      "packages/agent/src/executor/prompt-compiler.ts",
    ]) {
      const text = source(path);
      expect(text).not.toMatch(/parse(?:d|s|r)?[^\n]*(?:skill[^\n]*xml|xml[^\n]*skill)/iu);
      expect(text).not.toMatch(/unescapeXml|extractUserLanguage|preferred-language field|reply-language tier/iu);
    }
  });
});
