// SPDX-License-Identifier: Apache-2.0
/**
 * Regression: FileSecretStore writes must survive Node's Permission Model.
 *
 * Under `node --permission`, fs.fsyncSync throws "fsync API is disabled when
 * Permission Model is enabled." Before the best-effort guard, persisting a
 * secret in file mode FATAL-crashed / errored under the production daemon.
 *
 * ESM forbids vi.spyOn on node:fs; mock the module and override fsyncSync
 * per-test (same pattern as atomic-write.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const fs = await import("node:fs");
const os = await import("node:os");
const { join } = await import("node:path");
const { createFileSecretStore } = await import("./file-secret-store.js");

describe("FileSecretStore under Node Permission Model (fsync disabled)", () => {
  let dataDir: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    dataDir = fs.mkdtempSync(join(os.tmpdir(), "file-secret-perm-"));
  });

  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it("set() persists the value when fsync is refused by the permission model", () => {
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      throw new Error("fsync API is disabled when Permission Model is enabled.");
    });

    const store = createFileSecretStore({ dataDir });
    const res = store.set("api-key", "s3cret");
    expect(res.ok).toBe(true);

    // The write landed despite the skipped durability fsync.
    const got = store.getDecrypted("api-key");
    expect(got.ok && got.value).toBe("s3cret");
  });

  it("set() still returns err on a genuine fsync I/O error (EIO)", () => {
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    });

    const store = createFileSecretStore({ dataDir });
    expect(store.set("api-key", "s3cret").ok).toBe(false);
  });
});
