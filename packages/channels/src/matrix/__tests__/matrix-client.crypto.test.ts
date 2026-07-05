// SPDX-License-Identifier: Apache-2.0
/**
 * Crypto lifecycle + fail-closed decrypt for the Matrix `/sync` transport.
 *
 * The crypto engine (WASM + fake-indexeddb) is NEVER loaded in the unit tier —
 * `initMatrixCrypto` is injected as a spy (`initCryptoImpl`) so the ORDER (crypto
 * before startClient), the gate (untouched on `e2ee:false`), the non-fatal
 * bootstrap fallback, and the fail-closed decrypt branch are all provable from a
 * fake EventEmitter client without a homeserver or any real crypto.
 */
import { describe, it, expect, vi } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import type { NormalizedMessage, ComisLogger } from "@comis/core";
import {
  ClientEvent,
  RoomEvent,
  SyncState,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { createMatrixClient, type MatrixClientDeps } from "../matrix-client.js";
import type { MatrixState, MatrixStateStore } from "../matrix-state.js";
import type { MatrixCryptoHandle } from "../crypto-store.js";

/** The decrypt-failure signal shape (structural — no import of the SUT type). */
interface DecryptFailureRecord {
  roomId: string;
  e2eeConfigured: boolean;
  cryptoAvailable: boolean;
  failureReason: string | null;
}

/** A recording state store: load() yields the seed; save() records every arg. */
function makeStateStore(seed: Partial<MatrixState> = {}): {
  store: MatrixStateStore;
  saves: MatrixState[];
} {
  const saves: MatrixState[] = [];
  const current: MatrixState = { watermarks: {}, ...seed };
  const store: MatrixStateStore = {
    load: async () => ok({ ...current }),
    save: async (state: MatrixState) => {
      saves.push({ ...state });
      return ok(undefined);
    },
  };
  return { store, saves };
}

/** A logger whose calls the test inspects for step/errorKind/hint and secret leaks. */
function makeLogger(): ComisLogger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as ComisLogger;
}

/** A no-op crypto handle (the shape `initMatrixCrypto` resolves to). */
function fakeCryptoHandle(): MatrixCryptoHandle {
  return {
    scheduleSnapshot: vi.fn(),
    snapshotNow: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/** A minimal room; the crypto path only reads its id. */
function fakeRoom(roomId: string): Room {
  return { roomId, getMember: () => null } as unknown as Room;
}

/**
 * An EventEmitter-like fake matrix-js-sdk client that records start/stop calls
 * and pushes a `startClient` marker into a shared call-log so the crypto-init
 * ORDERING (crypto before startClient) is assertable. `getCrypto()` returns a
 * truthy handle only when `crypto:true` — the cryptoAvailable signal input.
 */
class FakeCryptoClient {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  readonly startCalls: unknown[] = [];
  stopCalls = 0;
  private token: string | null = null;
  readonly store = {
    getSyncToken: (): string | null => this.token,
    setSyncToken: (t: string | null): void => {
      this.token = t;
    },
  };

  constructor(
    private readonly callLog: string[],
    private readonly cryptoPresent: boolean,
  ) {}

  on(event: string, handler: (...args: unknown[]) => unknown): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(...args);
  }

  startClient(opts?: unknown): Promise<void> {
    this.callLog.push("startClient");
    this.startCalls.push(opts ?? {});
    return Promise.resolve();
  }

  stopClient(): void {
    this.stopCalls += 1;
  }

  getUserId(): string | null {
    return "@bot:hs";
  }

  getCrypto(): unknown {
    return this.cryptoPresent ? {} : undefined;
  }

  joinRoom(roomId: string): Promise<unknown> {
    return Promise.resolve({ roomId });
  }

  asClient(): MatrixClient {
    return this as unknown as MatrixClient;
  }
}

interface CryptoHarnessOverrides {
  e2ee?: boolean;
  stateDir?: string;
  recoveryKey?: string;
  crypto?: boolean;
  /** The Result the injected initMatrixCrypto spy resolves to (default: ok(handle)). */
  cryptoResult?: Result<MatrixCryptoHandle, Error>;
  onDecryptFailure?: (signal: unknown) => void;
  seed?: Partial<MatrixState>;
}

function makeCryptoHarness(over: CryptoHarnessOverrides = {}): {
  fake: FakeCryptoClient;
  saves: MatrixState[];
  logger: ComisLogger;
  received: NormalizedMessage[];
  controller: ReturnType<typeof createMatrixClient>;
  callLog: string[];
  initCryptoImpl: ReturnType<typeof vi.fn>;
} {
  const callLog: string[] = [];
  const fake = new FakeCryptoClient(callLog, over.crypto ?? false);
  const { store, saves } = makeStateStore(over.seed);
  const logger = makeLogger();
  const received: NormalizedMessage[] = [];

  // The injected crypto bootstrap: records the call ORDER, forwards its args for
  // inspection, and resolves to the configured Result (ok(handle) by default).
  const initCryptoImpl = vi.fn(async () => {
    callLog.push("initCrypto");
    return over.cryptoResult ?? ok(fakeCryptoHandle());
  });

  const deps: MatrixClientDeps = {
    client: fake.asClient(),
    stateStore: store,
    autoJoinOnInvite: false,
    allowMode: "open",
    allowFrom: [],
    onMessage: (m: NormalizedMessage) => {
      received.push(m);
    },
    logger,
    initCryptoImpl: initCryptoImpl as unknown as MatrixClientDeps["initCryptoImpl"],
    ...(over.e2ee !== undefined ? { e2ee: over.e2ee } : {}),
    ...(over.stateDir !== undefined ? { stateDir: over.stateDir } : {}),
    ...(over.recoveryKey !== undefined ? { recoveryKey: over.recoveryKey } : {}),
    ...(over.onDecryptFailure !== undefined
      ? { onDecryptFailure: over.onDecryptFailure as MatrixClientDeps["onDecryptFailure"] }
      : {}),
  };
  const controller = createMatrixClient(deps);
  return { fake, saves, logger, received, controller, callLog, initCryptoImpl };
}

describe("createMatrixClient — E2EE crypto bootstrap before startClient (E2EE-01)", () => {
  it("runs initMatrixCrypto BEFORE startClient on the e2ee path and forwards stateDir + recoveryKey", async () => {
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", recoveryKey: "recov-key" });

    const started = await h.controller.start();

    expect(started.ok).toBe(true);
    // The crypto store is bootstrapped before /sync starts, so the rust engine
    // can decrypt inbound events from the very first sync batch.
    expect(h.callLog).toEqual(["initCrypto", "startClient"]);
    expect(h.initCryptoImpl).toHaveBeenCalledTimes(1);
    // stateDir + recoveryKey are threaded into the crypto bootstrap deps.
    const cryptoDeps = h.initCryptoImpl.mock.calls[0]?.[1] as { stateDir?: string; recoveryKey?: string };
    expect(cryptoDeps.stateDir).toBe("/data/matrix");
    expect(cryptoDeps.recoveryKey).toBe("recov-key");
  });

  it("never touches the crypto path when e2ee is false — the plaintext path is untouched", async () => {
    const h = makeCryptoHarness({ e2ee: false, stateDir: "/data/matrix" });

    const started = await h.controller.start();

    expect(started.ok).toBe(true);
    expect(h.initCryptoImpl).not.toHaveBeenCalled();
    // startClient still runs; the plaintext lifecycle is unchanged.
    expect(h.callLog).toEqual(["startClient"]);
  });

  it("never touches the crypto path when e2ee is omitted entirely", async () => {
    const h = makeCryptoHarness({ stateDir: "/data/matrix" });

    await h.controller.start();

    expect(h.initCryptoImpl).not.toHaveBeenCalled();
    expect(h.callLog).toEqual(["startClient"]);
  });

  it("runs unverified with a loud warning when crypto bootstrap fails — never bricks /sync (D3)", async () => {
    const h = makeCryptoHarness({
      e2ee: true,
      stateDir: "/data/matrix",
      cryptoResult: err(new Error("crypto backend unavailable")),
    });

    const started = await h.controller.start();

    // The channel runs UNVERIFIED, not dark: /sync still starts, start() is ok.
    expect(started.ok).toBe(true);
    expect(h.callLog).toContain("startClient");
    // A loud, actionable WARN on the crypto-init step: errorKind + a remedy hint.
    const warn = vi
      .mocked(h.logger.warn)
      .mock.calls.find((c) => (c[0] as { step?: string })?.step === "crypto-init");
    expect(warn).toBeDefined();
    expect((warn?.[0] as { errorKind?: string }).errorKind).toBeDefined();
    expect((warn?.[0] as { hint?: string }).hint).toMatch(/recoveryKey|verify|unverified/i);
  });

  it("never writes the recoveryKey to any log line (T-4)", async () => {
    const h = makeCryptoHarness({
      e2ee: true,
      stateDir: "/data/matrix",
      recoveryKey: "super-secret-recovery-key-xyz",
    });

    await h.controller.start();

    const dump = JSON.stringify([
      vi.mocked(h.logger.info).mock.calls,
      vi.mocked(h.logger.warn).mock.calls,
      vi.mocked(h.logger.error).mock.calls,
      vi.mocked(h.logger.debug).mock.calls,
    ]);
    expect(dump).not.toContain("super-secret-recovery-key-xyz");
  });
});

// ---------------------------------------------------------------------------
// Task 2: fail-closed decrypt in onTimeline (T-5)
// ---------------------------------------------------------------------------

/**
 * A decrypt-FAILED encrypted event, modelled faithfully on matrix-js-sdk: on a
 * decryption failure the SDK sets a `m.room.message` clear event whose body is
 * the "** Unable to decrypt **" placeholder — so a failed event PASSES the
 * watermark gate (its clear type is `m.room.message`) and WOULD surface that
 * garbage as message text if the fail-closed branch did not drop it first.
 */
function encryptedFailedEvent(over: { ts?: number; reason?: string } = {}): MatrixEvent {
  const { ts = 100, reason = "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" } = over;
  return {
    getType: () => "m.room.message",
    getId: () => "$enc-fail",
    getSender: () => "@alice:hs",
    getTs: () => ts,
    // the SDK's synthesized placeholder — this ciphertext-garbage must NEVER surface
    getContent: () => ({ msgtype: "m.bad.encrypted", body: `** Unable to decrypt: ${reason} **` }),
    getClearContent: () => null,
    isEncrypted: () => true,
    isBeingDecrypted: () => false,
    getDecryptionPromise: () => null,
    isDecryptionFailure: () => true,
    decryptionFailureReason: reason,
  } as unknown as MatrixEvent;
}

/** A decrypt-OK encrypted event: getContent returns the CLEAR body once decrypted. */
function encryptedOkEvent(over: { ts?: number; body?: string } = {}): MatrixEvent {
  const { ts = 100, body = "decrypted hello" } = over;
  return {
    getType: () => "m.room.message",
    getId: () => "$enc-ok",
    getSender: () => "@alice:hs",
    getTs: () => ts,
    getContent: () => ({ body }),
    getClearContent: () => ({ body }),
    isEncrypted: () => true,
    isBeingDecrypted: () => false,
    getDecryptionPromise: () => null,
    isDecryptionFailure: () => false,
    decryptionFailureReason: null,
  } as unknown as MatrixEvent;
}

describe("createMatrixClient — fail-closed decrypt in onTimeline (T-5)", () => {
  it("drops an undecryptable encrypted event: never delivered, reported via onDecryptFailure, watermark advanced", async () => {
    const signals: DecryptFailureRecord[] = [];
    const h = makeCryptoHarness({
      e2ee: true,
      stateDir: "/data/matrix",
      crypto: true,
      onDecryptFailure: (s) => signals.push(s as DecryptFailureRecord),
      seed: { watermarks: {} },
    });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(RoomEvent.Timeline, encryptedFailedEvent({ ts: 100 }), fakeRoom("!enc:hs"), false);

    // FAIL CLOSED: the mapper is never reached, onMessage never fires.
    expect(h.received).toHaveLength(0);
    // The raw signal is handed to the degrade seam exactly once.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      roomId: "!enc:hs",
      e2eeConfigured: true,
      cryptoAvailable: true,
      failureReason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
    });
    // The watermark still advances so the undecryptable event is not reprocessed.
    expect(h.saves.some((s) => s.watermarks["!enc:hs"] === 100)).toBe(true);
  });

  it("never surfaces the m.bad.encrypted placeholder body as message text", async () => {
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", crypto: true, seed: { watermarks: {} } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(RoomEvent.Timeline, encryptedFailedEvent({ ts: 100 }), fakeRoom("!enc:hs"), false);

    const dump = JSON.stringify(h.received);
    expect(h.received).toHaveLength(0);
    expect(dump).not.toContain("Unable to decrypt");
    expect(dump).not.toContain("m.bad.encrypted");
  });

  it("maps a successfully-decrypted encrypted event transparently through to onMessage", async () => {
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", crypto: true, seed: { watermarks: {} } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(
      RoomEvent.Timeline,
      encryptedOkEvent({ ts: 100, body: "decrypted secret hello" }),
      fakeRoom("!enc:hs"),
      false,
    );

    expect(h.received).toHaveLength(1);
    expect(h.received[0]?.text).toBe("decrypted secret hello");
    expect(h.received[0]?.channelId).toBe("!enc:hs");
  });

  it("awaits an in-flight decryption before branching (isBeingDecrypted → getDecryptionPromise)", async () => {
    let resolved = false;
    const pending = Promise.resolve().then(() => {
      resolved = true;
    });
    const event = {
      getType: () => "m.room.message",
      getId: () => "$pending",
      getSender: () => "@alice:hs",
      getTs: () => 100,
      getContent: () => ({ body: "late-decrypt" }),
      getClearContent: () => ({ body: "late-decrypt" }),
      isEncrypted: () => true,
      isBeingDecrypted: () => true,
      getDecryptionPromise: () => pending,
      isDecryptionFailure: () => false,
      decryptionFailureReason: null,
    } as unknown as MatrixEvent;
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", crypto: true, seed: { watermarks: {} } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(RoomEvent.Timeline, event, fakeRoom("!enc:hs"), false);

    // The decryption promise was awaited (Pitfall 4) before the message was mapped.
    expect(resolved).toBe(true);
    expect(h.received).toHaveLength(1);
    expect(h.received[0]?.text).toBe("late-decrypt");
  });

  it("logs the decrypt failure with failureReason + roomId only — no ciphertext/body/sender-name", async () => {
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", crypto: true, seed: { watermarks: {} } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(
      RoomEvent.Timeline,
      encryptedFailedEvent({ ts: 100, reason: "MEGOLM_KEY_WITHHELD" }),
      fakeRoom("!enc:hs"),
      false,
    );

    const warn = vi
      .mocked(h.logger.warn)
      .mock.calls.find((c) => (c[0] as { step?: string })?.step === "decrypt");
    expect(warn).toBeDefined();
    const fields = warn?.[0] as Record<string, unknown>;
    expect(fields.failureReason).toBe("MEGOLM_KEY_WITHHELD");
    expect(fields.roomId).toBe("!enc:hs");
    const dump = JSON.stringify(warn);
    expect(dump).not.toContain("Unable to decrypt");
    expect(dump).not.toContain("m.bad.encrypted");
  });

  it("reports cryptoAvailable:false when e2ee is on but the crypto backend is absent", async () => {
    const signals: DecryptFailureRecord[] = [];
    const h = makeCryptoHarness({
      e2ee: true,
      stateDir: "/data/matrix",
      crypto: false, // getCrypto() === undefined
      onDecryptFailure: (s) => signals.push(s as DecryptFailureRecord),
      seed: { watermarks: {} },
    });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(RoomEvent.Timeline, encryptedFailedEvent({ ts: 100 }), fakeRoom("!enc:hs"), false);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.cryptoAvailable).toBe(false);
    expect(signals[0]?.e2eeConfigured).toBe(true);
    expect(h.received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /sync filter widens to encrypted wire events on the e2ee path (E2EE-01)
// ---------------------------------------------------------------------------

/** Read the timeline `types` of the filter passed to the first startClient call. */
function startFilterTypes(fake: FakeCryptoClient): string[] {
  const opts = fake.startCalls[0] as { filter?: { getDefinition(): unknown } } | undefined;
  const def = opts?.filter?.getDefinition() as
    | { room?: { timeline?: { types?: string[] } } }
    | undefined;
  return def?.room?.timeline?.types ?? [];
}

describe("createMatrixClient — /sync filter includes encrypted wire events on the e2ee path (E2EE-01)", () => {
  it("adds m.room.encrypted to the sync filter when e2ee is on, so encrypted wire events are delivered to the timeline handler", async () => {
    // The server-side filter keys on the WIRE type; an encrypted message arrives as
    // an m.room.encrypted wire event (its clear type only becomes m.room.message
    // after local decryption). Without this widening the homeserver never returns
    // encrypted events, so the crypto engine + fail-closed branch see nothing.
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", crypto: true });

    await h.controller.start();

    const types = startFilterTypes(h.fake);
    expect(types).toContain("m.room.encrypted");
    expect(types).toContain("m.room.message");
  });

  it("keeps the plaintext sync filter scoped to m.room.message only", async () => {
    const h = makeCryptoHarness({ stateDir: "/data/matrix" }); // e2ee omitted

    await h.controller.start();

    // The plaintext path is unchanged — no encrypted wire events requested.
    expect(startFilterTypes(h.fake)).toEqual(["m.room.message"]);
  });
});
