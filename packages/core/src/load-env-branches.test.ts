// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for load-env.ts (COV-03 / Plan 40-11).
 *
 * Targets the parse-loop branches in loadEnvFile() that the existing
 * load-env.test.ts (assertEnvLoaded happy-path only) does not exercise:
 *   - blank/comment lines skip (line 73)
 *   - no-= lines skip (line 76)
 *   - double-quoted value strip (line 82)
 *   - single-quoted value strip (line 84)
 *   - existing-key skip (line 90)
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvFile, resetEnvLoadedForTest } from "./load-env.js";

describe("loadEnvFile() — branch-gap coverage", () => {
  let tmpDir: string;
  let envPath: string;
  let target: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-loadenv-"));
    envPath = join(tmpDir, ".env");
    target = {};
    resetEnvLoadedForTest();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips blank lines and comment lines starting with #", () => {
    writeFileSync(envPath, "\n# comment line\nKEY1=value1\n\n#another\nKEY2=value2\n");
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(2);
    expect(target.KEY1).toBe("value1");
    expect(target.KEY2).toBe("value2");
  });

  it("skips lines that have no = sign at all", () => {
    writeFileSync(envPath, "VALID_KEY=ok\njust a sentence with no equals\nANOTHER=also-ok\n");
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(2);
    expect(target.VALID_KEY).toBe("ok");
    expect(target.ANOTHER).toBe("also-ok");
  });

  it("strips surrounding double quotes from quoted values", () => {
    writeFileSync(envPath, 'QUOTED="hello world"\nNOT_QUOTED=plain value\n');
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(2);
    expect(target.QUOTED).toBe("hello world");
    expect(target.NOT_QUOTED).toBe("plain value");
  });

  it("strips surrounding single quotes from quoted values", () => {
    writeFileSync(envPath, "APOSTROPHE='hello apostrophe'\n");
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(1);
    expect(target.APOSTROPHE).toBe("hello apostrophe");
  });

  it("preserves quotes when only one side has a quote character", () => {
    // Mismatched quotes -- only strip when BOTH start AND end with the same quote char
    writeFileSync(envPath, 'MISMATCH="only-leading\nSINGLE_END=trailing-only"\n');
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(2);
    expect(target.MISMATCH).toBe('"only-leading');
    expect(target.SINGLE_END).toBe('trailing-only"');
  });

  it("does not override existing keys in the target object", () => {
    target.EXISTING = "original";
    writeFileSync(envPath, "EXISTING=clobber-me\nNEW=fresh\n");
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(1); // Only NEW was added; EXISTING was skipped
    expect(target.EXISTING).toBe("original");
    expect(target.NEW).toBe("fresh");
  });

  it("skips lines where the key is empty (just =value)", () => {
    writeFileSync(envPath, "=orphan-value\nGOOD=actual-value\n");
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(1);
    expect(target.GOOD).toBe("actual-value");
    expect(target[""]).toBeUndefined();
  });

  it("returns -1 when target file does not exist (sets envLoaded flag anyway)", () => {
    const count = loadEnvFile(join(tmpDir, "nonexistent.env"), target);
    expect(count).toBe(-1);
    expect(Object.keys(target)).toHaveLength(0);
  });

  it("handles empty file with no env vars and returns count of 0", () => {
    writeFileSync(envPath, "");
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(0);
  });

  it("trims whitespace from both key and value sides of the = sign", () => {
    writeFileSync(envPath, "  PADDED_KEY   =   padded value   \n");
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(1);
    expect(target.PADDED_KEY).toBe("padded value");
  });
});
