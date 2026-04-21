// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { validateWhatsAppAuth } from "./credential-validator.js";

describe("credential-validator / validateWhatsAppAuth", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wa-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs.length = 0;
  });

  it("returns err for empty authDir", async () => {
    const result = await validateWhatsAppAuth({ authDir: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("must not be empty");
    }
  });

  it("returns err for whitespace-only authDir", async () => {
    const result = await validateWhatsAppAuth({ authDir: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("must not be empty");
    }
  });

  it("creates non-existent authDir and returns isFirstRun: true", async () => {
    const base = await makeTempDir();
    const authDir = join(base, "new-auth-dir");

    const result = await validateWhatsAppAuth({ authDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.authDir).toBe(authDir);
      expect(result.value.isFirstRun).toBe(true);
    }
  });

  it("returns isFirstRun: false when auth files exist", async () => {
    const authDir = await makeTempDir();
    await writeFile(join(authDir, "creds.json"), "{}");

    const result = await validateWhatsAppAuth({ authDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isFirstRun).toBe(false);
    }
  });

  it("detects pre-key files as existing auth state", async () => {
    const authDir = await makeTempDir();
    await writeFile(join(authDir, "pre-key-1.json"), "{}");

    const result = await validateWhatsAppAuth({ authDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isFirstRun).toBe(false);
    }
  });

  it("returns isFirstRun: true for existing empty directory", async () => {
    const authDir = await makeTempDir();

    const result = await validateWhatsAppAuth({ authDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isFirstRun).toBe(true);
    }
  });

  it("returns err for unwritable authDir", async () => {
    const authDir = await makeTempDir();
    // Make directory read-only
    await chmod(authDir, 0o444);

    const result = await validateWhatsAppAuth({ authDir });

    // Restore permissions for cleanup
    await chmod(authDir, 0o755);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not writable");
    }
  });
});
