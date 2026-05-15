// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: iMessage × DM — file-based imsg shim roundtrip.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09 Wave D).
 *
 * Scope: spawns the mock imsg shell shim (from Wave B7) and asserts:
 *   1. The shim's binary path can be invoked as a child process.
 *   2. JSON-RPC `send` requests written to the shim's stdin are
 *      captured in the mock's outbox.jsonl.
 *   3. Inbound JSON events appended to inbox.jsonl are emitted as
 *      JSON-RPC notifications on the shim's stdout.
 *
 * This is a FILE-BASED fixture (no network) — see mock-imessage-server.ts
 * Wave B7 commentary for the design rationale (the iMessage adapter
 * spawns the imsg CLI as a subprocess and talks over stdin/stdout).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createMockIMessageServer, type MockIMessageServer } from "./mocks/imessage/mock-imessage-server.js";

describe("E2E: imessage × dm — file-based imsg shim roundtrip (COV-15)", () => {
  let mock: MockIMessageServer;
  let binaryPath: string;
  let proc: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    mock = createMockIMessageServer();
    const handle = await mock.start();
    binaryPath = handle.binaryPath;
  });

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill();
      // Wait for the process to actually terminate so afterEach mock.stop
      // can rm -rf the temp dir cleanly.
      await new Promise<void>((resolve) => {
        proc!.once("exit", () => resolve());
        setTimeout(() => resolve(), 1000);
      });
    }
    if (mock) {
      await mock.stop();
    }
  });

  it("captures a JSON-RPC 'send' request written to the shim's stdin", async () => {
    proc = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    // Wait for the shim to be ready (its tail subprocess must start before
    // we write to stdin — otherwise the shim's main read loop may consume
    // our request before the file-write side has flushed). Poll stdout for
    // the first byte (the shim emits nothing until it gets a request, so
    // we instead probe by checking process state).
    await new Promise((r) => setTimeout(r, 200));

    // Send one JSON-RPC `send` request.
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "send",
        id: 1,
        params: { chatId: "imessage-test-channel-dm", text: "Hello from comis-bot" },
      }) + "\n",
    );

    // Poll-wait for the outbox to record the request — robust against
    // platform-dependent stdin → file-append latency. Cap at 3s.
    const start = Date.now();
    while (mock.getRequestCount("send") === 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(mock.getRequestCount("send")).toBe(1);
    const events = mock.getCapturedEvents();
    const sendEvent = events.find((e) => e.type === "send");
    expect(sendEvent).toBeDefined();
    expect(sendEvent!.payload.chatId).toBe("imessage-test-channel-dm");
    expect(sendEvent!.payload.text).toBe("Hello from comis-bot");
  });

  it("emits inbound JSON-RPC notifications on stdout when inbox.jsonl is appended", async () => {
    proc = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    // Collect stdout lines.
    const received: string[] = [];
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      received.push(chunk.toString());
    });
    // Wait briefly for the shim's tail-F to start.
    await new Promise((r) => setTimeout(r, 200));

    mock.injectInboundMessage({
      from: "imessage-test-sender-id",
      channel: "imessage-test-channel-dm",
      content: "Hi bot from imessage user",
    });

    // Wait for the tail loop to read the inbox and write the notification.
    const start = Date.now();
    while (
      !received.some((line) => line.includes("Hi bot from imessage user")) &&
      Date.now() - start < 2000
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const combined = received.join("");
    expect(combined).toContain('"jsonrpc":"2.0"');
    expect(combined).toContain('"method":"message"');
    expect(combined).toContain("imessage-test-channel-dm");
    expect(combined).toContain("Hi bot from imessage user");
  });
});
