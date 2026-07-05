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

  /**
   * Model matrix-js-sdk's `decryptEventIfNeeded`: a decryption is attempted ONLY
   * when a crypto backend is present, it is asynchronous, and it sets the clear
   * data BEFORE it resolves. A realistic still-encrypted event exposes
   * `__applyDecryption` (the crypto backend's effect); a pre-resolved event omits
   * it and this resolves at once. With no crypto backend the event is left
   * m.room.encrypted — exactly the SDK's behaviour.
   */
  decryptEventIfNeeded(event: unknown): Promise<void> {
    const evt = event as { __applyDecryption?: () => void };
    if (this.cryptoPresent && typeof evt.__applyDecryption === "function") {
      return Promise.resolve().then(() => evt.__applyDecryption?.());
    }
    return Promise.resolve();
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
// Fail-closed decrypt in onTimeline
// ---------------------------------------------------------------------------

/** The Matrix WIRE event type an encrypted message carries at timeline-fire time. */
const ENCRYPTED_WIRE_TYPE = "m.room.encrypted";

/**
 * An encrypted event as it ACTUALLY arrives at `RoomEvent.Timeline` time: its type
 * is the `m.room.encrypted` WIRE type. matrix-js-sdk kicks off decryption
 * fire-and-forget and emits the timeline event synchronously BEFORE decryption
 * completes, so `getType()` returns the wire type — NOT the clear `m.room.message`
 * type — at the moment the transport's gate reads it. Decryption is driven by the
 * client (the fake client's `decryptEventIfNeeded` invokes `__applyDecryption`),
 * and only once it runs does `getType()` flip to the clear type — mirroring the
 * SDK, which sets the clear data before the decryption promise resolves. This is
 * the faithful shape the old fakes lacked (they hardcoded the POST-decryption
 * `m.room.message` type, hiding that the gate dropped every encrypted event).
 *
 * `outcome: "ok"` → decrypts to a message with a clear body.
 * `outcome: "fail"` → decrypts to the `m.bad.encrypted` placeholder (a
 *   `m.room.message` clear type) with `decryptionFailureReason` set.
 * With no crypto backend the client never applies decryption, so the event stays
 * `m.room.encrypted` — the "e2ee on but crypto unavailable" state.
 */
function encryptedTimelineEvent(
  over: { ts?: number; outcome?: "ok" | "fail"; body?: string; reason?: string } = {},
): MatrixEvent {
  const {
    ts = 100,
    outcome = "ok",
    body = "decrypted hello",
    reason = "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
  } = over;
  let clearType: string | null = null; // clearEvent.type, set once decrypted
  let failureReason: string | null = null;
  let clearBody: string | undefined;
  return {
    getType: () => clearType ?? ENCRYPTED_WIRE_TYPE, // wire type until decrypted
    getId: () => "$enc",
    getSender: () => "@alice:hs",
    getTs: () => ts,
    getContent: () =>
      clearBody !== undefined
        ? { body: clearBody }
        : { msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" },
    getClearContent: () => (clearBody !== undefined ? { body: clearBody } : null),
    isEncrypted: () => true, // keyed on the WIRE type — true even after decryption
    isBeingDecrypted: () => false,
    getDecryptionPromise: () => null,
    isDecryptionFailure: () => failureReason !== null,
    decryptionFailureReason: failureReason,
    // The crypto backend's decryption effect, invoked by the fake client only when
    // a backend is present; sets the clear data BEFORE resolving, like the SDK's
    // decryptionLoop (success → clear body; failure → placeholder + reason).
    __applyDecryption: (): void => {
      clearType = "m.room.message";
      if (outcome === "ok") clearBody = body;
      else failureReason = reason;
    },
  } as unknown as MatrixEvent;
}

describe("createMatrixClient — fail-closed decrypt in onTimeline", () => {
  it("delivers an event that is still m.room.encrypted at timeline time, once decryption resolves it to a message", async () => {
    // The archetypal receive path: the event fires on the timeline STILL encrypted
    // (its clear type is unknown until decryption completes). The transport must
    // decrypt it before the type gate reads its type, or it is dropped unread.
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", crypto: true, seed: { watermarks: {} } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(
      RoomEvent.Timeline,
      encryptedTimelineEvent({ ts: 100, outcome: "ok", body: "decrypted secret hello" }),
      fakeRoom("!enc:hs"),
      false,
    );

    // The decrypted plaintext surfaced through the SAME mapper as a cleartext event.
    expect(h.received).toHaveLength(1);
    expect(h.received[0]?.text).toBe("decrypted secret hello");
    expect(h.received[0]?.channelId).toBe("!enc:hs");
  });

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

    await h.fake.emit(
      RoomEvent.Timeline,
      encryptedTimelineEvent({ ts: 100, outcome: "fail" }),
      fakeRoom("!enc:hs"),
      false,
    );

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

    await h.fake.emit(
      RoomEvent.Timeline,
      encryptedTimelineEvent({ ts: 100, outcome: "fail" }),
      fakeRoom("!enc:hs"),
      false,
    );

    const dump = JSON.stringify(h.received);
    expect(h.received).toHaveLength(0);
    expect(dump).not.toContain("Unable to decrypt");
    expect(dump).not.toContain("m.bad.encrypted");
  });

  it("logs the decrypt failure with failureReason + roomId only — no ciphertext/body/sender-name", async () => {
    const h = makeCryptoHarness({ e2ee: true, stateDir: "/data/matrix", crypto: true, seed: { watermarks: {} } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(
      RoomEvent.Timeline,
      encryptedTimelineEvent({ ts: 100, outcome: "fail", reason: "MEGOLM_KEY_WITHHELD" }),
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

  it("fail-closes and reports cryptoAvailable:false when e2ee is on but the crypto backend is absent", async () => {
    // e2ee:true but crypto init failed → getCrypto() is undefined, so the event is
    // never decrypted and stays m.room.encrypted. It must still fail-closed (drop +
    // report), NOT be silently swallowed by the type gate.
    const signals: DecryptFailureRecord[] = [];
    const h = makeCryptoHarness({
      e2ee: true,
      stateDir: "/data/matrix",
      crypto: false, // getCrypto() === undefined — the crypto backend is absent
      onDecryptFailure: (s) => signals.push(s as DecryptFailureRecord),
      seed: { watermarks: {} },
    });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(
      RoomEvent.Timeline,
      encryptedTimelineEvent({ ts: 100, outcome: "ok" }),
      fakeRoom("!enc:hs"),
      false,
    );

    expect(h.received).toHaveLength(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.cryptoAvailable).toBe(false);
    expect(signals[0]?.e2eeConfigured).toBe(true);
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
