// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("test artifact cleanup safety", () => {
  let testRoot: string | undefined;

  afterEach(() => {
    vi.doUnmock("node:os");
    vi.resetModules();
    if (testRoot !== undefined) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("leaves the operator workspace untouched during teardown", async () => {
    testRoot = mkdtempSync(resolve(tmpdir(), "comis-cleanup-safety-"));
    const fakeHome = resolve(testRoot, "home");
    const workspace = resolve(fakeHome, ".comis", "workspace");
    const protectedPaths = [
      "ROLE.md",
      ".workspace-state.json",
      "skills/xlsx/SKILL.md",
      "sessions/tenant/telegram/session.jsonl",
      "projects/customer-a/notes.md",
    ];

    for (const relativePath of protectedPaths) {
      const absolutePath = resolve(workspace, relativePath);
      mkdirSync(resolve(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, "operator data", "utf8");
    }

    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => fakeHome };
    });

    const { teardown } = await import("../support/global-setup.js");
    teardown();

    for (const relativePath of protectedPaths) {
      expect(existsSync(resolve(workspace, relativePath))).toBe(true);
    }
  });

  it("isolates every daemon test configuration from operator telemetry", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const configPaths = [
      "test/vitest.config.ts",
      "test/e2e/vitest.config.ts",
      "test/live/vitest.config.ts",
    ];

    for (const relativePath of configPaths) {
      const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
      expect(source, relativePath).toContain("vitest-process-listeners.ts");
    }
  });
});
