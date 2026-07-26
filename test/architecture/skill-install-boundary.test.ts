// SPDX-License-Identifier: Apache-2.0
/** Mechanical guards for the prompt-only, pre-write skill-install boundary. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function handlerSection(text: string, start: string, end?: string): string {
  const startIndex = text.indexOf(start);
  expect(startIndex, `missing handler marker ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = end === undefined ? text.length : text.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing handler marker ${end ?? "<eof>"}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

function expectGateBeforeWrite(section: string, writeCall: string): void {
  const gateIndex = section.indexOf("runInstallVettingGate(");
  const writeIndex = section.indexOf(writeCall);
  expect(gateIndex, "install handler must invoke the shared vetting gate").toBeGreaterThanOrEqual(0);
  expect(writeIndex, `install handler must contain ${writeCall}`).toBeGreaterThanOrEqual(0);
  expect(gateIndex, `vetting gate must precede ${writeCall}`).toBeLessThan(writeIndex);
}

describe("skill install architecture boundary", () => {
  it("keeps every live install handler behind the shared gate before its first write", () => {
    const handlers = source("packages/daemon/src/api/skill-handlers.ts");

    expectGateBeforeWrite(
      handlerSection(handlers, "[SkillsUploadContract.method]", "[SkillsImportContract.method]"),
      "writeRegularFile(",
    );
    expectGateBeforeWrite(
      handlerSection(handlers, "[SkillsImportContract.method]", "[SkillsDeleteContract.method]"),
      "installSkillDirectory(",
    );
    expectGateBeforeWrite(
      handlerSection(handlers, "[SkillsCreateContract.method]", "[SkillsUpdateContract.method]"),
      "writeRegularFile(",
    );
    expectGateBeforeWrite(
      handlerSection(handlers, "[SkillsUpdateContract.method]"),
      "writeRegularFile(",
    );
  });

  it("keeps source resolvers read-only and unable to install files directly", () => {
    const resolver = source("packages/daemon/src/skills/resolve-skill-import-source.ts");
    expect(resolver).not.toContain("writeRegularFile(");
    expect(resolver).not.toContain("installSkillDirectory(");
    expect(resolver).not.toContain("ensureContainedDir(");
  });

  it("pins the production manifest schema to prompt skills only", () => {
    const manifest = source("packages/skills/src/skills/manifest/schema.ts");
    expect(manifest).toMatch(/type:\s*z\.literal\(["']prompt["']\)/u);
    expect(manifest).not.toMatch(/type:\s*z\.(?:string|enum|union)\(/u);
  });
});
