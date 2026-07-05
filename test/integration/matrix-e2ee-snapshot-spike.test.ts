// SPDX-License-Identifier: Apache-2.0
/**
 * De-risk spike: prove the Node crypto-store durable-snapshot format round-trips
 * through the REAL `@matrix-org/matrix-sdk-crypto-wasm` engine.
 *
 * The rust crypto engine (loaded by `matrix-js-sdk`'s `initRustCrypto`) persists
 * ONLY through IndexedDB (browser) or in-memory (ephemeral — a fresh device every
 * restart). Node has neither, so the durable path is: shim `globalThis.indexedDB`
 * with `fake-indexeddb`, run `initRustCrypto({ useIndexedDB: true })`, and snapshot
 * the in-memory IndexedDB contents to a flat on-disk blob. Whether that snapshot,
 * replayed into a fresh store, is faithfully read back by a second `initRustCrypto`
 * (same device identity + a still-decryptable Megolm session) is the single highest
 * risk in the durable-crypto-store design — this test converts that assumption to a
 * fact before the production serializer is built.
 *
 * What it proves, end to end, against real crypto (no homeserver, all in process):
 *  1. A Megolm session established with real crypto-wasm decrypts before restart.
 *  2. The full-DB snapshot (db version + object-store schema + records) written to
 *     a flat file and replayed into a fresh `IDBFactory` lets a SECOND
 *     `initRustCrypto` open an EXISTING db (no `onupgradeneeded` reset), recovering:
 *       - the SAME device id AND the SAME curve25519/ed25519 identity keys, and
 *       - the pre-restart Megolm inbound session, which STILL DECRYPTS the same event.
 *
 * Load-bearing findings for the production serializer:
 *  - The FULL IndexedDB global set must be installed (not just `indexedDB` +
 *    `IDBKeyRange`): wasm-bindgen runs `instanceof IDBDatabase` / `IDBTransaction`
 *    / `IDBObjectStore` / ... casts and throws "Dynamic cast failed" at store-open
 *    when those globals are absent. `fake-indexeddb/auto` installs all of them.
 *  - The db is named `<cryptoDatabasePrefix>::matrix-sdk-crypto`; its schema version
 *    and every object store's keyPath / autoIncrement / indices MUST be reproduced,
 *    or the reopen re-runs `onupgradeneeded` and the restored data is ignored.
 *  - Several stores use OUT-OF-LINE keys (`keyPath === null`): the snapshot must
 *    carry each record's primary key and re-supply it on `put(value, key)`.
 *  - Record values include binary (`Uint8Array`); the durable blob is `v8.serialize`
 *    (structured-clone faithful), NOT JSON (which mangles typed arrays to objects).
 *
 * Security posture (crypto-store-at-rest): the candidate snapshot blob is written to
 * a private temp dir file mode 0600 (the production file is 0600 under a 0700 state
 * dir); the test itself logs NO device keys, session keys, or plaintext.
 *
 * @module
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { serialize, deserialize } from "node:v8";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Snapshot format (the CANDIDATE durable shape the production serializer targets)
// ---------------------------------------------------------------------------

interface RecordSnapshot {
  /** Structured-clone value as read from the store (may be a string / object / Uint8Array). */
  value: unknown;
  /** The record's primary key — always captured, required for out-of-line (keyPath===null) stores. */
  primaryKey: unknown;
}

interface IndexSnapshot {
  name: string;
  keyPath: string | string[] | null;
  unique: boolean;
  multiEntry: boolean;
}

interface StoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indices: IndexSnapshot[];
  records: RecordSnapshot[];
}

interface DbSnapshot {
  name: string;
  /** The schema version — reproduced on restore so the reopen skips onupgradeneeded. */
  version: number;
  stores: StoreSnapshot[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IDBRequest is a browser type; the shim supplies the runtime.
function promisify<T>(req: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error as Error);
  });
}

/** Serialize every IndexedDB database (schema version + stores + records) to a flat structure. */
async function snapshotDatabases(): Promise<DbSnapshot[]> {
  const factory = globalThis.indexedDB;
  const infos = await factory.databases();
  const out: DbSnapshot[] = [];
  for (const info of infos) {
    if (!info.name) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shim runtime type
    const db: any = await promisify(factory.open(info.name, info.version));
    const stores: StoreSnapshot[] = [];
    for (const storeName of Array.from(db.objectStoreNames) as string[]) {
      const os = db.transaction(storeName, "readonly").objectStore(storeName);
      const indices: IndexSnapshot[] = (Array.from(os.indexNames) as string[]).map((n) => {
        const ix = os.index(n);
        return { name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
      });
      const records: RecordSnapshot[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursorReq = os.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          records.push({ value: cursor.value, primaryKey: cursor.primaryKey });
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error as Error);
      });
      stores.push({ name: storeName, keyPath: os.keyPath, autoIncrement: os.autoIncrement, indices, records });
    }
    out.push({ name: db.name, version: db.version, stores });
    db.close();
  }
  return out;
}

/** Replay a snapshot into the current (fresh) IDBFactory, reproducing schema + version + records. */
async function restoreDatabases(snapshot: DbSnapshot[]): Promise<void> {
  const factory = globalThis.indexedDB;
  for (const dbSnap of snapshot) {
    const openReq = factory.open(dbSnap.name, dbSnap.version);
    openReq.onupgradeneeded = () => {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shim runtime type
    const db: any = await promisify(openReq);
    for (const store of dbSnap.stores) {
      if (store.records.length === 0) continue;
      const tx = db.transaction(store.name, "readwrite");
      const os = tx.objectStore(store.name);
      for (const rec of store.records) {
        // Out-of-line keys (keyPath === null) must be supplied explicitly on put.
        if (store.keyPath === null) os.put(rec.value, rec.primaryKey as IDBValidKey);
        else os.put(rec.value);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
        tx.onabort = () => reject(tx.error as Error);
      });
    }
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Spike
// ---------------------------------------------------------------------------

const ROOM_ID = "!spike-room:example.org";
const SENDER_USER = "@sender:example.org";
const SENDER_DEVICE = "SENDERDEVICE";
const BOT_USER = "@bot:example.org";
const BOT_DEVICE = "BOTDEVICEONE";
const STORE_PREFIX = "comis-matrix-spike";
const SECRET_BODY = "megolm-round-trip-probe";

describe("matrix crypto-store durable snapshot", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic-import MatrixClient
  const clients: any[] = [];
  let tempDir: string | undefined;

  afterAll(async () => {
    for (const client of clients) {
      try {
        await client.stopClient();
      } catch {
        // best-effort teardown
      }
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("restores device identity and decrypts a pre-restart Megolm session after a fresh-store snapshot round-trip", async () => {
    // The crypto engine + the shim are lazily imported here — the same lazy boundary
    // the production e2ee path uses (a plaintext-only install never loads them).
    const cryptoWasm = await import("@matrix-org/matrix-sdk-crypto-wasm");
    await cryptoWasm.initAsync();
    const { OlmMachine, UserId, DeviceId, RoomId, EncryptionSettings } = cryptoWasm;
    const { createClient, MatrixEvent } = await import("matrix-js-sdk");

    // --- Sender: mint a real Megolm session + ciphertext + inbound-session export ---
    const sender = await OlmMachine.initialize(new UserId(SENDER_USER), new DeviceId(SENDER_DEVICE));
    await sender.shareRoomKey(new RoomId(ROOM_ID), [new UserId(SENDER_USER)], new EncryptionSettings());
    const wireContent = JSON.parse(
      await sender.encryptRoomEvent(new RoomId(ROOM_ID), "m.room.message", JSON.stringify({ msgtype: "m.text", body: SECRET_BODY })),
    );
    const exportedSessions = JSON.parse(await sender.exportRoomKeys(() => true));
    expect(wireContent.algorithm).toBe("m.megolm.v1.aes-sha2");
    expect(exportedSessions.length).toBeGreaterThan(0);

    const buildEncryptedEvent = () =>
      new MatrixEvent({
        type: "m.room.encrypted",
        sender: SENDER_USER,
        room_id: ROOM_ID,
        event_id: "$spike-evt:example.org",
        origin_server_ts: 1_700_000_000_000,
        content: wireContent,
      });

    // --- Bot, run 1: initRustCrypto over fake-indexeddb; import the session; decrypt ---
    const bot1 = createClient({ baseUrl: "https://home.invalid", userId: BOT_USER, deviceId: BOT_DEVICE, accessToken: "syt_fake_access_token" });
    clients.push(bot1);
    await bot1.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: STORE_PREFIX });
    const crypto1 = bot1.getCrypto();
    expect(crypto1).toBeDefined();
    const originalDeviceId = bot1.getDeviceId();
    const originalKeys = await crypto1!.getOwnDeviceKeys();
    await crypto1!.importRoomKeys(exportedSessions);

    const preRestart = buildEncryptedEvent();
    await bot1.decryptEventIfNeeded(preRestart);
    expect(preRestart.isDecryptionFailure()).toBe(false);
    expect(preRestart.getClearContent()?.body).toBe(SECRET_BODY);

    // --- Snapshot the crypto store to a private (0600) flat file: the candidate durable format ---
    const snapshot = await snapshotDatabases();
    const cryptoDb = snapshot.find((d) => d.name === `${STORE_PREFIX}::matrix-sdk-crypto`);
    expect(cryptoDb, "the rust crypto store db must exist under the configured prefix").toBeDefined();
    expect(cryptoDb!.version).toBeGreaterThan(0);
    expect(cryptoDb!.stores.some((s) => s.name === "inbound_group_sessions3")).toBe(true);

    tempDir = await mkdtemp(join(tmpdir(), "comis-crypto-snap-"));
    const snapshotPath = join(tempDir, "crypto-store.snapshot");
    await writeFile(snapshotPath, serialize(snapshot), { mode: 0o600 });

    // --- Tear the store down and restore the blob into a FRESH IDBFactory (a new process) ---
    await bot1.stopClient();
    globalThis.indexedDB = new IDBFactory(); // class globals persist; only the factory instance resets
    const restored = deserialize(await readFile(snapshotPath)) as DbSnapshot[];
    await restoreDatabases(restored);

    // --- Bot, run 2: a SECOND initRustCrypto must open the EXISTING db and read it back ---
    const bot2 = createClient({ baseUrl: "https://home.invalid", userId: BOT_USER, deviceId: BOT_DEVICE, accessToken: "syt_fake_access_token" });
    clients.push(bot2);
    await bot2.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: STORE_PREFIX });
    const crypto2 = bot2.getCrypto();
    expect(crypto2).toBeDefined();

    // (a) device identity survived the round trip — SAME device id AND SAME identity keys.
    const restoredDeviceId = bot2.getDeviceId();
    const restoredKeys = await crypto2!.getOwnDeviceKeys();
    expect(restoredDeviceId).toBe(originalDeviceId);
    expect(restoredKeys.ed25519).toBe(originalKeys.ed25519);
    expect(restoredKeys.curve25519).toBe(originalKeys.curve25519);

    // (b) the pre-restart Megolm session survived — it STILL DECRYPTS the same event.
    const postRestart = buildEncryptedEvent();
    await bot2.decryptEventIfNeeded(postRestart);
    expect(postRestart.isDecryptionFailure()).toBe(false);
    expect(postRestart.getClearContent()?.body).toBe(SECRET_BODY);
  }, 60_000);
});
