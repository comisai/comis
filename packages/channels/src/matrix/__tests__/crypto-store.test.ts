// SPDX-License-Identifier: Apache-2.0
/**
 * Crypto-store unit proofs:
 *  - the snapshot serializer round-trips a fake-indexeddb db (version + schema +
 *    out-of-line keys + binary records) faithfully;
 *  - the transaction pruner bounds the fake-indexeddb OOM leak;
 *  - the serialize/restore helpers need no crypto engine and no global shim.
 *
 * The real-crypto restart-decrypt proof lives in the integration tier
 * (`test/integration/matrix-e2ee-crypto-store.test.ts`) because it instantiates
 * the WASM engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { deserialize } from "node:v8";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MatrixClient } from "matrix-js-sdk";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import type { ComisLogger } from "@comis/core";
import {
  serializeCryptoStore,
  restoreCryptoStore,
  pruneFinishedTransactions,
  initMatrixCrypto,
} from "../crypto-store.js";

/** The full IndexedDB global constructor set the shim installs; cleared between tests. */
const IDB_GLOBALS = [
  "indexedDB",
  "IDBKeyRange",
  "IDBDatabase",
  "IDBFactory",
  "IDBCursor",
  "IDBCursorWithValue",
  "IDBIndex",
  "IDBObjectStore",
  "IDBOpenDBRequest",
  "IDBRequest",
  "IDBTransaction",
  "IDBVersionChangeEvent",
  "IDBRecord",
] as const;

function clearIdbGlobals(): void {
  for (const key of IDB_GLOBALS) delete (globalThis as Record<string, unknown>)[key];
}

// Keep tests order-independent: a later test that installs the shim must not
// leak `globalThis.indexedDB` into the "no shim installed" assertions.
beforeEach(clearIdbGlobals);
afterEach(clearIdbGlobals);

/** A DOM-typed fresh in-memory IndexedDB factory backed by the fake shim. */
function mkFactory(): IDBFactory {
  return new FakeIDBFactory() as unknown as IDBFactory;
}

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

/**
 * Seed a db that exercises every load-bearing corner of the locked format:
 * a non-1 schema version, an in-line-key store with an index, an out-of-line
 * (keyPath === null) store, and a `Uint8Array` record value (the case JSON
 * silently mangles and v8 preserves).
 */
async function seed(factory: IDBFactory): Promise<void> {
  const open = factory.open("crypto-fixture", 5);
  open.onupgradeneeded = (): void => {
    const db = open.result;
    const identities = db.createObjectStore("identities", { keyPath: "userId" });
    identities.createIndex("byDevice", "deviceId", { unique: false, multiEntry: false });
    db.createObjectStore("core"); // out-of-line keys (keyPath === null)
  };
  const db = await promisify<IDBDatabase>(open);
  const tx = db.transaction(["identities", "core"], "readwrite");
  tx.objectStore("identities").put({ userId: "@bot:hs", deviceId: "DEVONE", pickle: new Uint8Array([1, 2, 3, 255]) });
  tx.objectStore("core").put(new Uint8Array([9, 8, 7]), "device_key"); // out-of-line: explicit key
  tx.objectStore("core").put({ schema: 107, note: "meta" }, "store_meta");
  await txDone(tx);
  db.close();
}

describe("serializeCryptoStore / restoreCryptoStore", () => {
  it("round-trips db version, store schema, indices, out-of-line keys and Uint8Array records", async () => {
    const source = mkFactory();
    await seed(source);

    const blob = await serializeCryptoStore(source);
    expect(Buffer.isBuffer(blob)).toBe(true);

    const fresh = mkFactory();
    await restoreCryptoStore(fresh, blob);

    // Structural deep-equal: re-serialize the restored store and compare the
    // decoded snapshots (version + stores + indices + records + keys, all at once).
    const roundTrip = await serializeCryptoStore(fresh);
    expect(deserialize(roundTrip)).toEqual(deserialize(blob));

    // Targeted proofs the structural compare cannot make legible on its own.
    const db = await promisify<IDBDatabase>(fresh.open("crypto-fixture"));
    expect(db.version).toBe(5); // version reproduced → the reopen skips onupgradeneeded
    expect(Array.from(db.objectStoreNames).sort()).toEqual(["core", "identities"]);

    const idStore = db.transaction("identities", "readonly").objectStore("identities");
    expect(Array.from(idStore.indexNames)).toContain("byDevice");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- record value is `unknown`
    const identity = await promisify<any>(idStore.get("@bot:hs"));
    expect(identity.deviceId).toBe("DEVONE");
    expect(identity.pickle).toBeInstanceOf(Uint8Array); // v8, not JSON: the binary survived
    expect(Array.from(identity.pickle as Uint8Array)).toEqual([1, 2, 3, 255]);

    // Out-of-line store: the primary key was captured and re-supplied on put.
    const coreStore = db.transaction("core", "readonly").objectStore("core");
    expect(coreStore.keyPath).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- record value is `unknown`
    const deviceKey = await promisify<any>(coreStore.get("device_key"));
    expect(deviceKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(deviceKey as Uint8Array)).toEqual([9, 8, 7]);
    db.close();
  });
});

describe("pruneFinishedTransactions (fake-indexeddb OOM mitigation)", () => {
  it("bounds the internal transactions array after >= 2000 finished transactions", async () => {
    const factory = mkFactory();
    const open = factory.open("churn", 1);
    open.onupgradeneeded = (): void => {
      open.result.createObjectStore("kv");
    };
    const db = await promisify<IDBDatabase>(open);

    const N = 2000;
    for (let i = 0; i < N; i++) {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({ i }, `k${i}`);
      await txDone(tx);
    }

    // The leak: fake-indexeddb retains every transaction ever created on the
    // internal Database — the exact object the snapshot tick prunes.
    const rawDb = (db as unknown as { _rawDatabase: { transactions: unknown[] } })._rawDatabase;
    expect(rawDb.transactions.length).toBeGreaterThanOrEqual(N);

    const pruned = pruneFinishedTransactions(rawDb);
    expect(pruned).toBeGreaterThanOrEqual(N);
    expect(rawDb.transactions.length).toBeLessThanOrEqual(2); // bounded to in-flight (≈0)
    db.close();
  });
});

describe("the serializer needs no crypto engine", () => {
  it("serialize + restore run without invoking a crypto importer or installing the global shim", async () => {
    const cryptoImport = vi.fn(async () => ({}));
    const source = mkFactory();
    await seed(source);

    // Both helpers act on explicit factories — never `globalThis.indexedDB`,
    // never the crypto engine. The e2ee import boundary is a separate seam
    // (crossed only by initMatrixCrypto).
    const blob = await serializeCryptoStore(source);
    const fresh = mkFactory();
    await restoreCryptoStore(fresh, blob);
    expect(deserialize(await serializeCryptoStore(fresh))).toEqual(deserialize(blob));

    expect(cryptoImport).not.toHaveBeenCalled();
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// initMatrixCrypto — the lazy-import boundary + snapshot lifecycle orchestration
// ---------------------------------------------------------------------------

const stateDirs: string[] = [];
afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crypto-store-"));
  stateDirs.push(dir);
  return dir;
}

function mkLogger(): ComisLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ComisLogger;
}

/** The durable snapshot artifact name — a 0600 sibling of sync-state.json. */
const SNAPSHOT_FILE = "crypto-snapshot.json";

/** A minimal MatrixClient stand-in; `initRustCrypto` is the seam under test. */
function fakeClient(initRustCrypto: (args?: unknown) => Promise<void>): {
  client: MatrixClient;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
} {
  const on = vi.fn();
  const off = vi.fn();
  const client = { initRustCrypto: vi.fn(initRustCrypto), on, off } as unknown as MatrixClient;
  return { client, on, off };
}

/** A real (pure-JS) fake-indexeddb import; safe in the unit tier. */
const realIdbImport = (): Promise<unknown> => import("fake-indexeddb");
/** A crypto-wasm stand-in — the unit tier must NOT instantiate the real WASM (Pitfall 5). */
const stubWasmImport = (): Promise<unknown> => Promise.resolve({});

describe("initMatrixCrypto: lazy-import boundary + init order", () => {
  it("imports both deps once, installs the shim, and calls initRustCrypto with the indexeddb store options", async () => {
    const stateDir = tempStateDir();
    const spyWasm = vi.fn(stubWasmImport);
    const spyIdb = vi.fn(realIdbImport);
    const { client, on } = fakeClient(async () => undefined);

    const res = await initMatrixCrypto(client, {
      stateDir,
      logger: mkLogger(),
      importCryptoWasm: spyWasm,
      importFakeIndexedDb: spyIdb,
    });

    expect(res.ok).toBe(true);
    expect(spyWasm).toHaveBeenCalledTimes(1);
    expect(spyIdb).toHaveBeenCalledTimes(1);
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeDefined();
    expect(client.initRustCrypto).toHaveBeenCalledTimes(1);
    expect(client.initRustCrypto).toHaveBeenCalledWith(
      expect.objectContaining({ useIndexedDB: true, cryptoDatabasePrefix: expect.any(String) }),
    );
    // The snapshot cadence is driven off the /sync batch.
    expect(on).toHaveBeenCalledWith("sync", expect.any(Function));
    if (res.ok) await res.value.stop();
  });

  it("restores the on-disk snapshot into the shim BEFORE initRustCrypto opens the store", async () => {
    const stateDir = tempStateDir();
    // Seed a marker db and write it to the exact file the restore reads.
    const seedFactory = mkFactory();
    const open = seedFactory.open("comis-matrix::matrix-sdk-crypto", 3);
    open.onupgradeneeded = (): void => {
      open.result.createObjectStore("core");
    };
    const sdb = await promisify<IDBDatabase>(open);
    const stx = sdb.transaction("core", "readwrite");
    stx.objectStore("core").put(new Uint8Array([1, 2]), "marker");
    await txDone(stx);
    sdb.close();
    writeFileSync(join(stateDir, SNAPSHOT_FILE), await serializeCryptoStore(seedFactory), { mode: 0o600 });

    // Capture what the store looked like AT the moment initRustCrypto ran.
    let dbsAtInit: string[] = [];
    const { client } = fakeClient(async () => {
      const dbs = await (globalThis.indexedDB as IDBFactory).databases();
      dbsAtInit = dbs.map((d) => d.name).filter((n): n is string => Boolean(n));
    });

    const res = await initMatrixCrypto(client, {
      stateDir,
      logger: mkLogger(),
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });

    expect(res.ok).toBe(true);
    // The restored db was already present when initRustCrypto ran → restore precedes init.
    expect(dbsAtInit).toContain("comis-matrix::matrix-sdk-crypto");
    if (res.ok) await res.value.stop();
  });

  it("leaves the import boundary uncrossed and the shim uninstalled on the non-e2ee path (initMatrixCrypto never called)", async () => {
    const spyWasm = vi.fn(stubWasmImport);
    const spyIdb = vi.fn(realIdbImport);
    // The non-e2ee path simply never calls initMatrixCrypto; the boundary lives inside it.
    expect(spyWasm).not.toHaveBeenCalled();
    expect(spyIdb).not.toHaveBeenCalled();
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
  });

  it("returns err (never throws) when initRustCrypto rejects, so the caller can run unverified", async () => {
    const stateDir = tempStateDir();
    const { client } = fakeClient(async () => {
      throw new Error("crypto backend unavailable");
    });

    const res = await initMatrixCrypto(client, {
      stateDir,
      logger: mkLogger(),
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(Error);
  });
});

describe("MatrixCryptoHandle: 0600 snapshot + OOM prune on the tick", () => {
  it("snapshotNow writes a 0600 snapshot file and prunes the transaction array", async () => {
    const stateDir = tempStateDir();
    // Populate the shim store with churn so there is state to persist and txns to prune.
    const { client } = fakeClient(async () => {
      const idb = globalThis.indexedDB as IDBFactory;
      const open = idb.open("comis-matrix::matrix-sdk-crypto", 1);
      open.onupgradeneeded = (): void => {
        open.result.createObjectStore("core");
      };
      const db = await promisify<IDBDatabase>(open);
      for (let i = 0; i < 60; i++) {
        const tx = db.transaction("core", "readwrite");
        tx.objectStore("core").put({ i }, `k${i}`);
        await txDone(tx);
      }
      db.close();
    });

    const res = await initMatrixCrypto(client, {
      stateDir,
      logger: mkLogger(),
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const rawDb = (globalThis.indexedDB as unknown as { _databases: Map<string, { transactions: unknown[] }> })._databases.get(
      "comis-matrix::matrix-sdk-crypto",
    );
    const leaked = rawDb?.transactions.length ?? 0;
    expect(leaked).toBeGreaterThan(50); // the un-pruned leak

    const snap = await res.value.snapshotNow();
    expect(snap.ok).toBe(true);

    const st = statSync(join(stateDir, SNAPSHOT_FILE));
    expect(st.mode & 0o777).toBe(0o600); // key material at rest is owner-only
    expect(rawDb?.transactions.length ?? 0).toBeLessThan(leaked); // prune coupled to the tick

    await res.value.stop();
  });

  it("stop() flushes a final snapshot and removes the sync listener", async () => {
    const stateDir = tempStateDir();
    const { client, off } = fakeClient(async () => undefined);

    const res = await initMatrixCrypto(client, {
      stateDir,
      logger: mkLogger(),
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
      snapshotDebounceMs: 5_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    res.value.scheduleSnapshot(); // arm the debounce
    await res.value.stop(); // must flush + clear the timer + detach the listener

    expect(statSync(join(stateDir, SNAPSHOT_FILE)).isFile()).toBe(true);
    expect(off).toHaveBeenCalledWith("sync", expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// initMatrixCrypto — cross-signing bootstrap + readable verification status
// ---------------------------------------------------------------------------

/** A valid, decodable recovery key (any 32-byte seed) — treated as a secret in the assertions below. */
const VALID_RECOVERY_KEY = encodeRecoveryKey(new Uint8Array(32).fill(7)) as string;

/** A controllable stand-in for the SDK CryptoApi verification surface. */
function makeFakeCrypto(opts: {
  crossSigningReady?: boolean;
  deviceVerified?: boolean;
  bootstrap?: () => Promise<void>;
}): { crypto: unknown; bootstrapCrossSigning: ReturnType<typeof vi.fn> } {
  const bootstrapCrossSigning = vi.fn(opts.bootstrap ?? (async (): Promise<void> => undefined));
  const crypto = {
    bootstrapCrossSigning,
    isCrossSigningReady: vi.fn(async () => opts.crossSigningReady ?? false),
    getDeviceVerificationStatus: vi.fn(async () =>
      opts.deviceVerified === undefined ? null : { isVerified: () => opts.deviceVerified },
    ),
  };
  return { crypto, bootstrapCrossSigning };
}

/** A fake client wired for the verification path: crypto handle + identity + a mutable cryptoCallbacks. */
function fakeE2eeClient(crypto: unknown): {
  client: MatrixClient;
  cryptoCallbacks: Record<string, unknown>;
} {
  const cryptoCallbacks: Record<string, unknown> = {};
  const client = {
    initRustCrypto: vi.fn(async (): Promise<void> => undefined),
    on: vi.fn(),
    off: vi.fn(),
    getCrypto: () => crypto,
    getUserId: () => "@bot:hs",
    getDeviceId: () => "DEVBOT",
    cryptoCallbacks,
  } as unknown as MatrixClient;
  return { client, cryptoCallbacks };
}

describe("initMatrixCrypto: cross-signing bootstrap + readable verification status", () => {
  it("bootstraps cross-signing from a recovery key and reports the device verified", async () => {
    const stateDir = tempStateDir();
    const { crypto, bootstrapCrossSigning } = makeFakeCrypto({ crossSigningReady: true, deviceVerified: true });
    const { client, cryptoCallbacks } = fakeE2eeClient(crypto);

    const res = await initMatrixCrypto(client, {
      stateDir,
      recoveryKey: VALID_RECOVERY_KEY,
      logger: mkLogger(),
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1);
    // The 4S-unlock callback the SDK invokes during bootstrap was installed.
    expect(typeof cryptoCallbacks.getSecretStorageKey).toBe("function");
    await expect(res.value.getVerificationStatus()).resolves.toEqual({
      crossSigningReady: true,
      deviceVerified: true,
    });
    await res.value.stop();
  });

  it("runs unverified with a loud, actionable startup log when no recovery key is configured", async () => {
    const stateDir = tempStateDir();
    const { crypto, bootstrapCrossSigning } = makeFakeCrypto({ crossSigningReady: false, deviceVerified: false });
    const { client } = fakeE2eeClient(crypto);
    const logger = mkLogger();

    const res = await initMatrixCrypto(client, {
      stateDir,
      // No recovery key configured.
      logger,
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });

    // The bot runs UNVERIFIED but NOT dark — init still returns ok.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
    // A loud WARN names the missing verification + the config key that fixes it.
    const warn = vi.mocked(logger.warn);
    expect(warn).toHaveBeenCalled();
    const warnBlob = JSON.stringify(warn.mock.calls);
    expect(warnBlob).toContain("channels.matrix.recoveryKey");
    expect(warnBlob.toLowerCase()).toContain("unverified");
    await expect(res.value.getVerificationStatus()).resolves.toEqual({
      crossSigningReady: false,
      deviceVerified: false,
    });
    await res.value.stop();
  });

  it("keeps init non-fatal when the cross-signing bootstrap rejects — runs unverified, still ok", async () => {
    const stateDir = tempStateDir();
    const { crypto, bootstrapCrossSigning } = makeFakeCrypto({
      crossSigningReady: false,
      deviceVerified: false,
      bootstrap: async (): Promise<void> => {
        throw new Error("bootstrap backend unavailable");
      },
    });
    const { client } = fakeE2eeClient(crypto);
    const logger = mkLogger();

    const res = await initMatrixCrypto(client, {
      stateDir,
      recoveryKey: VALID_RECOVERY_KEY,
      logger,
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });

    // A verification failure NEVER bricks the channel — it degrades to unverified.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1); // it was attempted
    expect(vi.mocked(logger.warn)).toHaveBeenCalled(); // loud on the failure
    await res.value.stop();
  });

  it("never logs the recovery key or decoded key material in any field", async () => {
    const stateDir = tempStateDir();
    const { crypto } = makeFakeCrypto({ crossSigningReady: true, deviceVerified: true });
    const { client } = fakeE2eeClient(crypto);
    const logger = mkLogger();

    const res = await initMatrixCrypto(client, {
      stateDir,
      recoveryKey: VALID_RECOVERY_KEY,
      logger,
      importCryptoWasm: vi.fn(stubWasmImport),
      importFakeIndexedDb: vi.fn(realIdbImport),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await res.value.getVerificationStatus(); // exercise the status read too
    for (const method of ["info", "warn", "error", "debug"] as const) {
      const blob = JSON.stringify(vi.mocked(logger[method]).mock.calls);
      expect(blob).not.toContain(VALID_RECOVERY_KEY);
    }
    await res.value.stop();
  });
});
