// SPDX-License-Identifier: Apache-2.0
/**
 * Durable crypto store for the Matrix E2EE path — pure GLUE around the audited
 * SDK. Every cryptographic operation is delegated to `matrix-js-sdk` /
 * `@matrix-org/matrix-sdk-crypto-wasm`; this module owns only the plumbing that
 * lets a Node process persist the WASM engine's device identity + Megolm keys.
 *
 * The rust crypto engine persists ONLY through IndexedDB (browser) or in-memory
 * (ephemeral — a fresh device every restart). Node has neither, so the durable
 * path is: shim `globalThis.indexedDB` with `fake-indexeddb`, run
 * `initRustCrypto({ useIndexedDB: true })`, and snapshot the in-memory IndexedDB
 * contents to a flat on-disk blob under the per-adapter `stateDir`.
 *
 * Three concerns live here:
 *  - `serializeCryptoStore` / `restoreCryptoStore` — a full-DB snapshot
 *    (version + object-store schema + indices + records, keys included) encoded
 *    with `v8.serialize` (structured-clone faithful; JSON mangles the binary
 *    `Uint8Array` record values). Restore reproduces the schema + version so the
 *    next `initRustCrypto` opens an EXISTING db and skips `onupgradeneeded`
 *    (re-running the upgrade would wipe the restored data → a new device id).
 *  - `pruneFinishedTransactions` — the consumer-side fix for the fake-indexeddb
 *    unbounded-memory leak (`Database.transactions` grows 1:1 with every
 *    transaction ever created and is never trimmed). Called on every snapshot
 *    tick so the array stays bounded to one debounce window's churn.
 *
 * Security posture (T-4, key material at rest):
 *  - The snapshot is a 0600 sibling of the plaintext sync-state file under the
 *    0700 `stateDir`, written temp→chmod→rename (the matrix-state discipline).
 *  - No device / session / recovery key material is ever logged — the snapshot
 *    log line carries only `{ step, durationMs, bytes }`-shaped fields.
 *
 * @module
 */

import { serialize, deserialize } from "node:v8";

/** A structured-clone record value plus its primary key (required for out-of-line stores). */
interface RecordSnapshot {
  value: unknown;
  primaryKey: unknown;
}

/** An object-store index definition, reproduced verbatim on restore. */
interface IndexSnapshot {
  name: string;
  keyPath: string | string[] | null;
  unique: boolean;
  multiEntry: boolean;
}

/** An object store's schema + its records. */
interface StoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indices: IndexSnapshot[];
  records: RecordSnapshot[];
}

/** A whole database: name + schema version + every store. */
interface DbSnapshot {
  name: string;
  /** Reproduced on restore so the reopen skips onupgradeneeded (the "new device id" failure mode). */
  version: number;
  stores: StoreSnapshot[];
}

/** Resolve an IDBRequest to a promise. */
function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolve when a readwrite transaction commits (or reject on error/abort). */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = (): void => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Serialize every IndexedDB database in `factory` (schema version + object-store
 * schema + indices + all records with their primary keys) to a flat `v8`-encoded
 * blob.
 *
 * `v8.serialize` — NOT JSON — because crypto-store record values include binary
 * (`Uint8Array`) that JSON silently converts to `{ "0":.., "1":.. }` objects the
 * WASM cannot read back.
 *
 * @param factory - The IndexedDB factory whose databases to snapshot.
 * @returns A `v8`-serialized blob of the full-DB snapshot.
 */
export async function serializeCryptoStore(factory: IDBFactory): Promise<Buffer> {
  const infos = await factory.databases();
  const out: DbSnapshot[] = [];
  for (const info of infos) {
    if (!info.name) continue;
    const db = await promisify<IDBDatabase>(factory.open(info.name, info.version));
    const stores: StoreSnapshot[] = [];
    for (const storeName of Array.from(db.objectStoreNames)) {
      const os = db.transaction(storeName, "readonly").objectStore(storeName);
      const indices: IndexSnapshot[] = Array.from(os.indexNames).map((n) => {
        const ix = os.index(n);
        return { name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
      });
      const records: RecordSnapshot[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursorReq = os.openCursor();
        cursorReq.onsuccess = (): void => {
          const cursor = cursorReq.result;
          if (!cursor) {
            resolve();
            return;
          }
          records.push({ value: cursor.value, primaryKey: cursor.primaryKey });
          cursor.continue();
        };
        cursorReq.onerror = (): void => reject(cursorReq.error ?? new Error("cursor failed"));
      });
      stores.push({ name: storeName, keyPath: os.keyPath, autoIncrement: os.autoIncrement, indices, records });
    }
    out.push({ name: db.name, version: db.version, stores });
    db.close();
  }
  return serialize(out);
}

/**
 * Replay a `serializeCryptoStore` blob into `factory`, reproducing each db at its
 * recorded schema version with its object stores + indices (via
 * `onupgradeneeded`) THEN its records — so a subsequent `initRustCrypto` opens an
 * EXISTING db and reads the persisted device identity + Megolm sessions back
 * rather than minting a fresh device.
 *
 * @param factory - The (fresh) IndexedDB factory to restore into.
 * @param blob - A `v8`-serialized blob produced by `serializeCryptoStore`.
 */
export async function restoreCryptoStore(factory: IDBFactory, blob: Uint8Array): Promise<void> {
  const snapshot = deserialize(blob) as DbSnapshot[];
  for (const dbSnap of snapshot) {
    const openReq = factory.open(dbSnap.name, dbSnap.version);
    openReq.onupgradeneeded = (): void => {
      const db = openReq.result;
      for (const store of dbSnap.stores) {
        const os = db.createObjectStore(store.name, {
          keyPath: store.keyPath ?? undefined,
          autoIncrement: store.autoIncrement,
        });
        for (const ix of store.indices) {
          os.createIndex(ix.name, ix.keyPath ?? [], { unique: ix.unique, multiEntry: ix.multiEntry });
        }
      }
    };
    const db = await promisify<IDBDatabase>(openReq);
    for (const store of dbSnap.stores) {
      if (store.records.length === 0) continue;
      const tx = db.transaction(store.name, "readwrite");
      const os = tx.objectStore(store.name);
      for (const rec of store.records) {
        // Out-of-line keys (keyPath === null) must be supplied explicitly on put.
        if (store.keyPath === null) os.put(rec.value, rec.primaryKey as IDBValidKey);
        else os.put(rec.value);
      }
      await txDone(tx);
    }
    db.close();
  }
}

/** Anything carrying (directly or via its FDBDatabase wrapper) the retained transaction array. */
interface PrunableDatabase {
  transactions?: unknown[];
  _rawDatabase?: { transactions?: unknown[] };
}

/**
 * Bound the fake-indexeddb OOM leak by dropping finished transactions from the
 * internal `Database.transactions` array (which otherwise grows 1:1 with every
 * transaction ever created and is never trimmed). Idempotent; MANDATORY on every
 * snapshot tick.
 *
 * Accepts either the internal `Database` (has `.transactions`) or its
 * `FDBDatabase` wrapper (has `._rawDatabase.transactions`).
 *
 * @param db - The database (or wrapper) whose transaction array to bound.
 * @returns The number of finished transactions removed.
 */
export function pruneFinishedTransactions(db: PrunableDatabase): number {
  const raw = db._rawDatabase ?? db;
  const txns = raw.transactions;
  if (!Array.isArray(txns)) return 0;
  const before = txns.length;
  raw.transactions = txns.filter((t) => (t as { _state?: string } | null)?._state !== "finished");
  return before - raw.transactions.length;
}
