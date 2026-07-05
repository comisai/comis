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
  /** The `m.direct` account-data content the client reports (other MXID → room ids). */
  directContent?: Record<string, string[]>;
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
  userId?: string;
  fake?: FakeMatrixClient;
}

function makeAdapter(over: HarnessOverrides = {}): {
  adapter: ReturnType<typeof createMatrixAdapter>;
  fake: FakeMatrixClient;
  logger: ComisLogger;
  received: NormalizedMessage[];
} {
  const fake = over.fake ?? new FakeMatrixClient();
  const logger = makeLogger();
  const received: NormalizedMessage[] = [];
  const createClientImpl = (_opts: ICreateClientOpts): MatrixClient => fake.asClient();

  const deps: MatrixAdapterDeps = {
    homeserverUrl: over.homeserverUrl ?? "http://127.0.0.1:8008",
    userId: over.userId ?? "@bot:hs",
    accessToken: over.accessToken ?? "token-abc",
    stateDir: tempDir(),
    allowFrom: over.allowFrom ?? [],
    allowMode: over.allowMode ?? "allowlist",
    autoJoinOnInvite: true,
    allowPrivateHomeserver: over.allowPrivateHomeserver ?? true,
    logger,
    createClientImpl: createClientImpl as unknown as typeof sdk.createClient,
  };

  const adapter = createMatrixAdapter(deps);
  adapter.onMessage((m) => {
    received.push(m);
  });
  return { adapter, fake, logger, received };
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
});
