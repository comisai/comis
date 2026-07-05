// SPDX-License-Identifier: Apache-2.0
/**
 * Crypto-snapshot concurrency proof: two overlapping snapshot writes must not
 * corrupt (or fail) the durable store.
 *
 * A snapshot writes a temp file then atomically renames it over the target. When
 * every write shares ONE constant temp name, two overlapping writes clobber the
 * same temp: the second rename moves the shared temp away, and the first rename
 * then finds nothing to move (ENOENT) — the write fails and the store can be left
 * truncated/garbled, which on next boot deserializes to junk and mints a fresh
 * device. A unique temp name per write keeps the two writes independent.
 *
 * The race is made DETERMINISTIC by gating the first snapshot rename until a
 * second snapshot rename has fully completed (see the fs mock below), rather than
 * relying on scheduling luck.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { deserialize } from "node:v8";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MatrixClient } from "matrix-js-sdk";
import type { ComisLogger } from "@comis/core";
import { initMatrixCrypto } from "../crypto-store.js";

/**
 * Shared gate state the fs mock and the test both read. Only snapshot renames are
 * gated (keyed on the snapshot file name), so an unrelated rename — e.g. the
 * at-rest storage-key persistence — passes straight through.
 */
const gate = vi.hoisted(() => ({
  count: 0,
  release: undefined as (() => void) | undefined,
  reset(): void {
    this.count = 0;
    this.release = undefined;
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Hold the FIRST snapshot rename until the SECOND has completed, so with a
    // shared temp name the first rename deterministically hits ENOENT.
    rename: async (from: unknown, to: unknown): Promise<void> => {
      const isSnapshotRename = typeof from === "string" && from.includes("crypto-snapshot");
      if (!isSnapshotRename) {
        await actual.rename(from as string, to as string);
        return;
      }
      gate.count += 1;
      if (gate.count === 1) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      await actual.rename(from as string, to as string);
      if (gate.count === 2) gate.release?.();
    },
  };
});

const SNAPSHOT_FILE = "crypto-snapshot.json";

const stateDirs: string[] = [];
beforeEach(() => gate.reset());
afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crypto-store-concurrency-"));
  stateDirs.push(dir);
  return dir;
}

function mkLogger(): ComisLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ComisLogger;
}

const realIdbImport = (): Promise<unknown> => import("fake-indexeddb");
const stubWasmImport = (): Promise<unknown> => Promise.resolve({});

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("IDB request failed"));
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("tx failed"));
    tx.onabort = (): void => reject(tx.error ?? new Error("tx aborted"));
  });
}

/** A client whose initRustCrypto seeds the shim store so a snapshot has real content. */
function seedingClient(): MatrixClient {
  const client = {
    initRustCrypto: vi.fn(async () => {
      const idb = globalThis.indexedDB;
      const open = idb.open("comis-matrix::matrix-sdk-crypto", 1);
      open.onupgradeneeded = (): void => {
        open.result.createObjectStore("core");
      };
      const db = await promisify<IDBDatabase>(open);
      const tx = db.transaction("core", "readwrite");
      for (let i = 0; i < 40; i++) tx.objectStore("core").put(new Uint8Array([i, i + 1, i + 2]), `k${i}`);
      await txDone(tx);
      db.close();
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as MatrixClient;
  return client;
}

describe("crypto-store snapshot concurrency", () => {
  it("two overlapping snapshots both succeed and leave a complete, deserializable store", async () => {
    const stateDir = tempStateDir();
    const res = await initMatrixCrypto(seedingClient(), {
      stateDir,
      logger: mkLogger(),
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Fire two snapshots that overlap on the write→rename window. With a shared
    // temp name the gated first rename finds its temp already renamed away
    // (ENOENT) and fails; unique temp names keep both writes independent.
    const [first, second] = await Promise.all([res.value.snapshotNow(), res.value.snapshotNow()]);

    expect([first.ok, second.ok]).toEqual([true, true]);

    // The persisted store is a COMPLETE snapshot, never a truncated/garbled mix.
    const blob = readFileSync(join(stateDir, SNAPSHOT_FILE));
    expect(() => deserialize(blob)).not.toThrow();
    const snapshot = deserialize(blob) as Array<{ name: string; stores: unknown[] }>;
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot[0]?.stores.length).toBeGreaterThan(0);

    await res.value.stop();
  });
});
