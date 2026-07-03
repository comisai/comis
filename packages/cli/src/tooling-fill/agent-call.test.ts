// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for callAgent — POST /api/chat with bearer auth, parse {response}.
 *
 * Mock pattern (ESM-friendly): replace `node:http` at module-load time with
 * a wrapper that delegates to the actual module by default; per-test
 * overrides flip `http.request` via `vi.mocked(...).mockImplementationOnce`.
 *
 * Each scripted request fakes a ClientRequest with `write/end/destroy/on`
 * and either calls the response callback (for status-driven tests) or
 * emits `error` / `timeout` on the fake request (for failure-mode tests).
 *
 * @module
 */

import { EventEmitter } from "node:events";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    default: { ...actual, request: vi.fn() },
    request: vi.fn(),
  };
});

const http = await import("node:http");
const { callAgent } = await import("./agent-call.js");

type FakeReq = EventEmitter & {
  write: Mock;
  end: Mock;
  destroy: Mock;
};

interface ScriptedResponse {
  statusCode: number;
  body: string;
}

/**
 * Configure http.request to call the supplied response callback with a
 * scripted IncomingMessage (status + body), and return a fake request
 * whose write/end/destroy are spies. Returns the fake req so the test can
 * inspect captured args.
 */
function scriptResponse(scripted: ScriptedResponse): {
  fakeReq: FakeReq;
  capturedOpts: { current: http.RequestOptions | null };
  capturedBody: { current: string };
} {
  const fakeReq = new EventEmitter() as FakeReq;
  fakeReq.write = vi.fn((chunk: string | Buffer) => {
    capturedBody.current = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    return true;
  });
  fakeReq.end = vi.fn();
  fakeReq.destroy = vi.fn();
  const capturedOpts = { current: null as http.RequestOptions | null };
  const capturedBody = { current: "" };

  vi.mocked(http.request).mockImplementationOnce(
    ((opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
      capturedOpts.current = opts;
      const fakeRes = new EventEmitter() as http.IncomingMessage;
      (fakeRes as { statusCode?: number }).statusCode = scripted.statusCode;
      setImmediate(() => {
        cb(fakeRes);
        fakeRes.emit("data", Buffer.from(scripted.body, "utf-8"));
        fakeRes.emit("end");
      });
      return fakeReq as unknown as http.ClientRequest;
    }) as unknown as typeof http.request,
  );

  return { fakeReq, capturedOpts, capturedBody };
}

/** Configure http.request to emit an error event on the fake req before any response. */
function scriptError(errno: NodeJS.ErrnoException): { fakeReq: FakeReq } {
  const fakeReq = new EventEmitter() as FakeReq;
  fakeReq.write = vi.fn();
  fakeReq.end = vi.fn();
  fakeReq.destroy = vi.fn();
  vi.mocked(http.request).mockImplementationOnce(
    ((_opts: http.RequestOptions, _cb: unknown) => {
      setImmediate(() => fakeReq.emit("error", errno));
      return fakeReq as unknown as http.ClientRequest;
    }) as unknown as typeof http.request,
  );
  return { fakeReq };
}

/** Configure http.request to emit a "timeout" event on the fake req. */
function scriptTimeout(): { fakeReq: FakeReq } {
  const fakeReq = new EventEmitter() as FakeReq;
  fakeReq.write = vi.fn();
  fakeReq.end = vi.fn();
  fakeReq.destroy = vi.fn();
  vi.mocked(http.request).mockImplementationOnce(
    ((_opts: http.RequestOptions, _cb: unknown) => {
      setImmediate(() => fakeReq.emit("timeout"));
      return fakeReq as unknown as http.ClientRequest;
    }) as unknown as typeof http.request,
  );
  return { fakeReq };
}

beforeEach(() => {
  vi.mocked(http.request).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("callAgent", () => {
  it("returns ok({ response }) on 200 with a parseable {response} body", async () => {
    scriptResponse({
      statusCode: 200,
      body: JSON.stringify({
        response: "DESCRIPTION: x\nREPLACES_PACKAGES: []",
        tokensUsed: { input: 1, output: 2, total: 3 },
        finishReason: "stop",
      }),
    });

    const result = await callAgent({
      port: 4766,
      token: "test-token",
      prompt: "fill yfinance",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toBe(
        "DESCRIPTION: x\nREPLACES_PACKAGES: []",
      );
    }
  });

  it("posts {message, agentId} when agentId is supplied", async () => {
    const { capturedBody } = scriptResponse({
      statusCode: 200,
      body: JSON.stringify({ response: "ok" }),
    });

    await callAgent({
      port: 4766,
      token: "t",
      prompt: "do stuff",
      agentId: "default",
    });

    const body = JSON.parse(capturedBody.current) as Record<string, unknown>;
    expect(body).toEqual({ message: "do stuff", agentId: "default" });
  });

  it("sets Authorization: Bearer <token> and Content-Type: application/json", async () => {
    const { capturedOpts } = scriptResponse({
      statusCode: 200,
      body: JSON.stringify({ response: "ok" }),
    });

    await callAgent({
      port: 4766,
      token: "test-token",
      prompt: "p",
    });

    const headers = (capturedOpts.current?.headers ?? {}) as Record<
      string,
      unknown
    >;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(capturedOpts.current?.method).toBe("POST");
    expect(capturedOpts.current?.path).toBe("/api/chat");
  });

  it("returns err({kind:'auth'}) on 401", async () => {
    scriptResponse({
      statusCode: 401,
      body: JSON.stringify({ error: "unauthorized" }),
    });

    const result = await callAgent({
      port: 4766,
      token: "bad",
      prompt: "p",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("auth");
      expect(result.error.status).toBe(401);
      expect(result.error.message).toBe(
        "Unauthorized — check COMIS_GATEWAY_TOKEN",
      );
    }
  });

  it("returns err({kind:'dependency'}) on 500 surfacing the server error message", async () => {
    scriptResponse({
      statusCode: 500,
      body: JSON.stringify({ error: "agent crashed" }),
    });

    const result = await callAgent({ port: 4766, token: "t", prompt: "p" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("dependency");
      expect(result.error.status).toBe(500);
      expect(result.error.message).toBe("agent crashed");
    }
  });

  it("returns err({kind:'dependency'}) with 'Invalid response body' on non-JSON", async () => {
    scriptResponse({ statusCode: 500, body: "<html>upstream</html>" });

    const result = await callAgent({ port: 4766, token: "t", prompt: "p" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("dependency");
      expect(result.error.message).toBe("Invalid response body — not JSON");
    }
  });

  it("emits the exact gateway-unreachable message on ECONNREFUSED", async () => {
    const errno = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }) as NodeJS.ErrnoException;
    scriptError(errno);

    const result = await callAgent({
      port: 4766,
      token: "t",
      prompt: "p",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.status).toBe(0);
      expect(result.error.message).toBe(
        "Cannot reach Comis daemon — gateway unreachable. Start the daemon and retry.",
      );
    }
  });

  it("returns err({kind:'timeout'}) when the request emits 'timeout'", async () => {
    scriptTimeout();

    const result = await callAgent({
      port: 4766,
      token: "t",
      prompt: "p",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
      expect(result.error.message).toContain("30000ms");
    }
  });

  it("returns err({kind:'validation'}) on 200 with missing 'response' field", async () => {
    scriptResponse({
      statusCode: 200,
      body: JSON.stringify({ tokensUsed: { total: 0 } }),
    });

    const result = await callAgent({
      port: 4766,
      token: "t",
      prompt: "p",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toBe(
        "Response missing 'response' field",
      );
    }
  });

  it("defaults host to 127.0.0.1 when not supplied", async () => {
    const { capturedOpts } = scriptResponse({
      statusCode: 200,
      body: JSON.stringify({ response: "ok" }),
    });

    await callAgent({ port: 4766, token: "t", prompt: "p" });

    expect(capturedOpts.current?.host).toBe("127.0.0.1");
  });
});
