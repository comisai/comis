// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import type { NormalizedMessage, ComisLogger } from "@comis/core";
import {
  ClientEvent,
  RoomEvent,
  KnownMembership,
  SyncState,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { createMatrixClient } from "../matrix-client.js";
import type { MatrixState, MatrixStateStore } from "../matrix-state.js";

/** A recording state store: load() yields the seed; save() records every arg. */
function makeStateStore(seed: Partial<MatrixState> = {}): {
  store: MatrixStateStore;
  saves: MatrixState[];
  failSave?: boolean;
} {
  const saves: MatrixState[] = [];
  const current: MatrixState = { watermark: 0, ...seed };
  const holder = { failSave: false };
  const store: MatrixStateStore = {
    load: async () => ok({ ...current }),
    save: async (state: MatrixState) => {
      saves.push({ ...state });
      return holder.failSave ? err(new Error("disk full")) : ok(undefined);
    },
  };
  return {
    store,
    saves,
    get failSave() {
      return holder.failSave;
    },
    set failSave(v: boolean) {
      holder.failSave = v;
    },
  } as { store: MatrixStateStore; saves: MatrixState[]; failSave: boolean };
}

/** A logger whose calls the test inspects for errorKind/hint and secret leaks. */
function makeLogger(): ComisLogger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as ComisLogger;
}

/** Build an Error carrying Matrix `errcode`/`httpStatus`, like the SDK's MatrixError. */
function matrixError(errcode: string, httpStatus: number, message: string): Error {
  const e = new Error(message) as Error & { errcode: string; httpStatus: number };
  e.errcode = errcode;
  e.httpStatus = httpStatus;
  return e;
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
  } as unknown as MatrixEvent;
}

/** A minimal room; `inviter` is the sender of the bot's own invite m.room.member event. */
function fakeRoom(roomId: string, opts: { inviter?: string } = {}): Room {
  return {
    roomId,
    getMember: (_userId: string) =>
      opts.inviter === undefined
        ? null
        : { events: { member: { getSender: () => opts.inviter } } },
  } as unknown as Room;
}

interface FakeClientOptions {
  userId?: string | null;
  initialToken?: string | null;
  joinError?: unknown;
  startError?: unknown;
}

/** An EventEmitter-like fake matrix-js-sdk client that records the SUT's calls. */
class FakeMatrixClient {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  readonly startCalls: Array<{ initialSyncLimit?: number; filter?: unknown }> = [];
  readonly setTokenCalls: string[] = [];
  readonly joinCalls: string[] = [];
  stopCalls = 0;
  private token: string | null;
  private readonly userId: string | null;
  private readonly joinError?: unknown;
  private readonly startError?: unknown;
  readonly store: { getSyncToken(): string | null; setSyncToken(token: string): void };

  constructor(opts: FakeClientOptions = {}) {
    // Distinguish "not provided" (default MXID) from an explicit null user id.
    this.userId = opts.userId === undefined ? "@bot:hs" : opts.userId;
    this.token = opts.initialToken ?? null;
    this.joinError = opts.joinError;
    this.startError = opts.startError;
    const self = this;
    this.store = {
      getSyncToken: () => self.token,
      setSyncToken: (t: string) => {
        self.token = t;
        self.setTokenCalls.push(t);
      },
    };
  }

  /** Test-only: drive a token advance the SDK would perform after a sync batch. */
  advanceStoreToken(token: string): void {
    this.token = token;
  }

  on(event: string, handler: (...args: unknown[]) => unknown): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  /** Test-only: emit an event and await every registered handler (deterministic). */
  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(...args);
    }
  }

  startClient(opts?: { initialSyncLimit?: number; filter?: unknown }): Promise<void> {
    this.startCalls.push(opts ?? {});
    if (this.startError !== undefined) return Promise.reject(this.startError);
    return Promise.resolve();
  }

  stopClient(): void {
    this.stopCalls += 1;
  }

  getUserId(): string | null {
    return this.userId;
  }

  joinRoom(roomIdOrAlias: string): Promise<unknown> {
    this.joinCalls.push(roomIdOrAlias);
    if (this.joinError !== undefined) return Promise.reject(this.joinError);
    return Promise.resolve({ roomId: roomIdOrAlias });
  }

  asClient(): MatrixClient {
    return this as unknown as MatrixClient;
  }
}

/** A secret-free health signal shape (structural — no import of the SUT type). */
interface HealthSignalRecord {
  errorKind: string;
  hint: string;
}

interface HarnessOverrides {
  autoJoinOnInvite?: boolean;
  allowMode?: "allowlist" | "open";
  allowFrom?: string[];
  onMessage?: (m: NormalizedMessage) => void | Promise<void>;
  seed?: Partial<MatrixState>;
  clientOpts?: FakeClientOptions;
  reauthenticate?: () => Promise<
    { ok: true; value: { accessToken: string; deviceId?: string } } | { ok: false; error: Error }
  >;
}

function makeHarness(over: HarnessOverrides = {}): {
  fake: FakeMatrixClient;
  saves: MatrixState[];
  logger: ComisLogger;
  received: NormalizedMessage[];
  healthSignals: HealthSignalRecord[];
  storeHandle: { failSave: boolean };
  controller: ReturnType<typeof createMatrixClient>;
} {
  const fake = new FakeMatrixClient(over.clientOpts);
  const stateStore = makeStateStore(over.seed) as unknown as {
    store: MatrixStateStore;
    saves: MatrixState[];
    failSave: boolean;
  };
  const logger = makeLogger();
  const received: NormalizedMessage[] = [];
  const onMessage =
    over.onMessage ??
    ((m: NormalizedMessage) => {
      received.push(m);
    });
  const healthSignals: HealthSignalRecord[] = [];
  const controller = createMatrixClient({
    client: fake.asClient(),
    stateStore: stateStore.store,
    autoJoinOnInvite: over.autoJoinOnInvite ?? true,
    allowMode: over.allowMode ?? "allowlist",
    allowFrom: over.allowFrom ?? [],
    onMessage,
    logger,
    emitHealth: (signal: HealthSignalRecord) => {
      healthSignals.push(signal);
    },
    ...(over.reauthenticate !== undefined ? { reauthenticate: over.reauthenticate } : {}),
  });
  return {
    fake,
    saves: stateStore.saves,
    logger,
    received,
    healthSignals,
    storeHandle: stateStore,
    controller,
  };
}

describe("createMatrixClient — /sync lifecycle, watermark guard, invite gate", () => {
  it("resumes /sync from the persisted sync token and starts with an enabled filter", async () => {
    const h = makeHarness({ seed: { syncToken: "since-persisted", watermark: 5 } });

    const started = await h.controller.start();

    expect(started.ok).toBe(true);
    // Token resume: the persisted since-token is seeded into the client store so
    // /sync resumes rather than forcing a full re-sync. (Real API: store.setSyncToken,
    // not a startClient since-option — 41.8.0 has none.)
    expect(h.fake.setTokenCalls).toContain("since-persisted");
    // startClient is called with an enabled filter and a bounded initial sync.
    expect(h.fake.startCalls).toHaveLength(1);
    expect(h.fake.startCalls[0]?.filter).toBeDefined();
    expect(typeof h.fake.startCalls[0]?.initialSyncLimit).toBe("number");
    // All three subscriptions are wired.
    expect(h.fake.handlers.has(ClientEvent.Sync)).toBe(true);
    expect(h.fake.handlers.has(RoomEvent.Timeline)).toBe(true);
    expect(h.fake.handlers.has(RoomEvent.MyMembership)).toBe(true);
  });

  it("does not deliver a timeline event received before the client reaches a ready sync state", async () => {
    const h = makeHarness({ seed: { watermark: 5 } });
    await h.controller.start();

    // No PREPARED/SYNCING emitted → syncReady stays false → the boot backlog is dropped.
    await h.fake.emit(RoomEvent.Timeline, fakeEvent({ ts: 100 }), fakeRoom("!r:hs"), false);

    expect(h.received).toHaveLength(0);
  });

  it("does not deliver a backlog event delivered toStartOfTimeline even after PREPARED", async () => {
    const h = makeHarness({ seed: { watermark: 5 } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    // toStartOfTimeline true → pagination/backfill, not live.
    await h.fake.emit(RoomEvent.Timeline, fakeEvent({ ts: 100 }), fakeRoom("!r:hs"), true);

    expect(h.received).toHaveLength(0);
  });

  it("does not deliver an event at or before the persisted watermark", async () => {
    const h = makeHarness({ seed: { watermark: 100 } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(RoomEvent.Timeline, fakeEvent({ ts: 50 }), fakeRoom("!r:hs"), false);

    expect(h.received).toHaveLength(0);
  });

  it("does not deliver a non-message timeline event", async () => {
    const h = makeHarness({ seed: { watermark: 5 } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared, undefined);

    await h.fake.emit(
      RoomEvent.Timeline,
      fakeEvent({ type: "m.room.topic", ts: 100 }),
      fakeRoom("!r:hs"),
      false,
    );

    expect(h.received).toHaveLength(0);
  });

  it("delivers a live post-watermark message and advances + persists the watermark", async () => {
    const h = makeHarness({ seed: { watermark: 5, syncToken: "s0" } });
    await h.controller.start();
    const savesBefore = h.saves.length;
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(
      RoomEvent.Timeline,
      fakeEvent({ ts: 100, body: "hello there", sender: "@alice:hs" }),
      fakeRoom("!room:hs"),
      false,
    );

    expect(h.received).toHaveLength(1);
    expect(h.received[0]?.text).toBe("hello there");
    expect(h.received[0]?.channelId).toBe("!room:hs");
    expect(h.received[0]?.senderId).toBe("@alice:hs");
    // The watermark advanced to the event ts and was persisted.
    const watermarkSaves = h.saves.slice(savesBefore).filter((s) => s.watermark === 100);
    expect(watermarkSaves.length).toBeGreaterThanOrEqual(1);
  });

  it("persists the advanced sync token when the client reports a new batch token", async () => {
    const h = makeHarness({ seed: { syncToken: "s0", watermark: 5 } });
    await h.controller.start();

    // The SDK advanced its sync token after a batch; the ready-state event persists it.
    h.fake.advanceStoreToken("s1-advanced");
    await h.fake.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared, undefined);

    const tokenSaves = h.saves.filter((s) => s.syncToken === "s1-advanced");
    expect(tokenSaves.length).toBeGreaterThanOrEqual(1);
  });

  it("joins a room when an invite comes from an allowlisted inviter MXID", async () => {
    const h = makeHarness({
      autoJoinOnInvite: true,
      allowMode: "allowlist",
      allowFrom: ["@alice:hs"],
    });
    await h.controller.start();

    await h.fake.emit(
      RoomEvent.MyMembership,
      fakeRoom("!invited:hs", { inviter: "@alice:hs" }),
      KnownMembership.Invite,
      KnownMembership.Leave,
    );

    expect(h.fake.joinCalls).toContain("!invited:hs");
  });

  it("does not join a room when an invite comes from a non-allowlisted inviter MXID", async () => {
    const h = makeHarness({
      autoJoinOnInvite: true,
      allowMode: "allowlist",
      allowFrom: ["@alice:hs"],
    });
    await h.controller.start();

    await h.fake.emit(
      RoomEvent.MyMembership,
      fakeRoom("!invited:hs", { inviter: "@mallory:evil" }),
      KnownMembership.Invite,
      KnownMembership.Leave,
    );

    expect(h.fake.joinCalls).toHaveLength(0);
  });

  it("ignores an invite whose inviter MXID cannot be resolved", async () => {
    const h = makeHarness({ autoJoinOnInvite: true, allowMode: "open", allowFrom: [] });
    await h.controller.start();

    // getMember returns null → no verifiable inviter → default-closed, no join.
    await h.fake.emit(
      RoomEvent.MyMembership,
      fakeRoom("!invited:hs"),
      KnownMembership.Invite,
      KnownMembership.Leave,
    );

    expect(h.fake.joinCalls).toHaveLength(0);
  });

  it("ignores a non-invite membership transition", async () => {
    const h = makeHarness({ autoJoinOnInvite: true, allowMode: "open" });
    await h.controller.start();

    await h.fake.emit(
      RoomEvent.MyMembership,
      fakeRoom("!joined:hs", { inviter: "@alice:hs" }),
      KnownMembership.Join,
      KnownMembership.Invite,
    );

    expect(h.fake.joinCalls).toHaveLength(0);
  });

  it("advances the watermark and logs an error when the message handler rejects", async () => {
    const onMessage = vi.fn().mockRejectedValue(new Error("pipeline down"));
    const h = makeHarness({ seed: { watermark: 5 }, onMessage });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    await h.fake.emit(RoomEvent.Timeline, fakeEvent({ ts: 100 }), fakeRoom("!r:hs"), false);

    expect(onMessage).toHaveBeenCalledTimes(1);
    // The event was delivered to the inbound path; the watermark still advances so
    // a downstream failure never causes infinite reprocessing on the next sync.
    expect(h.saves.some((s) => s.watermark === 100)).toBe(true);
    expect(vi.mocked(h.logger.error)).toHaveBeenCalled();
  });

  it("logs a warning when persisting the watermark fails", async () => {
    const h = makeHarness({ seed: { watermark: 5 } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);
    h.storeHandle.failSave = true;

    await h.fake.emit(RoomEvent.Timeline, fakeEvent({ ts: 100 }), fakeRoom("!r:hs"), false);

    expect(h.received).toHaveLength(1);
    expect(vi.mocked(h.logger.warn)).toHaveBeenCalled();
  });

  it("stops the client on stop()", async () => {
    const h = makeHarness();
    await h.controller.start();

    h.controller.stop();

    expect(h.fake.stopCalls).toBe(1);
  });

  it("logs an error but does not throw when auto-join fails for a permitted invite", async () => {
    const h = makeHarness({
      autoJoinOnInvite: true,
      allowMode: "open",
      clientOpts: { joinError: matrixError("M_FORBIDDEN", 403, "not permitted") },
    });
    await h.controller.start();

    await h.fake.emit(
      RoomEvent.MyMembership,
      fakeRoom("!invited:hs", { inviter: "@alice:hs" }),
      KnownMembership.Invite,
      KnownMembership.Leave,
    );

    expect(h.fake.joinCalls).toContain("!invited:hs");
    expect(vi.mocked(h.logger.error)).toHaveBeenCalled();
  });

  it("does not deliver a message event that has no verifiable sender", async () => {
    const h = makeHarness({ seed: { watermark: 5 } });
    await h.controller.start();
    await h.fake.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);

    // Passes the watermark gate (m.room.message, ts>watermark) but the mapper
    // rejects it for having no sender → never delivered, watermark not advanced.
    const noSender = {
      getType: () => "m.room.message",
      getId: () => "$x",
      getSender: () => null,
      getTs: () => 100,
      getContent: () => ({ body: "x" }),
    } as unknown as MatrixEvent;
    await h.fake.emit(RoomEvent.Timeline, noSender, fakeRoom("!r:hs"), false);

    expect(h.received).toHaveLength(0);
    expect(h.saves.some((s) => s.watermark === 100)).toBe(false);
  });

  it("ignores an invite when the bot's own user id is unknown", async () => {
    const h = makeHarness({
      autoJoinOnInvite: true,
      allowMode: "open",
      clientOpts: { userId: null },
    });
    await h.controller.start();

    await h.fake.emit(
      RoomEvent.MyMembership,
      fakeRoom("!invited:hs", { inviter: "@alice:hs" }),
      KnownMembership.Invite,
      KnownMembership.Leave,
    );

    expect(h.fake.joinCalls).toHaveLength(0);
  });

  it("returns an error and never starts sync when startClient rejects", async () => {
    const h = makeHarness({ clientOpts: { startError: matrixError("M_UNKNOWN", 500, "boom") } });

    const started = await h.controller.start();

    expect(started.ok).toBe(false);
    expect(vi.mocked(h.logger.error)).toHaveBeenCalled();
  });

  it("returns an error when the persisted state cannot be loaded", async () => {
    const fake = new FakeMatrixClient();
    const badStore: MatrixStateStore = {
      load: async () => err(new Error("corrupt state file")),
      save: async () => ok(undefined),
    };
    const controller = createMatrixClient({
      client: fake.asClient(),
      stateStore: badStore,
      autoJoinOnInvite: true,
      allowMode: "allowlist",
      allowFrom: [],
      onMessage: () => {},
      logger: makeLogger(),
    });

    const started = await controller.start();

    expect(started.ok).toBe(false);
    // A corrupt state must never silently reset the watermark → no sync started.
    expect(fake.startCalls).toHaveLength(0);
  });
});

describe("createMatrixClient — token-expiry recovery + stale-since re-entry", () => {
  it("re-logins, persists the fresh token and device id, and resumes syncing on a mid-run token expiry", async () => {
    const reauthenticate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { accessToken: "fresh-token", deviceId: "DEV2" } });
    const h = makeHarness({ seed: { syncToken: "s0", watermark: 5 }, reauthenticate });
    await h.controller.start();
    const startsBefore = h.fake.startCalls.length;

    await h.fake.emit(
      ClientEvent.Sync,
      SyncState.Error,
      SyncState.Syncing,
      { error: matrixError("M_UNKNOWN_TOKEN", 401, "token expired mid-run") },
    );

    expect(reauthenticate).toHaveBeenCalledTimes(1);
    // The fresh token + device id are persisted so a restart uses them.
    const tokenSave = h.saves.find((s) => s.accessToken === "fresh-token");
    expect(tokenSave).toBeDefined();
    expect(tokenSave?.deviceId).toBe("DEV2");
    // Sync resumed (startClient re-invoked).
    expect(h.fake.startCalls.length).toBeGreaterThan(startsBefore);
    // The fresh token is persisted to disk but never written to a log line.
    expect(JSON.stringify(vi.mocked(h.logger.info).mock.calls)).not.toContain("fresh-token");
    expect(JSON.stringify(vi.mocked(h.logger.error).mock.calls)).not.toContain("fresh-token");
  });

  it("emits a loud health signal naming channels.matrix.accessToken and never silently stops when no re-login is available", async () => {
    const h = makeHarness({ seed: { syncToken: "s0", watermark: 5 } });
    await h.controller.start();

    await h.fake.emit(
      ClientEvent.Sync,
      SyncState.Error,
      SyncState.Syncing,
      { error: matrixError("M_UNKNOWN_TOKEN", 401, "token revoked") },
    );

    expect(h.healthSignals).toHaveLength(1);
    expect(h.healthSignals[0]?.errorKind).toBe("auth");
    expect(h.healthSignals[0]?.hint).toContain("channels.matrix.accessToken");
    // Loud on the log too, and never silently dark: the client is not stopped.
    expect(vi.mocked(h.logger.error)).toHaveBeenCalled();
    expect(h.fake.stopCalls).toBe(0);
  });

  it("clears the persisted sync token but retains the watermark when the homeserver rejects a stale since", async () => {
    const h = makeHarness({ seed: { syncToken: "stale-tok", watermark: 42 } });
    await h.controller.start();

    await h.fake.emit(
      ClientEvent.Sync,
      SyncState.Error,
      SyncState.Syncing,
      { error: matrixError("M_UNKNOWN", 400, "unrecognised since token") },
    );

    // The token is cleared (so a restart re-enters initial sync) but the
    // watermark is retained (so that re-entry stays guarded against the backlog).
    const clearSave = h.saves.find((s) => s.syncToken === undefined && s.watermark === 42);
    expect(clearSave).toBeDefined();
  });

  it("never leaks a secret from the sync error into the health signal or logs", async () => {
    const h = makeHarness({ seed: { syncToken: "s0", watermark: 5 } });
    await h.controller.start();

    await h.fake.emit(
      ClientEvent.Sync,
      SyncState.Error,
      SyncState.Syncing,
      { error: matrixError("M_UNKNOWN_TOKEN", 401, "rejected token super-secret-leak-xyz") },
    );

    const logDump = JSON.stringify([
      vi.mocked(h.logger.error).mock.calls,
      vi.mocked(h.logger.warn).mock.calls,
      vi.mocked(h.logger.info).mock.calls,
    ]);
    expect(logDump).not.toContain("super-secret-leak-xyz");
    expect(JSON.stringify(h.healthSignals)).not.toContain("super-secret-leak-xyz");
  });
});
