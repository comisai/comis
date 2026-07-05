// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ComisLogger, NormalizedMessage } from "@comis/core";
import {
  ClientEvent,
  RoomEvent,
  SyncState,
  type ICreateClientOpts,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import * as sdk from "matrix-js-sdk";
import { createMatrixAdapter, type MatrixAdapterDeps } from "../matrix-adapter.js";

// ---------------------------------------------------------------------------
// Temp stateDir (real fs, per-test, cleaned up) — mirrors matrix-state.test.ts.
// ---------------------------------------------------------------------------

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-adapter-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as ComisLogger;
}

/** A minimal m.room.message-shaped timeline event. */
function fakeEvent(
  overrides: { type?: string; id?: string; sender?: string; ts?: number; body?: string } = {},
): MatrixEvent {
  const { type = "m.room.message", id = "$evt1", sender = "@alice:hs", ts = 100, body = "hi" } =
    overrides;
  return {
    getType: () => type,
    getId: () => id,
    getSender: () => sender,
    getTs: () => ts,
    getContent: () => ({ body }),
    // Plaintext: the decrypt branch (T-5) is skipped for a non-encrypted event.
    isEncrypted: () => false,
  } as unknown as MatrixEvent;
}

/**
 * A decrypt-FAILED encrypted event as it ACTUALLY arrives on the timeline: still
 * the `m.room.encrypted` WIRE type. Decryption is driven by the client (its
 * `decryptEventIfNeeded` invokes `__applyDecryption`) and, mirroring matrix-js-sdk,
 * resolves to a `m.room.message` clear type carrying the "** Unable to decrypt **"
 * placeholder with `decryptionFailureReason` set — the fail-closed branch drops it
 * and hands the raw signal to the adapter's degrade decider.
 */
function fakeEncryptedFailEvent(
  overrides: { reason?: string; ts?: number; sender?: string; id?: string } = {},
): MatrixEvent {
  const {
    reason = "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
    ts = 200,
    sender = "@someone:hs",
    id = "$enc1",
  } = overrides;
  let clearType: string | null = null;
  let failureReason: string | null = null;
  return {
    getType: () => clearType ?? "m.room.encrypted", // wire type until decrypted
    getId: () => id,
    getSender: () => sender,
    getTs: () => ts,
    getContent: () => ({ msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" }),
    getClearContent: () => null,
    isEncrypted: () => true,
    isBeingDecrypted: () => false,
    getDecryptionPromise: () => null,
    isDecryptionFailure: () => failureReason !== null,
    // A getter (as in the SDK) so it reflects the post-decryption state.
    get decryptionFailureReason() {
      return failureReason;
    },
    // The crypto backend's decryption effect: sets the clear data before resolving.
    __applyDecryption: (): void => {
      clearType = "m.room.message";
      failureReason = reason;
    },
  } as unknown as MatrixEvent;
}

/** A minimal room whose id is the routing channelId. */
function fakeRoom(roomId: string): Room {
  return {
    roomId,
    getMember: () => null,
  } as unknown as Room;
}

/** Build an Error carrying Matrix `errcode`/`httpStatus`, like the SDK's MatrixError. */
function matrixError(errcode: string, httpStatus: number, message: string): Error {
  const e = new Error(message) as Error & { errcode: string; httpStatus: number };
  e.errcode = errcode;
  e.httpStatus = httpStatus;
  return e;
}

/**
 * A single fake matrix-js-sdk client that satisfies BOTH the auth lifecycle
 * (whoami/login) AND the /sync controller (on/startClient/stopClient/getUserId/
 * store/joinRoom) AND the adapter's outbound send (sendEvent). The adapter and
 * its composed modules all drive this one instance, and the test drives its
 * `emit` to inject inbound timeline batches.
 */
class FakeMatrixClient {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  readonly sentEvents: Array<{ roomId: string; eventType: string; content: Record<string, unknown> }> =
    [];
  startCalls = 0;
  stopCalls = 0;
  whoamiCalls = 0;
  sendError?: unknown;
  startError?: unknown;
  whoamiError?: unknown;
  /** Password-login recorder + a counter so each login mints a DISTINCT token. */
  readonly loginCalls: Array<{ type: string; data: Record<string, unknown> }> = [];
  loginCount = 0;
  /** Tokens applied to the live client via setAccessToken (token-recovery). */
  readonly appliedAccessTokens: string[] = [];
  /** The `m.direct` account-data content the client reports (other MXID → room ids). */
  directContent?: Record<string, string[]>;
  /** The handle getCrypto() reports; undefined = crypto backend absent. */
  cryptoHandle?: object;
  private token: string | null = null;
  private readonly userId: string;
  readonly store: { getSyncToken(): string | null; setSyncToken(token: string): void };

  constructor(userId = "@bot:hs") {
    this.userId = userId;
    const self = this;
    this.store = {
      getSyncToken: () => self.token,
      setSyncToken: (t: string) => {
        self.token = t;
      },
    };
  }

  async whoami(): Promise<{ user_id: string; device_id: string }> {
    this.whoamiCalls += 1;
    if (this.whoamiError !== undefined) throw this.whoamiError;
    return { user_id: this.userId, device_id: "DEV1" };
  }

  on(event: string, handler: (...args: unknown[]) => unknown): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  /** Emit an event and await every registered handler (deterministic). */
  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(...args);
    }
  }

  startClient(opts?: { initialSyncLimit?: number; filter?: unknown }): Promise<void> {
    void opts;
    this.startCalls += 1;
    if (this.startError !== undefined) return Promise.reject(this.startError);
    return Promise.resolve();
  }

  stopClient(): void {
    this.stopCalls += 1;
  }

  getUserId(): string | null {
    return this.userId;
  }

  /** The crypto backend the fail-closed decrypt branch probes for cryptoAvailable. */
  getCrypto(): object | undefined {
    return this.cryptoHandle;
  }

  /**
   * Model matrix-js-sdk's `decryptEventIfNeeded`: decryption is attempted only when
   * a crypto backend is present, is async, and sets the clear data before it
   * resolves (via the event's `__applyDecryption` hook). With no backend the event
   * is left `m.room.encrypted`.
   */
  decryptEventIfNeeded(event: unknown): Promise<void> {
    const evt = event as { __applyDecryption?: () => void };
    if (this.cryptoHandle !== undefined && typeof evt.__applyDecryption === "function") {
      return Promise.resolve().then(() => evt.__applyDecryption?.());
    }
    return Promise.resolve();
  }

  /** The m.direct account-data lookup the adapter's DM classifier reads. */
  getAccountData(type: string): { getContent: () => Record<string, unknown> } | undefined {
    if (type === "m.direct" && this.directContent !== undefined) {
      const content = this.directContent;
      return { getContent: () => content };
    }
    return undefined;
  }

  joinRoom(roomIdOrAlias: string): Promise<unknown> {
    return Promise.resolve({ roomId: roomIdOrAlias });
  }

  sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<{ event_id: string }> {
    if (this.sendError !== undefined) return Promise.reject(this.sendError);
    this.sentEvents.push({ roomId, eventType, content });
    return Promise.resolve({ event_id: "$sent1" });
  }

  async login(
    type: string,
    data: Record<string, unknown>,
  ): Promise<{ access_token: string; device_id: string; user_id: string }> {
    this.loginCalls.push({ type, data });
    this.loginCount += 1;
    // A DISTINCT token per login so a test can tell a fresh re-login token
    // (srv-token-2) from the initial one (srv-token-1). Device id stays stable.
    return { access_token: `srv-token-${this.loginCount}`, device_id: "DEV1", user_id: this.userId };
  }

  setAccessToken(token: string): void {
    this.appliedAccessTokens.push(token);
  }

  asClient(): MatrixClient {
    return this as unknown as MatrixClient;
  }
}

interface HarnessOverrides {
  homeserverUrl?: string;
  allowPrivateHomeserver?: boolean;
  allowFrom?: string[];
  allowMode?: "allowlist" | "open";
  accessToken?: string;
  password?: string;
  userId?: string;
  emitHealth?: (signal: { errorKind: string; hint: string }) => void;
  emitDecryptHealth?: (signal: { roomId: string; reason: string }) => void;
  fake?: FakeMatrixClient;
}

function makeAdapter(over: HarnessOverrides = {}): {
  adapter: ReturnType<typeof createMatrixAdapter>;
  fake: FakeMatrixClient;
  logger: ComisLogger;
  received: NormalizedMessage[];
  stateDir: string;
} {
  const fake = over.fake ?? new FakeMatrixClient();
  const logger = makeLogger();
  const received: NormalizedMessage[] = [];
  const createClientImpl = (_opts: ICreateClientOpts): MatrixClient => fake.asClient();
  const stateDir = tempDir();
  // With a password set the adapter takes the password path (no configured token);
  // otherwise default to a token so the existing token-path tests are unchanged.
  const accessToken = over.accessToken ?? (over.password !== undefined ? undefined : "token-abc");

  const deps: MatrixAdapterDeps = {
    homeserverUrl: over.homeserverUrl ?? "http://127.0.0.1:8008",
    userId: over.userId ?? "@bot:hs",
    stateDir,
    allowFrom: over.allowFrom ?? [],
    allowMode: over.allowMode ?? "allowlist",
    autoJoinOnInvite: true,
    allowPrivateHomeserver: over.allowPrivateHomeserver ?? true,
    logger,
    createClientImpl: createClientImpl as unknown as typeof sdk.createClient,
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(over.password !== undefined ? { password: over.password } : {}),
    ...(over.emitHealth !== undefined ? { emitHealth: over.emitHealth } : {}),
    ...(over.emitDecryptHealth !== undefined ? { emitDecryptHealth: over.emitDecryptHealth } : {}),
  };

  const adapter = createMatrixAdapter(deps);
  adapter.onMessage((m) => {
    received.push(m);
  });
  return { adapter, fake, logger, received, stateDir };
}

/** Bring an adapter up and push one inbound timeline event through it. */
async function deliver(
  fake: FakeMatrixClient,
  event: MatrixEvent,
  room: Room = fakeRoom("!room:hs"),
): Promise<void> {
  await fake.emit(ClientEvent.Sync, SyncState.Prepared, null);
  await fake.emit(RoomEvent.Timeline, event, room, false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMatrixAdapter", () => {
  it("reports channelId and channelType matrix and a polling connectionMode", () => {
    const { adapter } = makeAdapter();
    expect(adapter.channelId).toBe("matrix");
    expect(adapter.channelType).toBe("matrix");
    const status = adapter.getStatus?.();
    expect(status?.channelId).toBe("matrix");
    expect(status?.channelType).toBe("matrix");
    expect(status?.connectionMode).toBe("polling");
  });

  it("refuses to start against a private homeserver when allowPrivateHomeserver is false (SEC-01)", async () => {
    const { adapter, fake } = makeAdapter({
      homeserverUrl: "http://10.0.0.1:8008",
      allowPrivateHomeserver: false,
    });

    const result = await adapter.start();

    expect(result.ok).toBe(false);
    // The homeserver guard runs BEFORE any connect: the client is never built.
    expect(fake.whoamiCalls).toBe(0);
    expect(fake.startCalls).toBe(0);
    expect(adapter.getStatus?.().connected).toBe(false);
  });

  it("refuses to start when neither an access token nor a password is configured", async () => {
    const { adapter, fake } = makeAdapter({ accessToken: "" });

    const result = await adapter.start();

    expect(result.ok).toBe(false);
    expect(fake.whoamiCalls).toBe(0);
  });

  it("validates the homeserver, authenticates, and starts the sync client on a valid config", async () => {
    const { adapter, fake } = makeAdapter();

    const result = await adapter.start();

    expect(result.ok).toBe(true);
    expect(fake.whoamiCalls).toBe(1);
    expect(fake.startCalls).toBe(1);
    expect(adapter.getStatus?.().connected).toBe(true);
  });

  it("delivers an inbound message to onMessage when allowFrom is empty (speaker gate default-open)", async () => {
    const { adapter, fake, received } = makeAdapter({ allowFrom: [], allowMode: "allowlist" });
    await adapter.start();

    await deliver(fake, fakeEvent({ sender: "@stranger:hs", body: "hello" }));

    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("@stranger:hs");
    expect(received[0]?.text).toBe("hello");
    expect(received[0]?.channelId).toBe("!room:hs");
  });

  it("delivers an inbound message from an allowlisted MXID when allowFrom is populated", async () => {
    const { adapter, fake, received } = makeAdapter({
      allowFrom: ["@a:hs"],
      allowMode: "allowlist",
    });
    await adapter.start();

    await deliver(fake, fakeEvent({ sender: "@a:hs", body: "permitted" }));

    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("@a:hs");
  });

  it("maps a room listed in m.direct account data to chatType dm", async () => {
    const fake = new FakeMatrixClient();
    // The homeserver marks !dm:hs a direct (1:1) room with @alice:hs.
    fake.directContent = { "@alice:hs": ["!dm:hs"] };
    const { adapter, received } = makeAdapter({ fake, allowFrom: [] });
    await adapter.start();

    await deliver(fake, fakeEvent({ sender: "@alice:hs", body: "dm hi" }), fakeRoom("!dm:hs"));

    expect(received).toHaveLength(1);
    expect(received[0]?.chatType).toBe("dm");
  });

  it("maps a room absent from m.direct account data to chatType group", async () => {
    const fake = new FakeMatrixClient();
    // m.direct lists a DIFFERENT room — the delivered room is not a DM.
    fake.directContent = { "@carol:hs": ["!elsewhere:hs"] };
    const { adapter, received } = makeAdapter({ fake, allowFrom: [] });
    await adapter.start();

    await deliver(fake, fakeEvent({ sender: "@alice:hs", body: "room hi" }), fakeRoom("!room:hs"));

    expect(received).toHaveLength(1);
    expect(received[0]?.chatType).toBe("group");
  });

  it("drops an inbound message from a non-allowlisted MXID when allowFrom is populated", async () => {
    const { adapter, fake, received, logger } = makeAdapter({
      allowFrom: ["@a:hs"],
      allowMode: "allowlist",
    });
    await adapter.start();

    await deliver(fake, fakeEvent({ sender: "@b:hs", body: "blocked" }));

    expect(received).toHaveLength(0);
    const warn = vi.mocked(logger.warn);
    const dropped = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "precondition",
    );
    expect(dropped).toBeDefined();
  });

  it("sends an m.room.message whose content carries body plus an org.matrix.custom.html formatted_body", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "**hi**");

    expect(result.ok).toBe(true);
    expect(fake.sentEvents).toHaveLength(1);
    const [sent] = fake.sentEvents;
    expect(sent?.roomId).toBe("!room:hs");
    expect(sent?.eventType).toBe("m.room.message");
    expect(sent?.content.msgtype).toBe("m.text");
    expect(sent?.content.body).toBe("**hi**");
    expect(sent?.content.format).toBe("org.matrix.custom.html");
    expect(sent?.content.formatted_body).toContain("<strong>hi</strong>");
  });

  it("errs on sendMessage before start rather than dereferencing an absent client", async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.sendMessage("!room:hs", "hi");

    expect(result.ok).toBe(false);
  });

  it("tears the sync client down on stop and reports disconnected", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.stop();

    expect(result.ok).toBe(true);
    expect(fake.stopCalls).toBe(1);
    expect(adapter.getStatus?.().connected).toBe(false);
  });

  it("propagates a send failure as err with a platform errorKind hint", async () => {
    const fake = new FakeMatrixClient();
    fake.sendError = new Error("forbidden in room");
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "hi");

    expect(result.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const platformWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "platform",
    );
    expect(platformWarn).toBeDefined();
  });

  it("errs from start when the token fails whoami validation (auth failure)", async () => {
    const fake = new FakeMatrixClient();
    fake.whoamiError = new Error("token rejected");
    const { adapter } = makeAdapter({ fake });

    const result = await adapter.start();

    expect(result.ok).toBe(false);
    expect(fake.startCalls).toBe(0);
    expect(adapter.getStatus?.().connected).toBe(false);
  });

  it("errs from start when the sync client fails to start and reports disconnected", async () => {
    const fake = new FakeMatrixClient();
    fake.startError = new Error("sync boom");
    const { adapter } = makeAdapter({ fake });

    const result = await adapter.start();

    expect(result.ok).toBe(false);
    expect(adapter.getStatus?.().connected).toBe(false);
  });

  it("errs on an unsupported platformAction with a validation hint", async () => {
    const { adapter, logger } = makeAdapter();

    const result = await adapter.platformAction("pin", {});

    expect(result.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const actionWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "validation",
    );
    expect(actionWarn).toBeDefined();
  });

  it("logs a synchronously-throwing and an async-rejecting inbound handler without aborting siblings", async () => {
    // The collector handler is registered first by makeAdapter; a handler that
    // throws synchronously (outer catch) and one that rejects asynchronously
    // (the .catch arrow) must both be caught and logged without aborting the
    // sibling delivery.
    const { adapter, fake, received, logger } = makeAdapter({ allowFrom: [] });
    adapter.onMessage(() => {
      throw new Error("handler boom");
    });
    adapter.onMessage(() => Promise.reject(new Error("async handler boom")));
    await adapter.start();

    await deliver(fake, fakeEvent({ sender: "@x:hs", body: "hey" }));
    // Flush the microtask the rejected-promise .catch is scheduled on.
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it("re-logins, persists the fresh token+deviceId, and resumes with the new token on a mid-run token expiry when a password is configured", async () => {
    // CORE-02: the adapter must WIRE the reauthenticate seam into the /sync
    // controller. On a mid-run M_UNKNOWN_TOKEN it re-logins with the password,
    // applies the fresh token to the LIVE client, persists it, and resumes — not
    // just a raw log. Fails on pre-fix code (the adapter passes no seam).
    const fake = new FakeMatrixClient();
    const { adapter, stateDir } = makeAdapter({ fake, password: "pw-secret", allowFrom: [] });
    const started = await adapter.start();
    expect(started.ok).toBe(true);
    // Initial password login happened once; the adapter is syncing.
    expect(fake.loginCalls).toHaveLength(1);
    const startsBefore = fake.startCalls;

    // A mid-run token expiry arrives on the sync stream.
    await fake.emit(ClientEvent.Sync, SyncState.Error, SyncState.Syncing, {
      error: matrixError("M_UNKNOWN_TOKEN", 401, "token expired mid-run"),
    });

    // The reauthenticate seam ran a FRESH password login ...
    expect(fake.loginCalls).toHaveLength(2);
    // ... applied the new token to the live client and resumed syncing ...
    expect(fake.appliedAccessTokens).toContain("srv-token-2");
    expect(fake.startCalls).toBeGreaterThan(startsBefore);
    // ... and persisted the fresh token + device id for the next boot.
    const persisted = JSON.parse(
      fs.readFileSync(path.join(stateDir, "sync-state.json"), "utf-8"),
    ) as { accessToken?: string; deviceId?: string };
    expect(persisted.accessToken).toBe("srv-token-2");
    expect(persisted.deviceId).toBe("DEV1");
  });

  it("emits a loud health event naming channels.matrix.accessToken and does not go silently dark when no password is configured", async () => {
    // CORE-02: with no password there is no re-login, so the adapter must WIRE the
    // emitHealth seam and surface a loud, secret-free health event (+ ERROR) that
    // names the exact knob — never a silent stop. Fails on pre-fix code (the
    // adapter passes no emitHealth, so the health event is a no-op).
    const healthSignals: Array<{ errorKind: string; hint: string }> = [];
    const fake = new FakeMatrixClient();
    const { adapter, logger } = makeAdapter({
      fake,
      accessToken: "token-abc", // token-only, NO password
      emitHealth: (signal) => healthSignals.push(signal),
    });
    await adapter.start();

    await fake.emit(ClientEvent.Sync, SyncState.Error, SyncState.Syncing, {
      error: matrixError("M_UNKNOWN_TOKEN", 401, "token revoked"),
    });

    // No re-login was attempted (no password) ...
    expect(fake.loginCalls).toHaveLength(0);
    // ... a loud health event fired, naming the exact operator knob ...
    expect(healthSignals).toHaveLength(1);
    expect(healthSignals[0]?.errorKind).toBe("auth");
    expect(healthSignals[0]?.hint).toContain("channels.matrix.accessToken");
    // ... a loud ERROR was logged, and the channel is NOT silently torn down.
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(fake.stopCalls).toBe(0);
    expect(adapter.getStatus?.().connected).toBe(true);
  });
});

describe("createMatrixAdapter — decrypt degrade note (E2EE-03)", () => {
  it("synthesizes one cause-correct degrade note and fans it out past the speaker gate", async () => {
    // A non-empty allowlist that admits no real speaker (and not the system note's
    // sender) — the note must still arrive, proving it bypasses isAllowedSpeaker.
    const { adapter, fake, received } = makeAdapter({
      allowFrom: ["@nobody:hs"],
      allowMode: "allowlist",
    });
    fake.cryptoHandle = {}; // getCrypto() truthy → cryptoAvailable in the signal
    await adapter.start();

    await deliver(
      fake,
      fakeEncryptedFailEvent({ reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID", ts: 201 }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.channelId).toBe("!room:hs");
    // The missing_session hint, not the raw ciphertext placeholder.
    expect(received[0]?.text).toContain("re-invite");
    expect(received[0]?.text).not.toContain("Unable to decrypt");
  });

  it("fires the degrade note once per room per cause, re-firing only when the cause class changes", async () => {
    const { adapter, fake, received } = makeAdapter({ allowFrom: [], allowMode: "allowlist" });
    fake.cryptoHandle = {};
    await adapter.start();
    await fake.emit(ClientEvent.Sync, SyncState.Prepared, null);

    // First failure (missing_session) → fires.
    await fake.emit(
      RoomEvent.Timeline,
      fakeEncryptedFailEvent({ reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID", ts: 201 }),
      fakeRoom("!room:hs"),
      false,
    );
    // Same room, same cause → suppressed (increasing ts clears the watermark gate).
    await fake.emit(
      RoomEvent.Timeline,
      fakeEncryptedFailEvent({ reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID", ts: 202 }),
      fakeRoom("!room:hs"),
      false,
    );
    expect(received).toHaveLength(1);

    // Same room, DIFFERENT cause class (unverified_device) → re-fires.
    await fake.emit(
      RoomEvent.Timeline,
      fakeEncryptedFailEvent({ reason: "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE", ts: 203 }),
      fakeRoom("!room:hs"),
      false,
    );
    expect(received).toHaveLength(2);
  });

  it("emits a content-free decrypt-health signal once per fired note", async () => {
    const decryptHealth: Array<{ roomId: string; reason: string }> = [];
    const { adapter, fake } = makeAdapter({
      allowFrom: [],
      emitDecryptHealth: (s) => decryptHealth.push(s),
    });
    fake.cryptoHandle = {};
    await adapter.start();
    await fake.emit(ClientEvent.Sync, SyncState.Prepared, null);

    await fake.emit(
      RoomEvent.Timeline,
      fakeEncryptedFailEvent({ reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID", ts: 201 }),
      fakeRoom("!room:hs"),
      false,
    );
    // Same cause repeat → suppressed, so no second obs signal.
    await fake.emit(
      RoomEvent.Timeline,
      fakeEncryptedFailEvent({ reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID", ts: 202 }),
      fakeRoom("!room:hs"),
      false,
    );

    expect(decryptHealth).toHaveLength(1);
    expect(decryptHealth[0]).toEqual({ roomId: "!room:hs", reason: "missing_session" });
    // Content-free: only the closed kind + room id — never the raw SDK code or ciphertext.
    const dump = JSON.stringify(decryptHealth);
    expect(dump).not.toContain("MEGOLM_UNKNOWN_INBOUND_SESSION_ID");
    expect(dump).not.toContain("Unable to decrypt");
  });

  it("never tells the operator to enable e2ee when crypto is live (wrong-knob guard end-to-end)", async () => {
    const { adapter, fake, received } = makeAdapter({ allowFrom: [] });
    fake.cryptoHandle = {}; // crypto live → on-but-failed, not e2ee-off
    await adapter.start();

    await deliver(
      fake,
      fakeEncryptedFailEvent({ reason: "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE", ts: 201 }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.text).not.toContain("e2ee: true");
    expect(received[0]?.text).not.toContain("channels.matrix.e2ee");
    // It carries the verification hint instead.
    expect(received[0]?.text).toContain("recoveryKey");
  });
});
