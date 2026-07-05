// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PathTraversalError } from "@comis/core";
import {
  createMatrixStateStore,
  matrixStateFilePath,
  type MatrixState,
} from "../matrix-state.js";

const created: string[] = [];

/** A per-test temp dir under the OS tmpdir, cleaned up in afterEach. */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-state-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createMatrixStateStore", () => {
  it("round-trips the full state object through save then load", async () => {
    // A nested, not-yet-existing dir proves save() creates it recursively.
    const store = createMatrixStateStore(path.join(tempDir(), "state"));
    const state: MatrixState = {
      syncToken: "s_since_token",
      deviceId: "AAAADEVICE",
      accessToken: "not-a-real-token",
      watermarks: { "!room-a:hs": 1_720_000_000_000, "!room-b:hs": 1_720_000_000_500 },
    };

    const saved = await store.save(state);
    expect(saved.ok).toBe(true);

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value).toEqual(state);
    }
  });

  it("returns sensible defaults from a fresh empty stateDir without throwing", async () => {
    const store = createMatrixStateStore(path.join(tempDir(), "never-written"));

    const loaded = await store.load();

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.watermarks).toEqual({});
      expect(loaded.value.syncToken).toBeUndefined();
      expect(loaded.value.deviceId).toBeUndefined();
      expect(loaded.value.accessToken).toBeUndefined();
    }
  });

  it("creates the stateDir with no group or other permission bits", async () => {
    const stateDir = path.join(tempDir(), "state");
    const store = createMatrixStateStore(stateDir);

    await store.save({ watermarks: {} });

    expect(fs.statSync(stateDir).mode & 0o077).toBe(0);
  });

  it("writes each state file with no group or other permission bits", async () => {
    const stateDir = path.join(tempDir(), "state");
    const store = createMatrixStateStore(stateDir);

    await store.save({
      accessToken: "not-a-real-token",
      deviceId: "AAAADEVICE",
      watermarks: { "!r:hs": 5 },
    });

    const files = fs.readdirSync(stateDir);
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(fs.statSync(matrixStateFilePath(stateDir, name)).mode & 0o077).toBe(0);
    }
  });

  it("keeps owner-only file bits when overwriting an existing state file", async () => {
    // writeFile's mode argument is ignored once the file exists; the explicit
    // chmod is what must hold the owner-only bits on the second save.
    const stateDir = path.join(tempDir(), "state");
    const store = createMatrixStateStore(stateDir);

    await store.save({ watermarks: { "!r:hs": 1 } });
    await store.save({ watermarks: { "!r:hs": 2 } });

    for (const name of fs.readdirSync(stateDir)) {
      expect(fs.statSync(matrixStateFilePath(stateDir, name)).mode & 0o077).toBe(0);
    }
    const loaded = await store.load();
    expect(loaded.ok && loaded.value.watermarks["!r:hs"]).toBe(2);
  });

  it("rejects a traversal segment when building a state file path", () => {
    const stateDir = path.join(os.tmpdir(), "matrix-state-guard");
    expect(() => matrixStateFilePath(stateDir, "../escape")).toThrow(PathTraversalError);
  });

  it("refuses to reset the watermark when the state file is corrupt", async () => {
    // A corrupt file must not silently default to watermark 0 — that would
    // replay the entire room backlog past the initial-sync guard.
    const stateDir = path.join(tempDir(), "state");
    const store = createMatrixStateStore(stateDir);
    await store.save({ watermarks: { "!r:hs": 42 } });

    for (const name of fs.readdirSync(stateDir)) {
      fs.writeFileSync(matrixStateFilePath(stateDir, name), "{ not: valid json ");
    }

    const loaded = await store.load();
    expect(loaded.ok).toBe(false);
  });
});
