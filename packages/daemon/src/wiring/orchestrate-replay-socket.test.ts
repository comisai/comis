// SPDX-License-Identifier: Apache-2.0
/**
 * `createOrchestrateReplaySocket` — the SEPARATE operator replay socket (REPLAY-02).
 *
 * It speaks the SAME `{bearer, method, params}` newline-JSON cap-socket wire, but it
 * has NO LeaseManager, NO rpcCall sink, and NO tool registry: it serves the
 * content-free `results/replay.jsonl` a run recorded, returning the recorded
 * pointer's bytes for a request whose `{method, sha256(params)}` matches the NEXT
 * recorded entry (in-order), and `{error}` on any divergence. This is the
 * load-bearing INV-1 boundary — replay is a physically separate socket, never a
 * MODE of the production capability endpoint.
 *
 * These tests drive a REAL unix socket over a REAL `results/replay.jsonl` on disk
 * (ground truth, never a mock) and prove: in-order byte-identical serving, honest
 * `{error}` on divergence, the 0600 perm, the fail-closed overflow, and that a
 * matched request is served from the recording — there is nothing to dispatch to.
 * @module
 */

import { describe, it, expect } from "vitest";
import net from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayParamsDigest } from "./setup-capability-endpoint.js";
import { createOrchestrateReplaySocket } from "./orchestrate-replay-socket.js";

// ---------------------------------------------------------------------------
// Fixture + client helpers (real fs, real unix socket).
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  result: unknown;
}

/**
 * Write a REAL `results/replay.jsonl` + the per-call pointer files under
 * `workspacePath`, EXACTLY as the recorder does: each pointer file holds
 * `JSON.stringify(result)`; each log line is the content-free
 * `{seq, method, paramsDigest, result: pointer}` (the digest via the SAME
 * exported `replayParamsDigest`, so the socket's match is against real digests).
 */
function writeReplayFixture(workspacePath: string, calls: RecordedCall[]): void {
  const resultsDir = join(workspacePath, "results");
  mkdirSync(resultsDir, { recursive: true });
  const lines = calls.map((call, i) => {
    const pointerName = `ptr-${i}.json`;
    writeFileSync(join(resultsDir, pointerName), JSON.stringify(call.result), "utf8");
    return JSON.stringify({
      seq: i,
      method: call.method,
      paramsDigest: replayParamsDigest(call.params),
      result: `results/${pointerName}`,
    });
  });
  writeFileSync(join(resultsDir, "replay.jsonl"), lines.join("\n") + "\n", "utf8");
}

/** Send ONE `{bearer, method, params}` line and resolve with the parsed `{result}|{error}`. */
function callSocket(
  socketPath: string,
  req: { bearer: string; method: string; params: Record<string, unknown> },
): Promise<{ result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    let buf = "";
    client.on("error", reject);
    client.on("connect", () => client.write(JSON.stringify(req) + "\n"));
    client.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        client.end();
        resolve(JSON.parse(line) as { result?: unknown; error?: string });
      }
    });
  });
}

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "replay-sock-"));
}

// ---------------------------------------------------------------------------
// Tests (REPLAY-02).
// ---------------------------------------------------------------------------

describe("createOrchestrateReplaySocket — serves recorded results (REPLAY-02)", () => {
  it("returns the recorded pointer's bytes when {method, sha256(params)} matches the next entry", async () => {
    const ws = freshWorkspace();
    const recorded = { url: "https://x", text: "RECORDED_BODY" };
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: { url: "https://x" } }, result: recorded },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, {
      bearer: "ephemeral-replay-bearer",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: { url: "https://x" } },
    });

    // Byte-identical to what was recorded (deep-equal of the parsed result object).
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual(recorded);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("serves recorded results in RECORDED ORDER across sequential requests", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: { n: 1 } }, result: { first: true } },
      { method: "message.send", params: { channelId: "c", text: "two" }, result: { second: true } },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const r0 = await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: { n: 1 } },
    });
    const r1 = await callSocket(socketPath, {
      bearer: "b",
      method: "message.send",
      params: { channelId: "c", text: "two" },
    });

    expect(r0.result).toEqual({ first: true });
    expect(r1.result).toEqual({ second: true });

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns {error} (honest divergence) when the request does not match the next recorded entry", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: { url: "https://x" } }, result: { ok: true } },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    // Wrong method → divergence. NOT a real dispatch (there is nothing to dispatch to).
    const wrongMethod = await callSocket(socketPath, {
      bearer: "b",
      method: "message.send",
      params: { tool: "web_fetch", args: { url: "https://x" } },
    });
    expect(wrongMethod.result).toBeUndefined();
    expect(typeof wrongMethod.error).toBe("string");

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns {error} when the params digest diverges (same method, different params)", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: { url: "https://x" } }, result: { ok: true } },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const diverged = await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: { url: "https://DIFFERENT" } },
    });
    expect(diverged.result).toBeUndefined();
    expect(typeof diverged.error).toBe("string");

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("serves recorded results ONLY — a recorded message.send returns the recorded bytes, never a live send (INV-1)", async () => {
    const ws = freshWorkspace();
    // A message.send is recorded with a sentinel result. If the socket dispatched
    // a real send it could not produce this sentinel — it can ONLY serve the recording.
    const sentinel = { delivered: "REPLAYED_SENTINEL_NOT_A_LIVE_SEND" };
    writeReplayFixture(ws, [
      { method: "message.send", params: { channelId: "c", text: "hi" }, result: sentinel },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, {
      bearer: "b",
      method: "message.send",
      params: { channelId: "c", text: "hi" },
    });
    expect(reply.result).toEqual(sentinel);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("creates the socket file with 0600 owner-only perms and unlinks it on close", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, []);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    expect(existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    await socket.close();
    expect(existsSync(socketPath)).toBe(false);

    rmSync(ws, { recursive: true, force: true });
  });

  it("destroys a connection that overflows the receive buffer without a newline (fail-closed)", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, []);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const client = net.connect(socketPath);
    client.on("error", () => {}); // expected EPIPE/ECONNRESET when the server destroys mid-write
    await new Promise<void>((res) => client.on("connect", () => res()));
    const closed = new Promise<void>((res) => client.on("close", () => res()));
    client.write("x".repeat(128 * 1024)); // > 64 KiB, no newline → overflow → destroy
    await closed;

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns {error} for every request once the recorded results are exhausted", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: {} }, result: { only: true } },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const first = await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: {} },
    });
    expect(first.result).toEqual({ only: true });

    // A second matching-shaped call has no further recorded entry → divergence.
    const second = await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: {} },
    });
    expect(second.result).toBeUndefined();
    expect(typeof second.error).toBe("string");

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });
});
