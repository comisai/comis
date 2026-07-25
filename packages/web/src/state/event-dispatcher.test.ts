// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventDispatcher, type EventDispatcher } from "./event-dispatcher.js";

const BASE_URL = "http://localhost:3000";
const TOKEN = "test-event-token";

function sseResponse(chunks: readonly string[], close = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (close) {
        controller.close();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function pendingSseResponse(): Response {
  return sseResponse([], false);
}

function cancellableSseResponse(chunk: string, onCancel: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("createEventDispatcher", () => {
  let dispatcher: EventDispatcher;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(pendingSseResponse());
    vi.stubGlobal("fetch", fetchMock);
    dispatcher = createEventDispatcher();
  });

  afterEach(() => {
    dispatcher.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the documented dispatcher surface", () => {
    expect(typeof dispatcher.start).toBe("function");
    expect(typeof dispatcher.stop).toBe("function");
    expect(typeof dispatcher.addEventListener).toBe("function");
    expect(dispatcher.connected).toBe(false);
  });

  it("uses an authenticated fetch whose URL contains neither token nor query string", async () => {
    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/events`);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("?");
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
      },
    });
  });

  it("marks the dispatcher connected after the authenticated stream opens", async () => {
    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(dispatcher.connected).toBe(true));
  });

  it("parses chunk-split CRLF events and delivers JSON through both channels", async () => {
    const callback = vi.fn();
    const documentListener = vi.fn();
    dispatcher.addEventListener("message:received", callback);
    document.addEventListener("message:received", documentListener);
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        ": keepalive\r",
        "\nevent: message:rece",
        "ived\r\nid: 7\r\ndata: {\"messageId\":\"m-1\",",
        "\"channelType\":\"telegram\"}\r",
        "\n\r",
        "\n",
      ]),
    );

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith({ messageId: "m-1", channelType: "telegram" });
    });
    expect(documentListener).toHaveBeenCalledTimes(1);
    expect((documentListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      messageId: "m-1",
      channelType: "telegram",
    });
    document.removeEventListener("message:received", documentListener);
  });

  it("joins multiline data and falls back to the generic message event", async () => {
    const callback = vi.fn();
    dispatcher.addEventListener("message", callback);
    fetchMock.mockResolvedValueOnce(sseResponse(["data: first line\ndata: second line\n\n"]));

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith("first line\nsecond line"));
  });

  it("delivers empty event data as an empty object", async () => {
    const callback = vi.fn();
    dispatcher.addEventListener("ping", callback);
    fetchMock.mockResolvedValueOnce(sseResponse(["event: ping\ndata:\n\n"]));

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
  });

  it("does not deliver an incomplete event when the response stream ends mid-frame", async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    dispatcher.addEventListener("message:received", callback);
    fetchMock.mockResolvedValueOnce(
      sseResponse(["event: message:received\ndata: {\"messageId\":\"partial\"}"]),
    );

    dispatcher.start(BASE_URL, TOKEN);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe function that prevents later delivery", async () => {
    const callback = vi.fn();
    const unsubscribe = dispatcher.addEventListener("approval:requested", callback);
    unsubscribe();
    fetchMock.mockResolvedValueOnce(
      sseResponse(["event: approval:requested\ndata: {\"requestId\":\"a-1\"}\n\n"]),
    );

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
  });

  it("delivers an event to every callback registered for its type", async () => {
    const first = vi.fn();
    const second = vi.fn();
    dispatcher.addEventListener("message:sent", first);
    dispatcher.addEventListener("message:sent", second);
    fetchMock.mockResolvedValueOnce(
      sseResponse(["event: message:sent\ndata: {\"messageId\":\"m-2\"}\n\n"]),
    );

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledWith({ messageId: "m-2" });
      expect(second).toHaveBeenCalledWith({ messageId: "m-2" });
    });
  });

  it("isolates a throwing callback and still delivers to later subscribers and document", async () => {
    const first = vi.fn(() => {
      throw new Error("subscriber failed");
    });
    const second = vi.fn();
    const documentListener = vi.fn();
    dispatcher.addEventListener("message:sent", first);
    dispatcher.addEventListener("message:sent", second);
    document.addEventListener("message:sent", documentListener);
    fetchMock.mockResolvedValueOnce(
      sseResponse(["event: message:sent\ndata: {\"messageId\":\"m-safe\"}\n\n"]),
    );

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(second).toHaveBeenCalledWith({ messageId: "m-safe" }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(documentListener).toHaveBeenCalledTimes(1);
    document.removeEventListener("message:sent", documentListener);
  });

  it("observes a rejecting callback and still delivers to later subscribers and document", async () => {
    const rejectingThen = vi.fn((
      _resolve: ((value: void) => unknown) | null | undefined,
      reject: ((reason: unknown) => unknown) | null | undefined,
    ) => {
      reject?.(new Error("subscriber failed asynchronously"));
      return Promise.resolve();
    });
    const rejectingThenable = { then: rejectingThen } as PromiseLike<void>;
    const first = vi.fn(() => rejectingThenable);
    const second = vi.fn();
    const documentListener = vi.fn();
    dispatcher.addEventListener("message:sent", first);
    dispatcher.addEventListener("message:sent", second);
    document.addEventListener("message:sent", documentListener);
    fetchMock.mockResolvedValueOnce(
      sseResponse(["event: message:sent\ndata: {\"messageId\":\"m-async-safe\"}\n\n"]),
    );

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(rejectingThen).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ messageId: "m-async-safe" });
    expect(documentListener).toHaveBeenCalledTimes(1);
    document.removeEventListener("message:sent", documentListener);
  });

  it("stop aborts the authenticated fetch and clears connected state", async () => {
    dispatcher.start(BASE_URL, TOKEN);
    await vi.waitFor(() => expect(dispatcher.connected).toBe(true));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const signal = init.signal as AbortSignal;

    dispatcher.stop();

    expect(signal.aborted).toBe(true);
    expect(dispatcher.connected).toBe(false);
  });

  it("stop clears callback handlers before a later restart", async () => {
    const callback = vi.fn();
    dispatcher.addEventListener("message:sent", callback);
    dispatcher.start(BASE_URL, TOKEN);
    await vi.waitFor(() => expect(dispatcher.connected).toBe(true));
    dispatcher.stop();
    fetchMock.mockResolvedValueOnce(
      sseResponse(["event: message:sent\ndata: {\"messageId\":\"m-3\"}\n\n"]),
    );

    dispatcher.start(BASE_URL, TOKEN);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
  });

  it("continues reconnecting with capped backoff beyond eight failures", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("network unavailable"));

    dispatcher.start(BASE_URL, TOKEN);
    await vi.advanceTimersByTimeAsync(220_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(9);
    expect(dispatcher.connected).toBe(false);
  });

  it.each([408, 425, 429, 500, 503])(
    "retries transient HTTP status %s",
    async (status) => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(pendingSseResponse());

      dispatcher.start(BASE_URL, TOKEN);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(dispatcher.connected).toBe(true);
    },
  );

  it.each([401, 403])("keeps authentication status %s terminal", async (status) => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status }));

    dispatcher.start(BASE_URL, TOKEN);
    await vi.advanceTimersByTimeAsync(220_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatcher.connected).toBe(false);
  });

  it("honors a valid SSE retry directive for the next connection", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(sseResponse(["retry: 7000\n\n"]))
      .mockResolvedValueOnce(pendingSseResponse());

    dispatcher.start(BASE_URL, TOKEN);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a malformed SSE retry directive", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(sseResponse(["retry: 7seconds\n\n"]))
      .mockResolvedValueOnce(pendingSseResponse());

    dispatcher.start(BASE_URL, TOKEN);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets exponential backoff after a successful connection", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(sseResponse([": opened\n\n"]))
      .mockResolvedValueOnce(pendingSseResponse());

    dispatcher.start(BASE_URL, TOKEN);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("cancels and aborts an oversized event stream before reconnecting", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        cancellableSseResponse(`data: ${"x".repeat(300_000)}`, cancel),
      )
      .mockResolvedValueOnce(pendingSseResponse());

    dispatcher.start(BASE_URL, TOKEN);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((firstInit.signal as AbortSignal).aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts an errored response stream before reconnecting", async () => {
    vi.useFakeTimers();
    const erroredBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream failed"));
      },
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(erroredBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(pendingSseResponse());

    dispatcher.start(BASE_URL, TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((firstInit.signal as AbortSignal).aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
