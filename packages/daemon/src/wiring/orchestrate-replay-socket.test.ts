// SPDX-License-Identifier: Apache-2.0
/**
 * `createOrchestrateReplaySocket` — the physically separate operator replay socket.
 *
 * It speaks the SAME `{bearer, method, params}` newline-JSON cap-socket wire, but it
 * has NO LeaseManager, NO rpcCall sink, and NO tool registry: it serves the
 * content-free `results/replay.jsonl` a run recorded, returning the recorded
 * pointer's bytes for a request whose `{method, sha256(params)}` matches the NEXT
 * recorded entry (in-order), and `{error}` on any divergence. This is the
 * replay is a physically separate socket, never a mode of the production
 * capability endpoint.
 *
 * These tests drive a REAL unix socket over a REAL `results/replay.jsonl` on disk
 * (ground truth, never a mock) and prove: in-order byte-identical serving, honest
 * `{error}` on divergence, the 0600 perm, the fail-closed overflow, and that a
 * matched request is served from the recording — there is nothing to dispatch to.
 * @module
 */

import { describe, it, expect } from "vitest";
import net from "node:net";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayParamsDigest } from "./setup-capability-endpoint.js";
import {
  createOrchestrateReplaySocket as createProductionReplaySocket,
  type OrchestrateReplaySocket,
} from "./orchestrate-replay-socket.js";
import { PER_FILE_CAP_BYTES } from "@comis/core";
import { safeResultRunId } from "@comis/skills/tools";

const ROOT_RUN_ID = "run-replay-socket";
const EXPECTED_BEARER = "expected-ephemeral-replay-bearer";
const TEST_REPLAY_LOG_MAX_BYTES = 1024 * 1024;

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
function writeReplayFixture(
  workspacePath: string,
  calls: RecordedCall[],
  rootRunId = ROOT_RUN_ID,
): void {
  const runDirName = safeResultRunId(rootRunId);
  const resultsDir = join(workspacePath, "results", runDirName);
  mkdirSync(resultsDir, { recursive: true });
  const lines = calls.map((call, i) => {
    const pointerName = `ptr-${i}.json`;
    writeFileSync(join(resultsDir, pointerName), JSON.stringify(call.result), "utf8");
    return JSON.stringify({
      seq: i,
      method: call.method,
      paramsDigest: replayParamsDigest(call.params),
      resultDigest: createHash("sha256").update(JSON.stringify(call.result)).digest("hex"),
      result: `results/${runDirName}/${pointerName}`,
    });
  });
  writeFileSync(join(resultsDir, "replay.jsonl"), lines.join("\n") + "\n", "utf8");
}

/** Send ONE `{bearer, method, params}` line and resolve with the parsed `{result}|{error}`. */
function callSocket(
  socketPath: string,
  req: { bearer?: string; method: string; params: Record<string, unknown> },
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

/** Keep each real-socket fixture explicit about the trusted recording root + bearer. */
function createOrchestrateReplaySocket(input: {
  workspacePath: string;
  recordingRoot?: string;
  runId: string;
  expectedBearer?: string;
}): OrchestrateReplaySocket {
  return createProductionReplaySocket({
    recordingRootPath: input.recordingRoot ?? input.workspacePath,
    runId: input.runId,
    expectedBearer: input.expectedBearer ?? "b",
  });
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("createOrchestrateReplaySocket serves recorded results", () => {
  it("rejects a forged bearer without consuming the next recorded result", async () => {
    const recordingRoot = freshWorkspace();
    writeReplayFixture(recordingRoot, [
      { method: "cron.add", params: { owner: "a" }, result: { recorded: true } },
    ]);
    const socket = createOrchestrateReplaySocket({
      workspacePath: recordingRoot,
      runId: ROOT_RUN_ID,
      expectedBearer: EXPECTED_BEARER,
    } as never);
    const socketPath = join(recordingRoot, "replay.sock");
    await socket.start(socketPath);

    const forged = await callSocket(socketPath, {
      bearer: "forged-replay-bearer",
      method: "cron.add",
      params: { owner: "a" },
    });
    expect(forged).toEqual({ error: "authentication failed" });
    const missing = await callSocket(socketPath, {
      method: "cron.add",
      params: { owner: "a" },
    });
    expect(missing).toEqual({ error: "authentication failed" });

    const authenticated = await callSocket(socketPath, {
      bearer: EXPECTED_BEARER,
      method: "cron.add",
      params: { owner: "a" },
    });
    expect(authenticated).toEqual({ result: { recorded: true } });

    await socket.close();
    rmSync(recordingRoot, { recursive: true, force: true });
  });

  it("reads daemon-owned recordings and ignores a forged agent-workspace replay tree", async () => {
    const workspace = freshWorkspace();
    const recordingRoot = freshWorkspace();
    const call = { method: "cron.add", params: { owner: "a" } };
    writeReplayFixture(workspace, [{ ...call, result: { forged: true } }]);
    writeReplayFixture(recordingRoot, [{ ...call, result: { trusted: true } }]);
    const socket = createOrchestrateReplaySocket({
      workspacePath: workspace,
      recordingRoot,
      runId: ROOT_RUN_ID,
      expectedBearer: EXPECTED_BEARER,
    } as never);
    const socketPath = join(workspace, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, {
      bearer: EXPECTED_BEARER,
      method: call.method,
      params: call.params,
    });
    expect(reply).toEqual({ result: { trusted: true } });

    await socket.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(recordingRoot, { recursive: true, force: true });
  });

  it("rejects a daemon-owned result blob whose bytes no longer match the recorded digest", async () => {
    const recordingRoot = freshWorkspace();
    const method = "tool.invoke";
    const params = { tool: "web_fetch", args: { url: "https://x" } };
    writeReplayFixture(recordingRoot, [{ method, params, result: { trusted: true } }]);
    writeFileSync(
      join(recordingRoot, "results", safeResultRunId(ROOT_RUN_ID), "ptr-0.json"),
      JSON.stringify({ forged: true }),
    );
    const socket = createOrchestrateReplaySocket({
      workspacePath: recordingRoot,
      runId: ROOT_RUN_ID,
      expectedBearer: EXPECTED_BEARER,
    } as never);
    const socketPath = join(recordingRoot, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, {
      bearer: EXPECTED_BEARER,
      method,
      params,
    });
    expect(reply).toEqual({ error: "replay diverged: recorded result integrity check failed" });

    await socket.close();
    rmSync(recordingRoot, { recursive: true, force: true });
  });

  it("loads only the selected run's recording when concurrent runs share one agent workspace", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "cron.add", params: { owner: "a" }, result: { owner: "a" } },
    ], "run-a");
    writeReplayFixture(ws, [
      { method: "cron.add", params: { owner: "b" }, result: { owner: "b" } },
    ], "run-b");
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: "run-b" });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, {
      bearer: "b",
      method: "cron.add",
      params: { owner: "b" },
    });
    expect(reply).toEqual({ result: { owner: "b" } });

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("refuses a replay pointer that crosses into a concurrent run's result directory", async () => {
    const ws = freshWorkspace();
    const method = "cron.add";
    const params = { owner: "b" };
    writeReplayFixture(ws, [
      { method, params, result: { owner: "a-private" } },
    ], "run-a");
    const runADir = safeResultRunId("run-a");
    const runBDir = join(ws, "results", safeResultRunId("run-b"));
    mkdirSync(runBDir, { recursive: true });
    writeFileSync(
      join(runBDir, "replay.jsonl"),
      `${JSON.stringify({
        seq: 0,
        method,
        paramsDigest: replayParamsDigest(params),
        result: `results/${runADir}/ptr-0.json`,
      })}\n`,
    );
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: "run-b" });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, { bearer: "b", method, params });
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatch(/result path/i);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("refuses a recorded result file replaced by a symlink outside the workspace", async () => {
    const ws = freshWorkspace();
    const outside = freshWorkspace();
    const method = "tool.invoke";
    const params = { tool: "web_fetch", args: { url: "https://x" } };
    writeReplayFixture(ws, [
      { method, params, result: { recorded: true } },
    ]);
    const pointerPath = join(
      ws,
      "results",
      safeResultRunId(ROOT_RUN_ID),
      "ptr-0.json",
    );
    const outsidePath = join(outside, "outside.json");
    writeFileSync(outsidePath, JSON.stringify({ outside: true }), "utf8");
    unlinkSync(pointerPath);
    symlinkSync(outsidePath, pointerPath);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, { bearer: "b", method, params });
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatch(/result path/i);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a recorded result file that exceeds the materialized-result cap", async () => {
    const ws = freshWorkspace();
    const method = "tool.invoke";
    const params = { tool: "web_fetch", args: { url: "https://x" } };
    writeReplayFixture(ws, [
      { method, params, result: { recorded: true } },
    ]);
    const pointerPath = join(
      ws,
      "results",
      safeResultRunId(ROOT_RUN_ID),
      "ptr-0.json",
    );
    writeFileSync(pointerPath, JSON.stringify("x".repeat(PER_FILE_CAP_BYTES)), "utf8");
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, { bearer: "b", method, params });
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatch(/result blob is gone/i);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns a content-free divergence for malformed recorded result bytes", async () => {
    const ws = freshWorkspace();
    const method = "tool.invoke";
    const params = { tool: "web_fetch", args: { url: "https://x" } };
    writeReplayFixture(ws, [
      { method, params, result: { recorded: true } },
    ]);
    const pointerPath = join(
      ws,
      "results",
      safeResultRunId(ROOT_RUN_ID),
      "ptr-0.json",
    );
    writeFileSync(pointerPath, "SENSITIVE_RECORDED_BYTES", "utf8");
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, { bearer: "b", method, params });
    expect(reply).toEqual({ error: "replay diverged: recorded result integrity check failed" });
    expect(reply.error).not.toContain("SENSITIVE_RECORDED_BYTES");
    const retried = await callSocket(socketPath, { bearer: "b", method, params });
    expect(retried).toEqual({ error: "replay diverged: recorded result integrity check failed" });

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns the recorded pointer's bytes when {method, sha256(params)} matches the next entry", async () => {
    const ws = freshWorkspace();
    const recorded = { url: "https://x", text: "RECORDED_BODY" };
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: { url: "https://x" } }, result: recorded },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: { url: "https://x" } },
    });

    // Byte-identical to what was recorded (deep-equal of the parsed result object).
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual(recorded);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails replay closed when the persisted replay log exceeds its read bound", async () => {
    const ws = freshWorkspace();
    const params = { tool: "web_fetch", args: { url: "https://x" } };
    writeReplayFixture(ws, [
      { method: "tool.invoke", params, result: { shouldNotLoad: true } },
    ]);
    const logPath = join(
      ws,
      "results",
      safeResultRunId(ROOT_RUN_ID),
      "replay.jsonl",
    );
    truncateSync(logPath, TEST_REPLAY_LOG_MAX_BYTES + 1);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    const reply = await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params,
    });
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatch(/no further recorded results/i);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("serves recorded results in RECORDED ORDER across sequential requests", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: { n: 1 } }, result: { first: true } },
      { method: "message.send", params: { channelId: "c", text: "two" }, result: { second: true } },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
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
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
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
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
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

  it("serves a recorded message.send result without any live dispatch", async () => {
    const ws = freshWorkspace();
    // A message.send is recorded with a sentinel result. If the socket dispatched
    // a real send it could not produce this sentinel — it can ONLY serve the recording.
    const sentinel = { delivered: "REPLAYED_SENTINEL_NOT_A_LIVE_SEND" };
    writeReplayFixture(ws, [
      { method: "message.send", params: { channelId: "c", text: "hi" }, result: sentinel },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
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
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
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
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
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

  it("tracks a sticky diverged() flag — false after only matched calls, true after any divergence", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: { url: "https://x" } }, result: { ok: true } },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
    const socketPath = join(ws, "replay.sock");
    await socket.start(socketPath);

    // A matched, served call does NOT set the flag.
    await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: { url: "https://x" } },
    });
    expect(socket.diverged()).toBe(false);

    // A second call has no further recorded entry → divergence → sticky flag set
    // (the flag is set BEFORE the {error} reply, so it is settled once callSocket resolves).
    const second = await callSocket(socketPath, {
      bearer: "b",
      method: "tool.invoke",
      params: { tool: "web_fetch", args: { url: "https://x" } },
    });
    expect(typeof second.error).toBe("string");
    expect(socket.diverged()).toBe(true);

    await socket.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns {error} for every request once the recorded results are exhausted", async () => {
    const ws = freshWorkspace();
    writeReplayFixture(ws, [
      { method: "tool.invoke", params: { tool: "web_fetch", args: {} }, result: { only: true } },
    ]);
    const socket = createOrchestrateReplaySocket({ workspacePath: ws, runId: ROOT_RUN_ID });
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
