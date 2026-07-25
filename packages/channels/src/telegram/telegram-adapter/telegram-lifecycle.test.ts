// SPDX-License-Identifier: Apache-2.0
/** Telegram polling acknowledgement and shutdown lifecycle regressions. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../credential-validator.js", () => ({
  validateBotToken: vi.fn(),
  validateWebhookSecret: vi.fn(),
}));

vi.mock("./telegram-inbound.js", () => ({
  bindInboundHandlers: vi.fn(),
}));

import { ok } from "@comis/shared";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { validateBotToken } from "../credential-validator.js";
import { startLifecycle, stopLifecycle } from "./telegram-lifecycle.js";
import type { TelegramAdapterDeps, TelegramAdapterState } from "./telegram-adapter-types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeState(
  polling = deferred<void>(),
  options: { ready?: boolean } = {},
): TelegramAdapterState {
  let running = false;
  const bot = {
    api: { setMyCommands: vi.fn().mockResolvedValue(undefined) },
    start: vi.fn((startOptions?: { onStart?: () => void | Promise<void> }) => {
      running = true;
      if (options.ready !== false) void startOptions?.onStart?.();
      return polling.promise;
    }),
    stop: vi.fn(async () => {
      running = false;
      polling.resolve(undefined);
    }),
    isRunning: vi.fn(() => running),
    catch: vi.fn(),
  };
  return {
    bot: bot as unknown as TelegramAdapterState["bot"],
    createBot: vi.fn(() => bot as unknown as TelegramAdapterState["bot"]),
    handlers: [],
    reactionHandlers: [],
    channelId: "telegram-pending",
    pollingTask: null,
    pollingGeneration: 0,
    lifecycleTail: Promise.resolve(),
    inFlightUpdates: new Set(),
    acceptingUpdates: false,
    stopGateTriggered: false,
    inboundHandlersBound: false,
    botIdentity: undefined,
    connected: false,
    startedAt: undefined,
    lastMessageAt: undefined,
    lastError: undefined,
  };
}

function makeDeps(overrides: Partial<TelegramAdapterDeps> = {}): TelegramAdapterDeps {
  return { getBotToken: () => "test-bot-token", logger: createMockLogger(), ...overrides };
}

describe("Telegram sequential polling lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateBotToken).mockResolvedValue(ok({ id: 42, username: "testbot", isBot: true }));
  });

  it("fetches one update at a time and awaits every supported update type", async () => {
    const state = makeState();
    state.lastError = "previous polling failure";

    const result = await startLifecycle(state, makeDeps());

    expect(result.ok).toBe(true);
    expect(state.lastError).toBeUndefined();
    expect(state.bot.start).toHaveBeenCalledTimes(1);
    const options = vi.mocked(state.bot.start).mock.calls[0]?.[0];
    expect(options?.limit).toBe(1);
    expect(options?.allowed_updates).toEqual(expect.arrayContaining([
      "message",
      "edited_message",
      "callback_query",
      "poll",
      "message_reaction",
    ]));
  });

  it("rejects webhook configuration because no webhook receiver is wired", async () => {
    const state = makeState();

    const result = await startLifecycle(state, makeDeps({ webhookUrl: "https://example.com/hook" }));

    expect(result.ok).toBe(false);
    expect(state.bot.start).not.toHaveBeenCalled();
    expect(validateBotToken).not.toHaveBeenCalled();
  });

  it("does not report connected until grammY invokes onStart", async () => {
    const state = makeState(deferred<void>(), { ready: false });
    let settled = false;

    const starting = startLifecycle(state, makeDeps()).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(state.connected).toBe(false);

    const startOptions = vi.mocked(state.bot.start).mock.calls[0]?.[0];
    await startOptions?.onStart?.({} as never);
    const result = await starting;

    expect(result.ok).toBe(true);
    expect(state.connected).toBe(true);
  });

  it("returns an error when polling rejects before grammY becomes ready", async () => {
    const polling = deferred<void>();
    const state = makeState(polling, { ready: false });

    const starting = startLifecycle(state, makeDeps());
    await Promise.resolve();
    polling.reject(new Error("polling initialization failed"));
    const result = await starting;

    expect(result.ok).toBe(false);
    expect(state.connected).toBe(false);
    expect(state.lastError).toContain("polling");
  });

  it("serializes concurrent starts into one polling generation", async () => {
    const state = makeState();

    const [first, second] = await Promise.all([
      startLifecycle(state, makeDeps()),
      startLifecycle(state, makeDeps()),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(state.bot.start).toHaveBeenCalledOnce();
  });

  it("ignores a stale polling rejection after a newer task owns state", async () => {
    const firstPolling = deferred<void>();
    const state = makeState(firstPolling);
    await startLifecycle(state, makeDeps());

    const replacementPolling = deferred<void>();
    state.pollingTask = replacementPolling.promise;
    state.connected = true;
    state.lastError = undefined;
    firstPolling.reject(new Error("stale generation failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(state.pollingTask).toBe(replacementPolling.promise);
    expect(state.connected).toBe(true);
    expect(state.lastError).toBeUndefined();
  });

  it("waits for accepted inbound work before confirming the polling offset on stop", async () => {
    const state = makeState();
    const accepted = deferred<void>();
    state.inFlightUpdates.add(accepted.promise);
    void accepted.promise.then(() => { state.inFlightUpdates.delete(accepted.promise); });
    await startLifecycle(state, makeDeps());

    const stopping = stopLifecycle(state, makeDeps());
    await Promise.resolve();
    expect(state.bot.stop).not.toHaveBeenCalled();

    accepted.resolve(undefined);
    const result = await stopping;

    expect(result.ok).toBe(true);
    expect(state.bot.stop).toHaveBeenCalledOnce();
  });

  it("returns a bounded error without confirming an update whose handler never settles", async () => {
    vi.useFakeTimers();
    try {
      const state = makeState();
      state.inFlightUpdates.add(new Promise<void>(() => undefined));

      const stopping = stopLifecycle(state, makeDeps());
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await stopping;

      expect(result.ok).toBe(false);
      expect(state.bot.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
