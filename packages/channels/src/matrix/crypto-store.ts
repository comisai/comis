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
 *  - `initMatrixCrypto` — the lazy-import boundary. The WASM engine +
 *    fake-indexeddb are reached ONLY through a dynamic `import()` this function
 *    crosses; a plaintext-only install (which never calls it) never loads them.
 *    It restores the snapshot → installs the shim → `client.initRustCrypto(...)`
 *    → returns a handle whose `scheduleSnapshot()` debounces a snapshot+prune
 *    off the /sync batch and `stop()` flushes a final snapshot. It NEVER throws
 *    across the port: a bootstrap failure returns `err` so the caller can run
 *    unverified rather than bricking the channel.
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
import { mkdir, writeFile, readFile, chmod, rename } from "node:fs/promises";
// `ClientEvent` is a value import; matrix-js-sdk itself pulls in NO crypto — the
// WASM engine is lazy-loaded only inside `initRustCrypto`, so the crypto-engine
// boundary (no static crypto-wasm / fake-indexeddb import) still holds.
import { ClientEvent, type MatrixClient } from "matrix-js-sdk";
// `decodeRecoveryKey` is a PURE base58 helper (no WASM engine) — turning the
// operator's recovery key into the secret-storage key that unlocks cross-signing.
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import { systemNowMs, systemSetTimeout, systemClearTimeout } from "@comis/core";
import { matrixStateFilePath } from "./matrix-state.js";

/** The durable crypto-store snapshot: a 0600 sibling of sync-state.json under stateDir. */
const CRYPTO_SNAPSHOT_FILE = "crypto-snapshot.json";
/** The temp file an atomic snapshot write renames over the target. */
const CRYPTO_SNAPSHOT_TMP_FILE = "crypto-snapshot.json.tmp";
/** Owner-only directory permissions (rwx------). */
const DIR_MODE = 0o700;
/** Owner-only file permissions (rw-------) — the snapshot holds device + session keys. */
const FILE_MODE = 0o600;
/** The IndexedDB db-name prefix; the SDK appends `::matrix-sdk-crypto`. */
const CRYPTO_DB_PREFIX = "comis-matrix";
/** Default snapshot+prune debounce window (ms); injected small in tests. */
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 30_000;

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

// ---------------------------------------------------------------------------
// initMatrixCrypto — the lazy-import boundary + snapshot lifecycle
// ---------------------------------------------------------------------------

/** Dependencies for the e2ee crypto bootstrap. */
export interface InitMatrixCryptoDeps {
  /** Absolute state dir (0700); the snapshot lands as a 0600 sibling of sync-state.json. */
  stateDir: string;
  /**
   * Recovery-key SecretRef (resolved string). When set, it unlocks 4S so the
   * device bootstraps cross-signing and reads as verified; when absent, the bot
   * runs unverified with a loud startup log. NEVER logged, returned, or exposed.
   */
  recoveryKey?: string;
  logger: ComisLogger;
  /**
   * LAZY-IMPORT SEAM: defaults to `() => import("@matrix-org/matrix-sdk-crypto-wasm")`.
   * Injected + spied in tests to PROVE the boundary is not crossed on the non-e2ee path.
   */
  importCryptoWasm?: () => Promise<unknown>;
  /** LAZY-IMPORT SEAM: defaults to `() => import("fake-indexeddb")`. */
  importFakeIndexedDb?: () => Promise<unknown>;
  /** Debounce window (ms) for the snapshot+prune tick. Default 30_000. Injected small in tests. */
  snapshotDebounceMs?: number;
  now?: () => number;
}

/** Handle the client lifecycle drives: schedule a snapshot, force one, or stop. */
export interface MatrixCryptoHandle {
  /** Debounced snapshot+prune scheduler tick trigger (called after crypto store writes). */
  scheduleSnapshot(): void;
  /** Force a synchronous snapshot+prune now (used on stop and in tests). */
  snapshotNow(): Promise<Result<void, Error>>;
  /** Stop: flush a final snapshot + clear the debounce timer + detach the sync listener. */
  stop(): Promise<void>;
  /**
   * Read the device's cross-signing / verification posture for the operator-facing
   * health surface. `crossSigningReady` reflects `isCrossSigningReady()`;
   * `deviceVerified` reflects this device's `getDeviceVerificationStatus(...)`.
   * Returns all-false when the crypto backend is absent. NEVER carries key material.
   */
  getVerificationStatus(): Promise<{ crossSigningReady: boolean; deviceVerified: boolean }>;
}

/** The fake-indexeddb module shape the shim installer needs (the full IDB global set). */
interface FakeIndexedDbModule {
  IDBFactory: new () => IDBFactory;
  IDBKeyRange: unknown;
  IDBDatabase: unknown;
  IDBCursor: unknown;
  IDBCursorWithValue: unknown;
  IDBIndex: unknown;
  IDBObjectStore: unknown;
  IDBOpenDBRequest: unknown;
  IDBRequest: unknown;
  IDBTransaction: unknown;
  IDBVersionChangeEvent: unknown;
  IDBRecord?: unknown;
}

/**
 * Install the FULL IndexedDB global constructor set onto `globalThis` from the
 * (lazily-imported) fake-indexeddb module, with a FRESH factory instance.
 *
 * The full set is mandatory: `initRustCrypto` runs wasm-bindgen `instanceof
 * IDBDatabase / IDBTransaction / ...` casts that throw "Dynamic cast failed" at
 * store-open when those global constructors are absent — installing only
 * `indexedDB` + `IDBKeyRange` is not enough.
 */
function installIndexedDbShim(mod: unknown): void {
  const m = mod as FakeIndexedDbModule;
  const g = globalThis as unknown as Record<string, unknown>;
  g.indexedDB = new m.IDBFactory(); // fresh store; a restore repopulates it before init
  g.IDBFactory = m.IDBFactory;
  g.IDBKeyRange = m.IDBKeyRange;
  g.IDBDatabase = m.IDBDatabase;
  g.IDBCursor = m.IDBCursor;
  g.IDBCursorWithValue = m.IDBCursorWithValue;
  g.IDBIndex = m.IDBIndex;
  g.IDBObjectStore = m.IDBObjectStore;
  g.IDBOpenDBRequest = m.IDBOpenDBRequest;
  g.IDBRequest = m.IDBRequest;
  g.IDBTransaction = m.IDBTransaction;
  g.IDBVersionChangeEvent = m.IDBVersionChangeEvent;
  if (m.IDBRecord !== undefined) g.IDBRecord = m.IDBRecord;
}

/** Warm the WASM engine if the (lazily-imported) module exposes an async initializer (idempotent). */
async function warmCryptoWasm(mod: unknown): Promise<void> {
  const initAsync = (mod as { initAsync?: (url?: URL | string) => Promise<void> }).initAsync;
  if (typeof initAsync === "function") await initAsync();
}

/** Read the durable snapshot blob; `undefined` for a fresh stateDir (ENOENT). Other read errors propagate. */
async function readCryptoSnapshot(stateDir: string): Promise<Buffer | undefined> {
  const file = matrixStateFilePath(stateDir, CRYPTO_SNAPSHOT_FILE);
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") return undefined;
    // @allow-throw: re-raise an unexpected (non-ENOENT) snapshot-read error to the
    // initMatrixCrypto fromPromise boundary, which converts it to Result.err — a
    // fresh stateDir (ENOENT) is handled above as "no snapshot yet".
    throw error;
  }
}

/**
 * Write the snapshot blob atomically at 0600 under the 0700 stateDir: temp →
 * chmod 0600 → rename over the target, re-chmod'ing because the modes are
 * ignored once the path exists. The matrix-state discipline, verbatim.
 */
async function writeCryptoSnapshot(stateDir: string, blob: Buffer): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  await chmod(stateDir, DIR_MODE);
  const file = matrixStateFilePath(stateDir, CRYPTO_SNAPSHOT_FILE);
  const tmp = matrixStateFilePath(stateDir, CRYPTO_SNAPSHOT_TMP_FILE);
  await writeFile(tmp, blob, { mode: FILE_MODE });
  await chmod(tmp, FILE_MODE); // the temp is 0600 BEFORE the rename → the real file is never world-readable
  await rename(tmp, file);
}

/** Prune finished transactions from every live database in the factory (the OOM mitigation on the tick). */
function pruneFactoryTransactions(factory: IDBFactory): number {
  const internal = (factory as unknown as { _databases?: Map<string, PrunableDatabase> })._databases;
  if (!internal) return 0;
  let total = 0;
  for (const db of internal.values()) total += pruneFinishedTransactions(db);
  return total;
}

/** Build the snapshot handle once the store is up: debounced snapshot+prune + a guaranteed flush on stop. */
function createHandle(
  client: MatrixClient,
  stateDir: string,
  logger: ComisLogger,
  debounceMs: number,
  now: () => number,
): MatrixCryptoHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const snapshotNow = (): Promise<Result<void, Error>> => {
    const started = now();
    return fromPromise(
      (async (): Promise<void> => {
        const factory = globalThis.indexedDB;
        const blob = await serializeCryptoStore(factory);
        const prunedTx = pruneFactoryTransactions(factory); // OOM mitigation coupled to the tick
        await writeCryptoSnapshot(stateDir, blob);
        logger.debug(
          { channelType: "matrix" as const, step: "crypto-snapshot", durationMs: now() - started, bytes: blob.length, prunedTx },
          "matrix crypto store snapshot persisted",
        );
      })(),
    );
  };

  // Coalescing debounce (fixed window from the first schedule, fire once): under
  // sustained /sync churn a reset-on-each debounce could starve the snapshot and
  // let the tx array grow unbounded — the OOM the prune exists to stop. This
  // guarantees at least one snapshot+prune per window.
  const scheduleSnapshot = (): void => {
    if (stopped || timer !== undefined) return;
    timer = systemSetTimeout(() => {
      timer = undefined;
      void snapshotNow().then((r) => {
        if (!r.ok) {
          logger.warn(
            { channelType: "matrix" as const, errorKind: "resource" as const, hint: "a scheduled crypto-store snapshot failed; the next tick or stop() retries" },
            "matrix crypto store snapshot failed",
          );
        }
      });
    }, debounceMs);
    (timer as { unref?: () => void }).unref?.(); // never keep the event loop alive for a pending snapshot
  };

  const onSync = (): void => scheduleSnapshot();
  client.on(ClientEvent.Sync, onSync);

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== undefined) {
      systemClearTimeout(timer);
      timer = undefined;
    }
    try {
      client.off(ClientEvent.Sync, onSync);
    } catch {
      // best-effort detach
    }
    const flushed = await snapshotNow();
    if (!flushed.ok) {
      logger.warn(
        { channelType: "matrix" as const, errorKind: "resource" as const, hint: "the final crypto-store snapshot on stop failed; the next start restores from the last good snapshot" },
        "matrix crypto store final snapshot failed",
      );
    }
  };

  // Read-only device-trust posture for the health surface. Delegates entirely to
  // the SDK's verification API; carries no key material. All-false if crypto is absent.
  const getVerificationStatus = async (): Promise<{ crossSigningReady: boolean; deviceVerified: boolean }> => {
    const crypto = client.getCrypto();
    if (!crypto) return { crossSigningReady: false, deviceVerified: false };
    const crossSigningReady = await crypto.isCrossSigningReady();
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    let deviceVerified = false;
    if (userId !== null && deviceId !== null) {
      const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
      deviceVerified = status?.isVerified() ?? false;
    }
    return { crossSigningReady, deviceVerified };
  };

  return { scheduleSnapshot, snapshotNow, stop, getVerificationStatus };
}

/**
 * Give the bot device a real, operator-visible trust posture. NEVER throws — a
 * verification failure degrades to "unverified + loud" and must not brick /sync:
 *  - recovery key configured → decode it to the secret-storage key, install the
 *    `getSecretStorageKey` callback the SDK invokes to unlock secret storage, and
 *    `bootstrapCrossSigning` so the device reads as verified. A rejection is logged
 *    loud and swallowed (the bot runs unverified rather than dark).
 *  - no recovery key → run UNVERIFIED, but say so with a loud, actionable startup
 *    log naming `channels.matrix.recoveryKey`.
 *
 * The recovery key, the decoded secret-storage key, and any 4S material live only
 * inside this function's closures and are NEVER logged, returned, or exposed.
 */
async function bootstrapDeviceVerification(
  client: MatrixClient,
  recoveryKey: string | undefined,
  logger: ComisLogger,
): Promise<void> {
  if (recoveryKey === undefined || recoveryKey.length === 0) {
    logger.warn(
      {
        channelType: "matrix" as const,
        step: "crypto-verify" as const,
        errorKind: "internal" as const,
        hint: "The bot device is UNVERIFIED — encrypted rooms requiring verified devices may withhold keys. Set channels.matrix.recoveryKey or verify the bot from Element",
      },
      "Matrix bot device is unverified — no recovery key configured",
    );
    return;
  }

  // A recovery key IS configured: unlock 4S and bootstrap cross-signing so the
  // device reads as verified. Wrapped so a rejection is non-fatal (loud + unverified).
  const bootstrapped = await fromPromise(
    (async (): Promise<void> => {
      const crypto = client.getCrypto();
      if (!crypto) throw new Error("crypto backend unavailable for cross-signing bootstrap");
      // Decode the recovery key to the secret-storage key and install the callback
      // the SDK invokes to unlock 4S during bootstrap. The decoded key stays in
      // this closure — never logged, never returned.
      const secretStorageKey = decodeRecoveryKey(recoveryKey);
      client.cryptoCallbacks.getSecretStorageKey = async ({ keys }) => {
        const [keyId] = Object.keys(keys);
        return keyId === undefined ? null : [keyId, secretStorageKey];
      };
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => {
          await makeRequest(null);
        },
      });
    })(),
  );

  if (bootstrapped.ok) {
    logger.info(
      { channelType: "matrix" as const, step: "crypto-verify" as const },
      "Matrix cross-signing bootstrapped — device verified",
    );
  } else {
    logger.warn(
      {
        channelType: "matrix" as const,
        step: "crypto-verify" as const,
        errorKind: "internal" as const,
        hint: "Cross-signing bootstrap failed — the bot runs as an UNVERIFIED device. Check channels.matrix.recoveryKey is the homeserver recovery key, or verify the bot from Element",
      },
      "Matrix cross-signing bootstrap failed — running unverified",
    );
  }
}

/**
 * Bootstrap the Matrix E2EE crypto store: cross the lazy-import boundary, restore
 * the durable snapshot, initialise the rust crypto store over the fake-indexeddb
 * shim, and return a snapshot handle. NEVER throws across the port — a bootstrap
 * failure returns `err` so the caller logs loud + runs unverified.
 *
 * @param client - The authenticated matrix-js-sdk client.
 * @param deps - State dir, logger, and the (spy-able) lazy-import seams.
 * @returns The snapshot handle, or an error if crypto bootstrap failed.
 */
export function initMatrixCrypto(
  client: MatrixClient,
  deps: InitMatrixCryptoDeps,
): Promise<Result<MatrixCryptoHandle, Error>> {
  const {
    stateDir,
    logger,
    importCryptoWasm,
    importFakeIndexedDb,
    snapshotDebounceMs = DEFAULT_SNAPSHOT_DEBOUNCE_MS,
    now = systemNowMs,
  } = deps;

  return fromPromise(
    (async (): Promise<MatrixCryptoHandle> => {
      // 1. Cross the lazy boundary: install the FULL fake-indexeddb global shim.
      //    These two dynamic `import()`s are the ONLY references to the crypto
      //    deps in the module — a plaintext-only install (which never calls
      //    initMatrixCrypto) never loads them (E2EE-01 / D1). The seams default
      //    to the real dynamic import; tests inject spies to prove the boundary.
      const idbModule = importFakeIndexedDb ? await importFakeIndexedDb() : await import("fake-indexeddb");
      installIndexedDbShim(idbModule);
      // 2. Warm the WASM engine (the same lazy boundary — never reached on plaintext installs).
      const wasmModule = importCryptoWasm ? await importCryptoWasm() : await import("@matrix-org/matrix-sdk-crypto-wasm");
      await warmCryptoWasm(wasmModule);
      // 3. Restore the durable snapshot BEFORE init so the WASM opens an EXISTING db.
      const snapshot = await readCryptoSnapshot(stateDir);
      if (snapshot) await restoreCryptoStore(globalThis.indexedDB, snapshot);
      // 4. Initialise the rust crypto store over the (possibly restored) shim.
      await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: CRYPTO_DB_PREFIX });
      // 5. Give the device a real trust posture: bootstrap cross-signing from the
      //    recovery key, or run unverified + loud. NON-FATAL — never throws here,
      //    so a verification failure can never turn a successful init into an err.
      await bootstrapDeviceVerification(client, deps.recoveryKey, logger);
      // 6. Build the handle + drive the snapshot cadence off the /sync batch.
      return createHandle(client, stateDir, logger, snapshotDebounceMs, now);
    })(),
  );
}
