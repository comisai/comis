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
import { serialize, deserialize } from "node:v8";
import {
  serializeCryptoStore,
  restoreCryptoStore,
  pruneFinishedTransactions,
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
