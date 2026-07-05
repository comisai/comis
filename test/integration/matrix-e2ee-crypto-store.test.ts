// SPDX-License-Identifier: Apache-2.0
/**
 * Real-crypto restart-decrypt proof for the PRODUCTION `crypto-store.ts`.
 *
 * The Wave-0 spike proved the durable-snapshot MECHANISM round-trips through the
 * real `@matrix-org/matrix-sdk-crypto-wasm` engine using candidate helpers. This
 * test locks that guarantee onto the SHIPPING module: it drives the whole
 * restart through `initMatrixCrypto` + `MatrixCryptoHandle.snapshotNow()` (the
 * exact code path the Matrix adapter uses), with no bespoke snapshot helpers.
 *
 * End to end, against real crypto (no homeserver, all in process):
 *  1. A Megolm inbound session established with real crypto-wasm decrypts before
 *     restart.
 *  2. `initMatrixCrypto` installs the fake-indexeddb shim, `snapshotNow()` writes
 *     the 0600 durable blob, and a SECOND `initMatrixCrypto` on a fresh client
 *     restores that blob and opens the EXISTING crypto db — recovering the SAME
 *     device id + identity keys and the pre-restart Megolm session, which STILL
 *     decrypts the same event.
 *
 * Runs in the integration tier (imports `@comis/channels` from dist and
 * instantiates the WASM crypto engine, which the unit tier does not).
 *
 * @module
 */

import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initMatrixCrypto } from "@comis/channels";
import type { ComisLogger } from "@comis/core";

const ROOM_ID = "!crypto-store-room:example.org";
const SENDER_USER = "@sender:example.org";
const SENDER_DEVICE = "SENDERDEVICE";
const BOT_USER = "@bot:example.org";
const BOT_DEVICE = "BOTDEVICEONE";
const SECRET_BODY = "production-crypto-store-round-trip";

/** A no-op logger; the crypto-store path must never log key material anyway. */
function stubLogger(): ComisLogger {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return logger as unknown as ComisLogger;
}

describe("matrix crypto-store: real-crypto restart-decrypt through initMatrixCrypto", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic-import MatrixClient
  const clients: any[] = [];
  let stateDir: string | undefined;
  const extraStateDirs: string[] = [];

  afterAll(async () => {
    for (const client of clients) {
      try {
        await client.stopClient();
      } catch {
        // best-effort teardown
      }
    }
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    for (const dir of extraStateDirs) await rm(dir, { recursive: true, force: true });
  });

  it("restores the same device id and decrypts a pre-restart Megolm session after a production snapshot+restart", async () => {
    // The crypto engine is lazily imported here — the same boundary the e2ee path
    // crosses. A plaintext-only install never reaches it.
    const cryptoWasm = await import("@matrix-org/matrix-sdk-crypto-wasm");
    await cryptoWasm.initAsync();
    const { OlmMachine, UserId, DeviceId, RoomId, EncryptionSettings } = cryptoWasm;
    const { createClient, MatrixEvent } = await import("matrix-js-sdk");

    // --- Sender (in-memory OlmMachine): mint a real Megolm session + ciphertext ---
    const sender = await OlmMachine.initialize(new UserId(SENDER_USER), new DeviceId(SENDER_DEVICE));
    await sender.shareRoomKey(new RoomId(ROOM_ID), [new UserId(SENDER_USER)], new EncryptionSettings());
    const wireContent = JSON.parse(
      await sender.encryptRoomEvent(
        new RoomId(ROOM_ID),
        "m.room.message",
        JSON.stringify({ msgtype: "m.text", body: SECRET_BODY }),
      ),
    );
    const exportedSessions = JSON.parse(await sender.exportRoomKeys(() => true));
    expect(wireContent.algorithm).toBe("m.megolm.v1.aes-sha2");
    expect(exportedSessions.length).toBeGreaterThan(0);

    const buildEncryptedEvent = (): InstanceType<typeof MatrixEvent> =>
      new MatrixEvent({
        type: "m.room.encrypted",
        sender: SENDER_USER,
        room_id: ROOM_ID,
        event_id: "$crypto-store-evt:example.org",
        origin_server_ts: 1_700_000_000_000,
        content: wireContent,
      });

    stateDir = await mkdtemp(join(tmpdir(), "comis-crypto-store-"));
    const logger = stubLogger();

    // --- Bot, run 1: production initMatrixCrypto → import session → decrypt → snapshot ---
    const bot1 = createClient({
      baseUrl: "https://home.invalid",
      userId: BOT_USER,
      deviceId: BOT_DEVICE,
      accessToken: "syt_fake_access_token",
    });
    clients.push(bot1);
    const init1 = await initMatrixCrypto(bot1, { stateDir, logger });
    expect(init1.ok).toBe(true);
    if (!init1.ok) return;

    const crypto1 = bot1.getCrypto();
    expect(crypto1).toBeDefined();
    const originalDeviceId = bot1.getDeviceId();
    const originalKeys = await crypto1!.getOwnDeviceKeys();
    await crypto1!.importRoomKeys(exportedSessions);

    const preRestart = buildEncryptedEvent();
    await bot1.decryptEventIfNeeded(preRestart);
    expect(preRestart.isDecryptionFailure()).toBe(false);
    expect(preRestart.getClearContent()?.body).toBe(SECRET_BODY);

    // Persist the crypto store to the 0600 durable blob via the PRODUCTION handle.
    const snap = await init1.value.snapshotNow();
    expect(snap.ok).toBe(true);
    await init1.value.stop();
    await bot1.stopClient();

    // --- Bot, run 2: a fresh client through initMatrixCrypto must restore + resume ---
    // initMatrixCrypto installs a FRESH fake-indexeddb factory and restores the
    // on-disk blob into it before initRustCrypto opens the (now existing) db.
    const bot2 = createClient({
      baseUrl: "https://home.invalid",
      userId: BOT_USER,
      deviceId: BOT_DEVICE,
      accessToken: "syt_fake_access_token",
    });
    clients.push(bot2);
    const init2 = await initMatrixCrypto(bot2, { stateDir, logger });
    expect(init2.ok).toBe(true);
    if (!init2.ok) return;

    const crypto2 = bot2.getCrypto();
    expect(crypto2).toBeDefined();

    // (a) device identity survived — SAME device id AND SAME identity keys.
    expect(bot2.getDeviceId()).toBe(originalDeviceId);
    const restoredKeys = await crypto2!.getOwnDeviceKeys();
    expect(restoredKeys.ed25519).toBe(originalKeys.ed25519);
    expect(restoredKeys.curve25519).toBe(originalKeys.curve25519);

    // (b) the pre-restart Megolm session survived — it STILL DECRYPTS.
    const postRestart = buildEncryptedEvent();
    await bot2.decryptEventIfNeeded(postRestart);
    expect(postRestart.isDecryptionFailure()).toBe(false);
    expect(postRestart.getClearContent()?.body).toBe(SECRET_BODY);

    await init2.value.stop();
  }, 60_000);

  it("encrypts the store at rest with a persisted 32-byte key that a different key cannot open", async () => {
    const cryptoWasm = await import("@matrix-org/matrix-sdk-crypto-wasm");
    await cryptoWasm.initAsync();
    const { OlmMachine, UserId, DeviceId, RoomId, EncryptionSettings } = cryptoWasm;
    const { createClient, MatrixEvent } = await import("matrix-js-sdk");

    // Sender: mint a real Megolm session + ciphertext.
    const sender = await OlmMachine.initialize(new UserId(SENDER_USER), new DeviceId(SENDER_DEVICE));
    await sender.shareRoomKey(new RoomId(ROOM_ID), [new UserId(SENDER_USER)], new EncryptionSettings());
    const wireContent = JSON.parse(
      await sender.encryptRoomEvent(
        new RoomId(ROOM_ID),
        "m.room.message",
        JSON.stringify({ msgtype: "m.text", body: SECRET_BODY }),
      ),
    );
    const exportedSessions = JSON.parse(await sender.exportRoomKeys(() => true));
    const buildEncryptedEvent = (): InstanceType<typeof MatrixEvent> =>
      new MatrixEvent({
        type: "m.room.encrypted",
        sender: SENDER_USER,
        room_id: ROOM_ID,
        event_id: "$crypto-store-atrest:example.org",
        origin_server_ts: 1_700_000_000_000,
        content: wireContent,
      });

    const dir = await mkdtemp(join(tmpdir(), "comis-crypto-atrest-"));
    extraStateDirs.push(dir);
    const logger = stubLogger();

    // Init through PRODUCTION initMatrixCrypto (which now encrypts the store at
    // rest with a persisted 32-byte storage key), establish + decrypt a session,
    // and snapshot the (encrypted) store.
    const bot1 = createClient({
      baseUrl: "https://home.invalid",
      userId: BOT_USER,
      deviceId: BOT_DEVICE,
      accessToken: "syt_fake_access_token",
    });
    clients.push(bot1);
    const init1 = await initMatrixCrypto(bot1, { stateDir: dir, logger });
    expect(init1.ok).toBe(true);
    if (!init1.ok) return;
    const originalDeviceId = bot1.getDeviceId();
    await bot1.getCrypto()!.importRoomKeys(exportedSessions);
    const pre = buildEncryptedEvent();
    await bot1.decryptEventIfNeeded(pre);
    expect(pre.isDecryptionFailure()).toBe(false);
    expect(pre.getClearContent()?.body).toBe(SECRET_BODY);
    expect((await init1.value.snapshotNow()).ok).toBe(true);
    await init1.value.stop();
    await bot1.stopClient();

    // The at-rest key is persisted as a 32-byte 0600 sibling of the store.
    const keyPath = join(dir, "crypto-storage-key");
    expect((await readFile(keyPath)).length).toBe(32);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    // (a) With the CORRECT persisted key, a fresh client restores the SAME device
    //     id and the pre-restart session still decrypts (the encrypted store
    //     round-trips through the snapshot).
    const bot2 = createClient({
      baseUrl: "https://home.invalid",
      userId: BOT_USER,
      deviceId: BOT_DEVICE,
      accessToken: "syt_fake_access_token",
    });
    clients.push(bot2);
    const init2 = await initMatrixCrypto(bot2, { stateDir: dir, logger });
    expect(init2.ok).toBe(true);
    if (!init2.ok) return;
    expect(bot2.getDeviceId()).toBe(originalDeviceId);
    const post = buildEncryptedEvent();
    await bot2.decryptEventIfNeeded(post);
    expect(post.isDecryptionFailure()).toBe(false);
    expect(post.getClearContent()?.body).toBe(SECRET_BODY);
    await init2.value.stop();
    await bot2.stopClient();

    // (b) The SAME on-disk snapshot paired with a DIFFERENT storage key cannot be
    //     opened — proving the store is genuinely encrypted at rest, not merely
    //     0600 plaintext. Bootstrap fails (returns err → the channel runs
    //     unverified) rather than silently reading the store.
    const wrongDir = await mkdtemp(join(tmpdir(), "comis-crypto-wrongkey-"));
    extraStateDirs.push(wrongDir);
    await writeFile(join(wrongDir, "crypto-snapshot.json"), await readFile(join(dir, "crypto-snapshot.json")), {
      mode: 0o600,
    });
    await writeFile(join(wrongDir, "crypto-storage-key"), randomBytes(32), { mode: 0o600 });
    const bot3 = createClient({
      baseUrl: "https://home.invalid",
      userId: BOT_USER,
      deviceId: BOT_DEVICE,
      accessToken: "syt_fake_access_token",
    });
    clients.push(bot3);
    const init3 = await initMatrixCrypto(bot3, { stateDir: wrongDir, logger });
    expect(init3.ok).toBe(false);
  }, 60_000);
});
