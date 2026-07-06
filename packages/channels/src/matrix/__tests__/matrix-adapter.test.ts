// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ComisLogger,
  NormalizedMessage,
  NormalizedReaction,
  TimerHandle,
  TimerPort,
} from "@comis/core";
import {
  ClientEvent,
  Direction,
  RoomEvent,
  SyncState,
  type ICreateClientOpts,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import * as sdk from "matrix-js-sdk";
import { ok } from "@comis/shared";
import {
  createMatrixAdapter,
  MAX_TRACKED_REACTIONS,
  type MatrixAdapterDeps,
  type MatrixAdapterHandle,
} from "../matrix-adapter.js";
import { MATRIX_EVENT_BYTE_BUDGET } from "../matrix-adapter-outbound.js";
import type { MatrixCryptoHandle } from "../crypto-store.js";

/**
 * A TimerPort whose `setTimeout` fires the callback immediately — the retry
 * backoff runs with no real delay, so a 429-then-success sequence is deterministic.
 */
function instantTimer(): TimerPort {
  const handle: TimerHandle = { cancelled: false, cancel: () => undefined, unref: () => undefined };
  return {
    setTimeout: (cb: () => void): TimerHandle => {
      cb();
      return handle;
    },
    setInterval: (): TimerHandle => handle,
  };
}

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
  overrides: {
    type?: string;
    id?: string;
    sender?: string;
    ts?: number;
    body?: string;
    /** When set, rides as `m.mentions.user_ids` on the content (inbound mention test). */
    mentions?: string[];
    /** When set, rides as the `formatted_body` on the content. */
    formattedBody?: string;
  } = {},
): MatrixEvent {
  const { type = "m.room.message", id = "$evt1", sender = "@alice:hs", ts = 100, body = "hi" } =
    overrides;
  const content: Record<string, unknown> = { body };
  if (overrides.mentions !== undefined) content["m.mentions"] = { user_ids: overrides.mentions };
  if (overrides.formattedBody !== undefined) content.formatted_body = overrides.formattedBody;
  return {
    getType: () => type,
    getId: () => id,
    getSender: () => sender,
    getTs: () => ts,
    getContent: () => content,
    // Plaintext: the fail-closed decrypt branch is skipped for a non-encrypted event.
    isEncrypted: () => false,
  } as unknown as MatrixEvent;
}

/** A minimal live `m.reaction` timeline event (annotation-relates a target event). */
function fakeReactionEvent(
  overrides: { id?: string; sender?: string; ts?: number; targetId?: string; key?: string } = {},
): MatrixEvent {
  const { id = "$react1", sender = "@alice:hs", ts = 300, targetId = "$target:hs", key = "👍" } =
    overrides;
  return {
    getType: () => "m.reaction",
    getId: () => id,
    getSender: () => sender,
    getTs: () => ts,
    getContent: () => ({ "m.relates_to": { rel_type: "m.annotation", event_id: targetId, key } }),
    // Reactions ride in the clear; the fail-closed decrypt branch is skipped.
    isEncrypted: () => false,
  } as unknown as MatrixEvent;
}

/**
 * A minimal inbound media `m.room.message` event. In an encrypted room the media
 * rides `content.file` (the encrypted-file record); in a plaintext room it rides
 * `content.url`. The mapper reads `content.file` regardless of the wire encryption
 * flag, so this drives the adapter's cache-write path.
 */
function fakeMediaEvent(
  overrides: {
    id?: string;
    sender?: string;
    ts?: number;
    msgtype?: string;
    mxc?: string;
    encrypted?: Record<string, unknown>;
  } = {},
): MatrixEvent {
  const { id = "$media1", sender = "@alice:hs", ts = 400, msgtype = "m.image", mxc = "mxc://hs/img" } =
    overrides;
  const content: Record<string, unknown> = {
    msgtype,
    body: "file.png",
    info: { mimetype: "image/png", size: 10 },
  };
  if (overrides.encrypted !== undefined) content.file = overrides.encrypted;
  else content.url = mxc;
  return {
    getType: () => "m.room.message",
    getId: () => id,
    getSender: () => sender,
    getTs: () => ts,
    getContent: () => content,
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

/**
 * An injected crypto bootstrap that resolves to a handle reporting a fixed
 * verification posture — lets the adapter test drive the e2ee status surface
 * without loading the real crypto WASM.
 */
function fakeInitCrypto(verification: {
  crossSigningReady: boolean;
  deviceVerified: boolean;
}): MatrixAdapterDeps["initCryptoImpl"] {
  const handle: MatrixCryptoHandle = {
    scheduleSnapshot: vi.fn(),
    snapshotNow: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
    getVerificationStatus: vi.fn().mockResolvedValue(verification),
  };
  return vi
    .fn()
    .mockResolvedValue(ok(handle)) as unknown as MatrixAdapterDeps["initCryptoImpl"];
}

/**
 * An injected crypto bootstrap whose handle REJECTS every verification read — the
 * e2ee crypto-store read path that can throw (isCrossSigningReady /
 * getDeviceVerificationStatus). Drives the best-effort refresh's failure branch.
 */
function fakeInitCryptoRejectingVerification(): MatrixAdapterDeps["initCryptoImpl"] {
  const handle: MatrixCryptoHandle = {
    scheduleSnapshot: vi.fn(),
    snapshotNow: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
    getVerificationStatus: vi.fn().mockRejectedValue(new Error("crypto verification read failed")),
  };
  return vi
    .fn()
    .mockResolvedValue(ok(handle)) as unknown as MatrixAdapterDeps["initCryptoImpl"];
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

  /** Uploaded attachment payloads (bytes + declared type/name) + the mxc returned. */
  readonly uploads: Array<{ bytes: Uint8Array; type?: string; name?: string }> = [];
  uploadContent(
    bytes: Uint8Array,
    opts?: { type?: string; name?: string },
  ): Promise<{ content_uri: string }> {
    this.uploads.push({ bytes, type: opts?.type, name: opts?.name });
    return Promise.resolve({ content_uri: "mxc://hs/up" });
  }

  /** The access token the media client getter exposes to the resolver. */
  getAccessToken(): string | null {
    return "token-abc";
  }

  /** The authed mxc→http URL builder the media client getter binds; records each call. */
  readonly mxcCalls: unknown[][] = [];
  mxcUrlToHttp(...args: unknown[]): string | null {
    this.mxcCalls.push(args);
    return `https://hs/_matrix/client/v1/media/download/${String(args[0])}`;
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

  /** Rooms explicitly joined (invite auto-join + platformAction("join")). */
  readonly joinedRooms: string[] = [];
  joinRoom(roomIdOrAlias: string): Promise<unknown> {
    this.joinedRooms.push(roomIdOrAlias);
    return Promise.resolve({ roomId: roomIdOrAlias });
  }

  /** Platform-action recorders + injectable failures (Task: typing/join/leave/topic/read). */
  readonly typingCalls: Array<{ roomId: string; typing: boolean; timeoutMs: number }> = [];
  typingError?: unknown;
  sendTyping(roomId: string, typing: boolean, timeoutMs: number): Promise<object> {
    if (this.typingError !== undefined) return Promise.reject(this.typingError);
    this.typingCalls.push({ roomId, typing, timeoutMs });
    return Promise.resolve({});
  }

  readonly leftRooms: string[] = [];
  leave(roomId: string): Promise<object> {
    this.leftRooms.push(roomId);
    return Promise.resolve({});
  }

  readonly topicCalls: Array<{ roomId: string; topic: string | undefined; htmlTopic: string | undefined }> =
    [];
  setRoomTopic(roomId: string, topic?: string, htmlTopic?: string): Promise<object> {
    this.topicCalls.push({ roomId, topic, htmlTopic });
    return Promise.resolve({});
  }

  readonly readReceipts: unknown[] = [];
  sendReadReceipt(event: unknown): Promise<object> {
    this.readReceipts.push(event);
    return Promise.resolve({});
  }

  /** eventId → resident event, for the markRead getRoom().findEventById() resolver. */
  readonly residentEvents = new Map<string, unknown>();
  getRoom(roomId: string): { roomId: string; findEventById: (id: string) => unknown } | null {
    const events = this.residentEvents;
    return { roomId, findEventById: (id: string) => events.get(id) };
  }

  /** Reaction/redaction recorders + injectable failures for the outbound tests. */
  readonly redactedEvents: Array<{ roomId: string; eventId: string }> = [];
  redactError?: unknown;
  /** A distinct id per send so successive reactions retain DIFFERENT annotation ids. */
  private sendCount = 0;
  /** Total sendEvent invocations, INCLUDING attempts that reject — the retry proof. */
  sendAttempts = 0;
  /** A FIFO queue of errors to reject successive sends with (models a transient 429). */
  readonly pendingSendErrors: unknown[] = [];
  /** When set, sendEvent rejects (non-retryable 403) from this attempt number on. */
  failSendsFromAttempt?: number;

  sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<{ event_id: string }> {
    this.sendAttempts += 1;
    if (
      this.failSendsFromAttempt !== undefined &&
      this.sendAttempts >= this.failSendsFromAttempt
    ) {
      return Promise.reject(matrixError("M_FORBIDDEN", 403, "not allowed"));
    }
    if (this.pendingSendErrors.length > 0) {
      return Promise.reject(this.pendingSendErrors.shift());
    }
    if (this.sendError !== undefined) return Promise.reject(this.sendError);
    this.sentEvents.push({ roomId, eventType, content });
    this.sendCount += 1;
    return Promise.resolve({ event_id: `$sent${this.sendCount}` });
  }

  /** Total redactEvent invocations, INCLUDING attempts that reject — the retry proof. */
  redactAttempts = 0;
  /** A FIFO queue of errors to reject successive redactions with (models a 429). */
  readonly pendingRedactErrors: unknown[] = [];
  redactEvent(roomId: string, eventId: string): Promise<{ event_id: string }> {
    this.redactAttempts += 1;
    if (this.pendingRedactErrors.length > 0) {
      return Promise.reject(this.pendingRedactErrors.shift());
    }
    if (this.redactError !== undefined) return Promise.reject(this.redactError);
    this.redactedEvents.push({ roomId, eventId });
    return Promise.resolve({ event_id: "$redact1" });
  }

  /** History pagination: the injected `/messages` chunk + a call recorder. */
  messagesChunk: Array<{
    event_id: string;
    sender: string;
    origin_server_ts: number;
    type: string;
    content: { body?: string };
  }> = [];
  messagesError?: unknown;
  lastMessagesRequest?: { roomId: string; from: string | null; limit: number | undefined; dir: string };

  createMessagesRequest(
    roomId: string,
    from: string | null,
    limit: number | undefined,
    dir: string,
  ): Promise<{ chunk: unknown[]; start?: string; end?: string }> {
    this.lastMessagesRequest = { roomId, from, limit, dir };
    if (this.messagesError !== undefined) return Promise.reject(this.messagesError);
    return Promise.resolve({ chunk: this.messagesChunk, end: "t-next" });
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
  e2ee?: boolean;
  initCryptoImpl?: MatrixAdapterDeps["initCryptoImpl"];
  timer?: TimerPort;
  readFileImpl?: (path: string) => Promise<Buffer>;
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
    ...(over.e2ee !== undefined ? { e2ee: over.e2ee } : {}),
    ...(over.initCryptoImpl !== undefined ? { initCryptoImpl: over.initCryptoImpl } : {}),
  };

  // The timer + readFileImpl seams ride a supertype cast so this harness compiles
  // whether or not the deps type carries those (optional) fields yet.
  const extra: Record<string, unknown> = {};
  if (over.timer !== undefined) extra.timer = over.timer;
  if (over.readFileImpl !== undefined) extra.readFileImpl = over.readFileImpl;
  const adapter = createMatrixAdapter(
    Object.keys(extra).length > 0 ? ({ ...deps, ...extra } as MatrixAdapterDeps) : deps,
  );
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

  it("refuses to start against a private homeserver when allowPrivateHomeserver is false", async () => {
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

  it("outbound: rewrites @[Name](@mxid) mentions to matrix.to pills and rides m.mentions.user_ids", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "ping @[Bob](@bob:hs) and @[Al](@al:hs)");

    expect(result.ok).toBe(true);
    const [sent] = fake.sentEvents;
    expect((sent?.content["m.mentions"] as { user_ids: string[] }).user_ids).toEqual([
      "@bob:hs",
      "@al:hs",
    ]);
    // The shared markdown renderer turned the rewritten link into an HTML pill.
    expect(sent?.content.formatted_body).toContain('<a href="https://matrix.to/#/@bob:hs">Bob</a>');
  });

  it("outbound: a message with no mention carries no m.mentions field", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    await adapter.sendMessage("!room:hs", "no mention here");

    const [sent] = fake.sentEvents;
    expect(sent?.content["m.mentions"]).toBeUndefined();
  });

  it("inbound: an event whose m.mentions name the bot MXID sets metadata.isBotMentioned — the group @-gate key", async () => {
    const { adapter, fake, received } = makeAdapter({ allowFrom: [] });
    await adapter.start();

    await deliver(fake, fakeEvent({ sender: "@alice:hs", body: "hey bot", mentions: ["@bot:hs"] }));

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata.isBotMentioned).toBe(true);
  });

  it("inbound: an event that does not mention the bot leaves isBotMentioned false", async () => {
    const { adapter, fake, received } = makeAdapter({ allowFrom: [] });
    await adapter.start();

    await deliver(
      fake,
      fakeEvent({ sender: "@alice:hs", body: "hey all", mentions: ["@someone:hs"] }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata.isBotMentioned).toBe(false);
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

  it("sendTyping routes to client.sendTyping(roomId, true, 30000) and reports typing on", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.platformAction("sendTyping", { chatId: "!r:hs" });

    expect(result.ok).toBe(true);
    expect(fake.typingCalls).toEqual([{ roomId: "!r:hs", typing: true, timeoutMs: 30000 }]);
  });

  it("stopTyping routes to client.sendTyping with typing false", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.platformAction("stopTyping", { chatId: "!r:hs" });

    expect(result.ok).toBe(true);
    expect(fake.typingCalls[0]?.typing).toBe(false);
  });

  it("join routes to client.joinRoom", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.platformAction("join", { chatId: "!new:hs" });

    expect(result.ok).toBe(true);
    expect(fake.joinedRooms).toContain("!new:hs");
  });

  it("leave routes to client.leave", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.platformAction("leave", { chatId: "!r:hs" });

    expect(result.ok).toBe(true);
    expect(fake.leftRooms).toContain("!r:hs");
  });

  it("setTopic routes to client.setRoomTopic", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.platformAction("setTopic", { chatId: "!r:hs", topic: "New topic" });

    expect(result.ok).toBe(true);
    expect(fake.topicCalls[0]).toMatchObject({ roomId: "!r:hs", topic: "New topic" });
  });

  it("markRead resolves a resident event and sends a read receipt", async () => {
    const fake = new FakeMatrixClient();
    fake.residentEvents.set("$e:hs", { id: "$e:hs" });
    const { adapter } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.platformAction("markRead", { chatId: "!r:hs", eventId: "$e:hs" });

    expect(result.ok).toBe(true);
    expect(fake.readReceipts).toHaveLength(1);
  });

  it("markRead best-efforts ok(marked:false) when the target event is not resident", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.platformAction("markRead", {
      chatId: "!r:hs",
      eventId: "$missing:hs",
    });

    expect(result.ok).toBe(true);
    expect((result as { value: { marked: boolean } }).value.marked).toBe(false);
    expect(fake.readReceipts).toHaveLength(0);
  });

  it("errs a supported action before start with a precondition hint", async () => {
    const { adapter, logger } = makeAdapter();

    const result = await adapter.platformAction("sendTyping", { chatId: "!r:hs" });

    expect(result.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const preWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "precondition",
    );
    expect(preWarn).toBeDefined();
  });

  it("surfaces a sendTyping SDK failure as err with a classified hint", async () => {
    const fake = new FakeMatrixClient();
    fake.typingError = matrixError("M_FORBIDDEN", 403, "forbidden");
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.platformAction("sendTyping", { chatId: "!r:hs" });

    expect(result.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const failWarn = warn.mock.calls.find(
      ([fields]) => typeof (fields as { errorKind?: string }).errorKind === "string",
    );
    expect(failWarn).toBeDefined();
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
    // The adapter must WIRE the reauthenticate seam into the /sync
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
    // With no password there is no re-login, so the adapter must WIRE the
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

  it("surfaces the device verification posture on getStatus for an e2ee channel", async () => {
    // The crypto handle's cross-signing / device-verified posture
    // must reach the channel status so a doctor / fleet probe can read it.
    const { adapter } = makeAdapter({
      e2ee: true,
      initCryptoImpl: fakeInitCrypto({ crossSigningReady: true, deviceVerified: false }),
      allowFrom: [],
    });

    await adapter.start();

    expect(adapter.getStatus?.().verification).toEqual({
      crossSigningReady: true,
      deviceVerified: false,
    });
  });

  it("omits the verification field on the plaintext (non-e2ee) path", async () => {
    const { adapter } = makeAdapter({ allowFrom: [] }); // e2ee omitted

    await adapter.start();

    expect(adapter.getStatus?.().verification).toBeUndefined();
  });

  it("does not reject start() when the verification read fails, keeping the channel up", async () => {
    // The verification refresh is best-effort. A crypto read that rejects must NOT
    // reject start() (that would break the no-throw-escapes-the-port contract);
    // it degrades to a secret-free debug and leaves the posture unset.
    const { adapter, logger } = makeAdapter({
      e2ee: true,
      initCryptoImpl: fakeInitCryptoRejectingVerification(),
      allowFrom: [],
    });

    const result = await adapter.start();

    expect(result.ok).toBe(true);
    expect(adapter.getStatus?.().connected).toBe(true);
    // No posture surfaced (the read failed) — best-effort, not a hard failure.
    expect(adapter.getStatus?.().verification).toBeUndefined();
    // The failure degraded to a secret-free debug, not an escape.
    const refreshDebug = vi
      .mocked(logger.debug)
      .mock.calls.find(([fields]) => (fields as { step?: string }).step === "verification-refresh");
    expect(refreshDebug).toBeDefined();
  });

  it("keeps the last-known verification posture when a later refresh read fails", async () => {
    // First (seeding) read succeeds → posture cached. A later best-effort read
    // rejects → the cached posture is RETAINED (untouched) and no throw escapes.
    const handle: MatrixCryptoHandle = {
      scheduleSnapshot: vi.fn(),
      snapshotNow: vi.fn().mockResolvedValue(ok(undefined)),
      stop: vi.fn().mockResolvedValue(undefined),
      getVerificationStatus: vi
        .fn()
        .mockResolvedValueOnce({ crossSigningReady: true, deviceVerified: true })
        .mockRejectedValue(new Error("crypto verification read failed")),
    };
    const initCryptoImpl = vi
      .fn()
      .mockResolvedValue(ok(handle)) as unknown as MatrixAdapterDeps["initCryptoImpl"];
    const { adapter } = makeAdapter({ e2ee: true, initCryptoImpl, allowFrom: [] });

    await adapter.start();
    expect(adapter.getStatus?.().verification).toEqual({
      crossSigningReady: true,
      deviceVerified: true,
    });

    // getStatus() kicks off a best-effort refresh that now rejects; let it settle.
    adapter.getStatus?.();
    await Promise.resolve();
    await Promise.resolve();

    // The cached posture survives the failed refresh (best-effort, untouched).
    expect(adapter.getStatus?.().verification).toEqual({
      crossSigningReady: true,
      deviceVerified: true,
    });
  });
});

describe("createMatrixAdapter — decrypt degrade note", () => {
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

describe("createMatrixAdapter — inbound reactions", () => {
  it("delivers an inbound reaction from an allowed reactor to a registered onReaction handler", async () => {
    const { adapter, fake } = makeAdapter({ allowFrom: [], allowMode: "allowlist" });
    const reactions: NormalizedReaction[] = [];
    adapter.onReaction?.((r) => {
      reactions.push(r);
    });
    await adapter.start();

    await deliver(
      fake,
      fakeReactionEvent({ sender: "@alice:hs", targetId: "$t:hs", key: "🎉" }),
      fakeRoom("!room:hs"),
    );

    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toEqual({
      messageId: "$t:hs",
      reactorId: "@alice:hs", // the FULL MXID the speaker gate + trust resolver key on
      emoji: "🎉",
      channelType: "matrix",
      channelId: "!room:hs",
    });
  });

  it("drops an inbound reaction from a non-allowlisted reactor and warns without a body", async () => {
    const { adapter, fake, logger } = makeAdapter({
      allowFrom: ["@a:hs"],
      allowMode: "allowlist",
    });
    const reactions: NormalizedReaction[] = [];
    adapter.onReaction?.((r) => {
      reactions.push(r);
    });
    await adapter.start();

    await deliver(fake, fakeReactionEvent({ sender: "@b:hs", key: "👍" }), fakeRoom("!room:hs"));

    expect(reactions).toHaveLength(0);
    const warn = vi.mocked(logger.warn);
    const dropped = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "precondition",
    );
    expect(dropped).toBeDefined();
    // The drop WARN carries no reaction body (the emoji is never logged).
    expect(JSON.stringify(warn.mock.calls)).not.toContain("👍");
  });
});

describe("createMatrixAdapter — outbound reactions", () => {
  it("reactToMessage sends an m.reaction annotation for the target event and returns ok", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.reactToMessage?.("!room:hs", "$target:hs", "👍");

    expect(result?.ok).toBe(true);
    const reaction = fake.sentEvents.find((e) => e.eventType === "m.reaction");
    expect(reaction).toBeDefined();
    expect(reaction?.roomId).toBe("!room:hs");
    expect(reaction?.content["m.relates_to"]).toEqual({
      rel_type: "m.annotation",
      event_id: "$target:hs",
      key: "👍",
    });
  });

  it("removeReaction redacts the retained annotation id after a prior react (same session)", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    await adapter.reactToMessage?.("!room:hs", "$target:hs", "👍");
    const result = await adapter.removeReaction?.("!room:hs", "$target:hs", "👍");

    expect(result?.ok).toBe(true);
    // The retained annotation id (from the sendEvent response) is redacted.
    expect(fake.redactedEvents).toHaveLength(1);
    expect(fake.redactedEvents[0]).toEqual({ roomId: "!room:hs", eventId: "$sent1" });
  });

  it("removeReaction with no prior react returns ok without redacting (idempotent)", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.removeReaction?.("!room:hs", "$never:hs", "👍");

    expect(result?.ok).toBe(true);
    expect(fake.redactedEvents).toHaveLength(0);
  });

  it("keys the retained id on room+message+emoji, so a different emoji has nothing to redact", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    await adapter.reactToMessage?.("!room:hs", "$target:hs", "👍");
    // A DIFFERENT emoji on the same target was never reacted → idempotent no-op.
    const result = await adapter.removeReaction?.("!room:hs", "$target:hs", "🎉");

    expect(result?.ok).toBe(true);
    expect(fake.redactedEvents).toHaveLength(0);
  });

  it("errs on reactToMessage before start rather than dereferencing an absent client", async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.reactToMessage?.("!room:hs", "$t:hs", "👍");

    expect(result?.ok).toBe(false);
  });

  it("errs on removeReaction before start rather than dereferencing an absent client", async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.removeReaction?.("!room:hs", "$t:hs", "👍");

    expect(result?.ok).toBe(false);
  });

  it("propagates a reaction send failure as err with a classified errorKind hint and no emoji body", async () => {
    const fake = new FakeMatrixClient();
    fake.sendError = matrixError("M_LIMIT_EXCEEDED", 429, "slow down");
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.reactToMessage?.("!room:hs", "$t:hs", "👍");

    expect(result?.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    // The rate-limit errcode classifies to a retryable platform kind.
    const platformWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "platform",
    );
    expect(platformWarn).toBeDefined();
    // The emoji is never logged (content-free failure branch).
    expect(JSON.stringify(warn.mock.calls)).not.toContain("👍");
  });

  it("propagates a reaction redaction failure as err with a classified errorKind hint", async () => {
    const fake = new FakeMatrixClient();
    fake.redactError = matrixError("M_FORBIDDEN", 403, "not allowed");
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    await adapter.reactToMessage?.("!room:hs", "$t:hs", "👍");
    const result = await adapter.removeReaction?.("!room:hs", "$t:hs", "👍");

    expect(result?.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const authWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "auth",
    );
    expect(authWarn).toBeDefined();
  });

  it("bounds the retained reaction-id map, evicting the oldest tracked reaction", async () => {
    // Guard against unbounded growth if a caller ever reacts without removing:
    // the map keeps at most MAX_TRACKED_REACTIONS entries, evicting the oldest.
    // The evicted entry's removeReaction no-ops idempotently; the newest still redacts.
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    // React once past the cap. The very first target is then evicted.
    for (let i = 0; i <= MAX_TRACKED_REACTIONS; i++) {
      await adapter.reactToMessage?.("!room:hs", `$m${i}:hs`, "👍");
    }

    // The oldest ($m0) was evicted → its removal is an idempotent no-op.
    const evicted = await adapter.removeReaction?.("!room:hs", "$m0:hs", "👍");
    expect(evicted?.ok).toBe(true);
    expect(fake.redactedEvents).toHaveLength(0);

    // The newest ($m<cap>) is still tracked → its removal redacts.
    const newest = await adapter.removeReaction?.(
      "!room:hs",
      `$m${MAX_TRACKED_REACTIONS}:hs`,
      "👍",
    );
    expect(newest?.ok).toBe(true);
    expect(fake.redactedEvents).toHaveLength(1);
  });
});

describe("createMatrixAdapter — history fetch", () => {
  it("pages /messages backward and maps the chunk to FetchedMessage[] in order", async () => {
    const fake = new FakeMatrixClient();
    fake.messagesChunk = [
      { event_id: "$m1", sender: "@a:hs", origin_server_ts: 100, type: "m.room.message", content: { body: "first" } },
      { event_id: "$m2", sender: "@b:hs", origin_server_ts: 200, type: "m.room.message", content: { body: "second" } },
    ];
    const { adapter } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.fetchMessages?.("!room:hs", { limit: 2 });

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toEqual([
        { id: "$m1", senderId: "@a:hs", text: "first", timestamp: 100 },
        { id: "$m2", senderId: "@b:hs", text: "second", timestamp: 200 },
      ]);
    }
    // Paged backward from the most-recent end (a null `from` token), honoring the limit.
    expect(fake.lastMessagesRequest?.roomId).toBe("!room:hs");
    expect(fake.lastMessagesRequest?.from).toBeNull();
    expect(fake.lastMessagesRequest?.limit).toBe(2);
    expect(fake.lastMessagesRequest?.dir).toBe(Direction.Backward);
  });

  it("errs honestly when a before cursor is given rather than returning the wrong page", async () => {
    const fake = new FakeMatrixClient();
    fake.messagesChunk = [
      { event_id: "$m1", sender: "@a:hs", origin_server_ts: 100, type: "m.room.message", content: { body: "first" } },
    ];
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.fetchMessages?.("!room:hs", { before: "$cursor:hs", limit: 2 });

    // Backward-from-cursor paging is not wired (it needs an event-id→token
    // resolve). Rather than silently returning the most-recent page — a wrong
    // answer to a cursor query — it errs and issues NO /messages request.
    expect(result?.ok).toBe(false);
    expect(fake.lastMessagesRequest).toBeUndefined();
    const validationWarn = vi
      .mocked(logger.warn)
      .mock.calls.find(([fields]) => (fields as { errorKind?: string }).errorKind === "validation");
    expect(validationWarn).toBeDefined();
  });

  it("defaults to a bounded page size when no limit option is given", async () => {
    const fake = new FakeMatrixClient();
    fake.messagesChunk = [];
    const { adapter } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.fetchMessages?.("!room:hs");

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toEqual([]);
    expect(fake.lastMessagesRequest?.limit).toBe(20);
  });

  it("maps a missing body to an empty string rather than dropping the entry", async () => {
    const fake = new FakeMatrixClient();
    fake.messagesChunk = [
      { event_id: "$m1", sender: "@a:hs", origin_server_ts: 100, type: "m.room.message", content: {} },
    ];
    const { adapter } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.fetchMessages?.("!room:hs");

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value).toEqual([{ id: "$m1", senderId: "@a:hs", text: "", timestamp: 100 }]);
    }
  });

  it("errs on fetchMessages before start rather than dereferencing an absent client", async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.fetchMessages?.("!room:hs");

    expect(result?.ok).toBe(false);
  });

  it("propagates a fetch failure as err with a classified errorKind hint", async () => {
    const fake = new FakeMatrixClient();
    fake.messagesError = matrixError("M_FORBIDDEN", 403, "not in room");
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.fetchMessages?.("!room:hs");

    expect(result?.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const authWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "auth",
    );
    expect(authWarn).toBeDefined();
  });
});

describe("createMatrixAdapter — threaded + chunked send", () => {
  /** An HTML-heavy message whose serialized content exceeds the byte budget. */
  function overBudgetMarkdown(units = 480): string {
    let md = "";
    for (let i = 0; i < units; i++) {
      const n = String(i).padStart(4, "0");
      md += `**bold ${n}** and [link ${n}](https://example.com/path/${n}) `;
    }
    return md;
  }

  /**
   * An over-budget message carrying MANY distinct @-mentions. Each mention is both
   * a large pill in the rendered body AND a distinct `m.mentions.user_ids` entry —
   * and that user_ids list rides the FIRST chunk only. The list is several KiB, so
   * merging it into the first chunk after chunking overflows the budget unless the
   * chunker reserved room for it.
   */
  function mentionHeavyOverBudgetMarkdown(mentions = 400): string {
    const parts: string[] = [];
    for (let i = 0; i < mentions; i++) {
      const id = String(i).padStart(4, "0");
      parts.push(`@[User ${id}](@user${id}:homeserver.example.org)`);
    }
    return parts.join(" and also ");
  }

  it("threads a send by merging an m.thread relation into the sent content", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "hi", { threadId: "$root:hs" });

    expect(result.ok).toBe(true);
    expect(fake.sentEvents).toHaveLength(1);
    const [sent] = fake.sentEvents;
    expect(sent?.content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$root:hs",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$root:hs" },
    });
    // The rendered text still rides alongside the relation.
    expect(sent?.content.msgtype).toBe("m.text");
    expect(sent?.content.body).toBe("hi");
  });

  it("threads a reply under the replied-to event when threadReply is set without an explicit thread id", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "hi", {
      threadReply: true,
      replyTo: "$parent:hs",
    });

    expect(result.ok).toBe(true);
    const [sent] = fake.sentEvents;
    expect((sent?.content["m.relates_to"] as { event_id?: string }).event_id).toBe("$parent:hs");
  });

  it("sends a plain (non-threaded) short message as a single event with no relation", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "hello");

    expect(result.ok).toBe(true);
    expect(fake.sentEvents).toHaveLength(1);
    expect(fake.sentEvents[0]?.content["m.relates_to"]).toBeUndefined();
  });

  it("splits an over-budget message into multiple in-budget events sent sequentially", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", overBudgetMarkdown());

    expect(result.ok).toBe(true);
    // It split into multiple events ...
    expect(fake.sentEvents.length).toBeGreaterThanOrEqual(2);
    for (const sent of fake.sentEvents) {
      // ... each within the federation byte budget ...
      expect(Buffer.byteLength(JSON.stringify(sent.content))).toBeLessThanOrEqual(
        MATRIX_EVENT_BYTE_BUDGET,
      );
      // ... all to the same room as m.room.message events, in send order.
      expect(sent.roomId).toBe("!room:hs");
      expect(sent.eventType).toBe("m.room.message");
    }
    // A chunked send yields N events; the returned id is the LAST chunk's.
    if (result.ok) expect(result.value).toBe(`$sent${fake.sentEvents.length}`);
  });

  it("keeps the first chunk within budget when the message carries many mentions", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", mentionHeavyOverBudgetMarkdown());

    expect(result.ok).toBe(true);
    // The message is large enough to split, so there is a distinct first chunk.
    expect(fake.sentEvents.length).toBeGreaterThanOrEqual(2);
    // The FIRST delivered event carries the full m.mentions list, merged AFTER
    // chunking. Its serialized size must still fit the federation byte budget —
    // the chunker has to reserve the mention bytes for the first chunk.
    const first = fake.sentEvents[0];
    expect((first?.content["m.mentions"] as { user_ids?: string[] })?.user_ids?.length).toBe(400);
    expect(Buffer.byteLength(JSON.stringify(first?.content))).toBeLessThanOrEqual(
      MATRIX_EVENT_BYTE_BUDGET,
    );
    // Every chunk (not just the first) stays within budget.
    for (const sent of fake.sentEvents) {
      expect(Buffer.byteLength(JSON.stringify(sent.content))).toBeLessThanOrEqual(
        MATRIX_EVENT_BYTE_BUDGET,
      );
    }
  });

  it("keeps every threaded chunk within budget once the relation is merged in", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", overBudgetMarkdown(), {
      threadId: "$root:hs",
    });

    expect(result.ok).toBe(true);
    expect(fake.sentEvents.length).toBeGreaterThanOrEqual(2);
    for (const sent of fake.sentEvents) {
      // The relation is present on every chunk AND the event stays within budget.
      expect((sent.content["m.relates_to"] as { rel_type?: string }).rel_type).toBe("m.thread");
      expect(Buffer.byteLength(JSON.stringify(sent.content))).toBeLessThanOrEqual(
        MATRIX_EVENT_BYTE_BUDGET,
      );
    }
  });

  it("retries a chunk after a 429 and then succeeds, riding the rate-limit taxonomy", async () => {
    const fake = new FakeMatrixClient();
    // The first send is rate-limited; the retry succeeds.
    fake.pendingSendErrors.push(matrixError("M_LIMIT_EXCEEDED", 429, "slow down"));
    const { adapter } = makeAdapter({ fake, timer: instantTimer() });
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "hi");

    expect(result.ok).toBe(true);
    // Two attempts: the 429, then the successful resend.
    expect(fake.sendAttempts).toBe(2);
    // Exactly one event actually landed (the resend).
    expect(fake.sentEvents).toHaveLength(1);
  });

  it("stops and returns err on a non-retryable send failure without retrying", async () => {
    const fake = new FakeMatrixClient();
    fake.pendingSendErrors.push(matrixError("M_FORBIDDEN", 403, "not allowed"));
    const { adapter, logger } = makeAdapter({ fake, timer: instantTimer() });
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", "hi");

    expect(result.ok).toBe(false);
    // A 403 is non-retryable — a single attempt, no resend.
    expect(fake.sendAttempts).toBe(1);
    const warn = vi.mocked(logger.warn);
    const platformWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "platform",
    );
    expect(platformWarn).toBeDefined();
  });

  it("surfaces partial delivery in the error when a later chunk fails mid-send", async () => {
    const fake = new FakeMatrixClient();
    // The first chunk lands; the second fails with a non-retryable error.
    fake.failSendsFromAttempt = 2;
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.sendMessage("!room:hs", overBudgetMarkdown());

    expect(result.ok).toBe(false);
    // Exactly one chunk landed before the failure.
    expect(fake.sentEvents).toHaveLength(1);
    if (!result.ok) {
      // The error must reveal the partial delivery (count + last id) so a caller
      // resends only the remainder rather than blind-full-resending (which would
      // duplicate the delivered chunk).
      expect(result.error.message).toMatch(/1 of \d+/);
      expect(result.error.message).toContain("$sent1");
    }
    // The warn carries the machine-readable progress too.
    const warn = vi.mocked(logger.warn);
    const partialWarn = warn.mock.calls.find(
      ([fields]) => (fields as { chunksSent?: number }).chunksSent === 1,
    );
    expect(partialWarn).toBeDefined();
  });
});

describe("createMatrixAdapter — edits and deletes", () => {
  it("editMessage sends an m.replace whose new content carries the updated text and relates to the target", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.editMessage?.("!room:hs", "$orig:hs", "the corrected text");

    expect(result?.ok).toBe(true);
    // A single m.room.message send carrying the replacement relation.
    expect(fake.sentEvents).toHaveLength(1);
    const [sent] = fake.sentEvents;
    expect(sent?.roomId).toBe("!room:hs");
    expect(sent?.eventType).toBe("m.room.message");
    expect(sent?.content["m.relates_to"]).toEqual({
      rel_type: "m.replace",
      event_id: "$orig:hs",
    });
    // The new content is the authoritative replacement; the fallback body is marked.
    expect((sent?.content["m.new_content"] as { body?: string }).body).toBe("the corrected text");
    expect((sent?.content.body as string).startsWith("* ")).toBe(true);
  });

  it("editMessage returns void (discards the new event id) on success", async () => {
    const { adapter } = makeAdapter();
    await adapter.start();

    const result = await adapter.editMessage?.("!room:hs", "$orig:hs", "x");

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBeUndefined();
  });

  it("errs on editMessage before start rather than dereferencing an absent client", async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.editMessage?.("!room:hs", "$orig:hs", "x");

    expect(result?.ok).toBe(false);
  });

  it("propagates an edit send failure as err with a classified errorKind hint", async () => {
    const fake = new FakeMatrixClient();
    fake.sendError = matrixError("M_FORBIDDEN", 403, "cannot edit");
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.editMessage?.("!room:hs", "$orig:hs", "x");

    expect(result?.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const authWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "auth",
    );
    expect(authWarn).toBeDefined();
  });

  it("deleteMessage redacts the target event and returns ok", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.start();

    const result = await adapter.deleteMessage?.("!room:hs", "$target:hs");

    expect(result?.ok).toBe(true);
    expect(fake.redactedEvents).toHaveLength(1);
    expect(fake.redactedEvents[0]).toEqual({ roomId: "!room:hs", eventId: "$target:hs" });
    if (result?.ok) expect(result.value).toBeUndefined();
  });

  it("errs on deleteMessage before start rather than dereferencing an absent client", async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.deleteMessage?.("!room:hs", "$target:hs");

    expect(result?.ok).toBe(false);
  });

  it("propagates a delete redaction failure as err with a classified errorKind hint", async () => {
    const fake = new FakeMatrixClient();
    fake.redactError = matrixError("M_LIMIT_EXCEEDED", 429, "slow down");
    const { adapter, logger } = makeAdapter({ fake });
    await adapter.start();

    const result = await adapter.deleteMessage?.("!room:hs", "$target:hs");

    expect(result?.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    const platformWarn = warn.mock.calls.find(
      ([fields]) => (fields as { errorKind?: string }).errorKind === "platform",
    );
    expect(platformWarn).toBeDefined();
  });
});

describe("createMatrixAdapter — uniform rate-limit retry across outbound actions", () => {
  it("retries a rate-limited reaction and then succeeds", async () => {
    const fake = new FakeMatrixClient();
    fake.pendingSendErrors.push(matrixError("M_LIMIT_EXCEEDED", 429, "slow down"));
    const { adapter } = makeAdapter({ fake, timer: instantTimer() });
    await adapter.start();

    const result = await adapter.reactToMessage?.("!room:hs", "$t:hs", "👍");

    expect(result?.ok).toBe(true);
    // Two attempts: the 429, then the successful resend — like sendMessage.
    expect(fake.sendAttempts).toBe(2);
  });

  it("retries a rate-limited edit and then succeeds", async () => {
    const fake = new FakeMatrixClient();
    fake.pendingSendErrors.push(matrixError("M_LIMIT_EXCEEDED", 429, "slow down"));
    const { adapter } = makeAdapter({ fake, timer: instantTimer() });
    await adapter.start();

    const result = await adapter.editMessage?.("!room:hs", "$orig:hs", "new text");

    expect(result?.ok).toBe(true);
    expect(fake.sendAttempts).toBe(2);
  });

  it("retries a rate-limited delete (redaction) and then succeeds", async () => {
    const fake = new FakeMatrixClient();
    fake.pendingRedactErrors.push(matrixError("M_LIMIT_EXCEEDED", 429, "slow down"));
    const { adapter } = makeAdapter({ fake, timer: instantTimer() });
    await adapter.start();

    const result = await adapter.deleteMessage?.("!room:hs", "$target:hs");

    expect(result?.ok).toBe(true);
    expect(fake.redactAttempts).toBe(2);
  });

  it("retries a rate-limited reaction removal (redaction) and then succeeds", async () => {
    const fake = new FakeMatrixClient();
    const { adapter } = makeAdapter({ fake, timer: instantTimer() });
    await adapter.start();

    // Retain an annotation id to redact, then rate-limit its first redaction.
    await adapter.reactToMessage?.("!room:hs", "$t:hs", "👍");
    fake.pendingRedactErrors.push(matrixError("M_LIMIT_EXCEEDED", 429, "slow down"));

    const result = await adapter.removeReaction?.("!room:hs", "$t:hs", "👍");

    expect(result?.ok).toBe(true);
    expect(fake.redactAttempts).toBe(2);
  });
});

describe("createMatrixAdapter — media surface", () => {
  /** A stand-in encrypted-file record (url + JWK key + iv + hashes + version). */
  const ENC_RECORD: Record<string, unknown> = {
    url: "mxc://hs/enc",
    key: { alg: "A256CTR", key_ops: ["encrypt", "decrypt"], kty: "oct", k: "kkk", ext: true },
    iv: "aviv",
    hashes: { sha256: "abc" },
    v: "v2",
  };

  it("exposes a media client (mxc→http, access token, homeserver host) only after start", async () => {
    const { adapter } = makeAdapter({ homeserverUrl: "http://127.0.0.1:8008" });
    const handle = adapter as MatrixAdapterHandle;

    // Before start the client is not built yet — the media getter is undefined so a
    // resolver called at wiring time errs cleanly rather than crashing.
    expect(handle.getMediaClient()).toBeUndefined();

    await adapter.start();

    const media = handle.getMediaClient();
    expect(media).toBeDefined();
    expect(typeof media?.mxcUrlToHttp).toBe("function");
    expect(media?.getAccessToken()).toBe("token-abc");
    // The homeserver host is the hostname of the configured homeserver url.
    expect(media?.homeserverHost).toBe("127.0.0.1");
  });

  it("returns undefined for an unknown mxc and the cached record after an inbound encrypted media event", async () => {
    const { adapter, fake } = makeAdapter({ allowFrom: [] });
    const handle = adapter as MatrixAdapterHandle;
    await adapter.start();

    expect(handle.getEncryptedFile("mxc://hs/enc")).toBeUndefined();

    // An inbound encrypted media event flows through the mapper, which fires the
    // wired cache-write callback keyed by the mxc.
    await deliver(fake, fakeMediaEvent({ msgtype: "m.image", encrypted: ENC_RECORD }));

    expect(handle.getEncryptedFile("mxc://hs/enc")).toEqual(ENC_RECORD);
  });

  it("plaintext room: sendAttachment uploads the bytes and sends an m.image with a top-level url", async () => {
    const bytes = Buffer.from("PNGBYTES");
    const { adapter, fake } = makeAdapter({ readFileImpl: async () => bytes });
    await adapter.start(); // no crypto handle → the room is plaintext

    const result = await adapter.sendAttachment?.("!room:hs", {
      type: "image",
      url: "/tmp/x.png",
      mimeType: "image/png",
      fileName: "x.png",
    });

    expect(result?.ok).toBe(true);
    // The exact bytes were uploaded (no encryption on the plaintext path).
    expect(fake.uploads).toHaveLength(1);
    expect(Buffer.from(fake.uploads[0]?.bytes ?? new Uint8Array()).equals(bytes)).toBe(true);
    // The sent event is an m.image carrying the uploaded mxc on content.url, no file.
    const media = fake.sentEvents.find((e) => e.content.msgtype === "m.image");
    expect(media).toBeDefined();
    expect(media?.content.url).toBe("mxc://hs/up");
    expect(media?.content.file).toBeUndefined();
    if (result?.ok) expect(result.value).toBe("$sent1");
  });

  it("encrypted room: sendAttachment uploads ciphertext and sends content.file with no top-level url", async () => {
    const bytes = Buffer.from("PLAINTEXT-ATTACHMENT-BYTES-0123456789");
    const fake = new FakeMatrixClient();
    // The rust-crypto authoritative check reports the room encrypted.
    fake.cryptoHandle = { isEncryptionEnabledInRoom: async () => true };
    const { adapter } = makeAdapter({ fake, readFileImpl: async () => bytes });
    await adapter.start();

    const result = await adapter.sendAttachment?.("!room:hs", {
      type: "image",
      url: "/tmp/s.png",
      mimeType: "image/png",
      fileName: "s.png",
    });

    expect(result?.ok).toBe(true);
    // The uploaded payload is CIPHERTEXT — never the plaintext bytes.
    expect(fake.uploads).toHaveLength(1);
    const uploaded = Buffer.from(fake.uploads[0]?.bytes ?? new Uint8Array());
    expect(uploaded.equals(bytes)).toBe(false);
    // The event carries content.file (the record + the uploaded mxc) and NO plaintext url.
    const media = fake.sentEvents.find((e) => e.content.msgtype === "m.image");
    expect(media?.content.url).toBeUndefined();
    const file = media?.content.file as
      | { url?: string; key?: unknown; iv?: unknown; hashes?: unknown; v?: unknown }
      | undefined;
    expect(file?.url).toBe("mxc://hs/up");
    expect(file?.key).toBeDefined();
    expect(file?.iv).toBeDefined();
    expect(file?.hashes).toBeDefined();
    expect(file?.v).toBeDefined();
  });

  it("encrypted room: uploads the ciphertext as application/octet-stream with no filename, so the media repo never learns the real MIME or name", async () => {
    // The /_matrix/media upload is NOT end-to-end encrypted, and the homeserver is
    // adversarial under the E2EE threat model. Passing the real {type, name} to the
    // upload would disclose (e.g.) "application/pdf" / "Q3-finance.pdf" to the media
    // repo even though the bytes are ciphertext. The real MIME + filename must ride
    // ONLY inside the encrypted event content; the upload metadata is scrubbed.
    const bytes = Buffer.from("PLAINTEXT-ATTACHMENT-BYTES-0123456789");
    const fake = new FakeMatrixClient();
    fake.cryptoHandle = { isEncryptionEnabledInRoom: async () => true };
    const { adapter } = makeAdapter({ fake, readFileImpl: async () => bytes });
    await adapter.start();

    const result = await adapter.sendAttachment?.("!room:hs", {
      type: "file",
      url: "/tmp/Q3-finance.pdf",
      mimeType: "application/pdf",
      fileName: "Q3-finance.pdf",
    });

    expect(result?.ok).toBe(true);
    expect(fake.uploads).toHaveLength(1);
    // The homeserver media repo sees a generic octet-stream with no name.
    expect(fake.uploads[0]?.type).toBe("application/octet-stream");
    expect(fake.uploads[0]?.name).toBeUndefined();

    // The recipient still reconstructs the real filename + MIME — they ride the
    // ENCRYPTED event content (content.body / content.info.mimetype), not the upload.
    const media = fake.sentEvents.find((e) => e.content.msgtype === "m.file");
    expect(media?.content.body).toBe("Q3-finance.pdf");
    expect((media?.content.info as { mimetype?: string } | undefined)?.mimetype).toBe(
      "application/pdf",
    );
  });

  it("maps the MIME family to the media msgtype (audio → m.audio, document → m.file)", async () => {
    const { adapter, fake } = makeAdapter({ readFileImpl: async () => Buffer.from("x") });
    await adapter.start();

    await adapter.sendAttachment?.("!room:hs", {
      type: "audio",
      url: "/tmp/a.ogg",
      mimeType: "audio/ogg",
      fileName: "a.ogg",
    });
    await adapter.sendAttachment?.("!room:hs", {
      type: "file",
      url: "/tmp/d.pdf",
      mimeType: "application/pdf",
      fileName: "d.pdf",
    });

    const msgtypes = fake.sentEvents.map((e) => e.content.msgtype);
    expect(msgtypes).toContain("m.audio");
    expect(msgtypes).toContain("m.file");
  });

  it("errs on sendAttachment before start rather than dereferencing an absent client", async () => {
    const { adapter } = makeAdapter({ readFileImpl: async () => Buffer.from("x") });

    const result = await adapter.sendAttachment?.("!room:hs", {
      type: "image",
      url: "/tmp/x.png",
      mimeType: "image/png",
      fileName: "x.png",
    });

    expect(result?.ok).toBe(false);
  });
});
