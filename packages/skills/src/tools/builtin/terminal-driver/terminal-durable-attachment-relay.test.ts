// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createDurableExecutionAttachmentRelayMaterializer } from "./terminal-durable-attachment-relay.js";

class FakeReadable extends EventEmitter {
  destroy = vi.fn();
}

class FakeWritable extends EventEmitter {
  payload = "";
  end = vi.fn((payload: string) => {
    this.payload = payload;
  });
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit("exit", 0, "SIGTERM"));
    return true;
  });
  readonly unref = vi.fn();
}

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("durable terminal attachment relay lifetime", () => {
  it("launches a detached session-bound helper and transfers attachment authority over stdin", async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child);
    const materialize = createDurableExecutionAttachmentRelayMaterializer({
      logger: silentLogger(),
      nodePath: "/usr/bin/node",
      entryPath: "/opt/comis/terminal-attachment-relay-main.js",
      tmuxPath: "/usr/bin/tmux",
      tmuxSocketForSession: (sessionId) => `/data/t-${sessionId}.sock`,
      tmuxNameForSession: (sessionId) => `comis-${sessionId}`,
      socketDir: "/tmp",
      genId: () => "relay-a",
      spawnProcess,
    });
    const attachment = {
      executionAttachmentId: "execution-attachment_a",
      sourcePath: "/srv/runtime/worker.sock",
      targetName: `attachment-${"a".repeat(32)}.sock`,
      relayIdentity: "ab".repeat(32),
    };

    const pending = materialize(
      [attachment],
      { uid: 65534, gid: 65534 },
      { sessionId: "terminal_a", durability: "durable" },
    );
    queueMicrotask(() => child.stdout.emit("data", Buffer.from("READY\n", "utf8")));
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      expect.arrayContaining([
        "/opt/comis/terminal-attachment-relay-main.js",
        "--directory",
        "/tmp/comis-attachments-relay-a",
        "--session-id",
        "terminal_a",
        "--tmux-socket",
        "/data/t-terminal_a.sock",
        "--tmux-name",
        "comis-terminal_a",
      ]),
      {
        detached: true,
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(JSON.parse(child.stdin.payload)).toEqual({
      attachments: [attachment],
      owner: { uid: 65534, gid: 65534 },
    });
    expect(result.value.attachments).toEqual([{
      ...attachment,
      sourcePath: `/tmp/comis-attachments-relay-a/${attachment.targetName}`,
    }]);

    await expect(result.value.dispose()).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
