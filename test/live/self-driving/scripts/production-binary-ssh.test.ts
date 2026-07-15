import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  buildBinarySshArgs,
  createProductionBinarySshBridge,
  type BinaryChildProcess,
} from "./production-binary-ssh.js";

function makeChild(options: {
  readonly stdout?: PassThrough;
  readonly exitCode?: number;
  readonly autoClose?: boolean;
} = {}): BinaryChildProcess {
  const stdin = new PassThrough();
  const stdout = options.stdout ?? new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child: BinaryChildProcess = {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
      return child;
    }),
  };
  if (options.autoClose !== false) {
    queueMicrotask(() => {
      for (const listener of listeners.get("close") ?? []) listener(options.exitCode ?? 0);
    });
  }
  return child;
}

describe("production binary SSH bridge", () => {
  it("places a configured SSH port before the endpoint without a shell", () => {
    expect(
      buildBinarySshArgs({
        host: "source-host",
        port: 2202,
        args: ["sudo", "dd", "if=/run/capture/snapshot.tar", "status=none"],
      }).slice(-8),
    ).toEqual([
      "-p",
      "2202",
      "--",
      "source-host",
      "sudo",
      "dd",
      "if=/run/capture/snapshot.tar",
      "status=none",
    ]);
  });

  it("streams secret-bearing bytes directly between SSH processes", async () => {
    const sourceOutput = new PassThrough();
    const target = makeChild();
    const received: Buffer[] = [];
    target.stdin.on("data", (chunk: Buffer) => received.push(chunk));
    const source = makeChild({ stdout: sourceOutput });
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(target)
      .mockReturnValueOnce(source);
    const bridge = createProductionBinarySshBridge({ spawnProcess });

    const running = bridge.transfer({
      label: "snapshot-archive",
      expectedBytes: 17,
      source: { host: "source-host", args: ["sudo", "dd", "if=archive", "status=none"] },
      target: { host: "target-host", args: ["sudo", "dd", "of=archive", "status=none"] },
    });
    sourceOutput.end(Buffer.from("encrypted-by-ssh!"));
    const result = await running;

    expect(result).toEqual({ ok: true, value: { bytesTransferred: 17 } });
    expect(Buffer.concat(received).toString("utf8")).toBe("encrypted-by-ssh!");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("fails closed and terminates both processes when byte count differs", async () => {
    const sourceOutput = new PassThrough();
    const target = makeChild();
    const source = makeChild({ stdout: sourceOutput });
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(target)
      .mockReturnValueOnce(source);
    const bridge = createProductionBinarySshBridge({ spawnProcess });

    const running = bridge.transfer({
      label: "snapshot-archive",
      expectedBytes: 4,
      source: { host: "source-host", args: ["read"] },
      target: { host: "target-host", args: ["write"] },
    });
    sourceOutput.end(Buffer.from("too-many-bytes"));
    const result = await running;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "byte_mismatch",
        message: "Binary SSH stage snapshot-archive transferred an unexpected byte count",
      });
    }
    expect(source.kill).toHaveBeenCalled();
    expect(target.kill).toHaveBeenCalled();
  });

  it("supports a bounded stream when the tar byte count is not known before transfer", async () => {
    const sourceOutput = new PassThrough();
    const target = makeChild();
    const source = makeChild({ stdout: sourceOutput });
    const bridge = createProductionBinarySshBridge({
      spawnProcess: vi.fn().mockReturnValueOnce(target).mockReturnValueOnce(source),
    });

    const running = bridge.transfer({
      label: "snapshot-tar-stream",
      maximumBytes: 1024,
      source: { host: "source-host", args: ["stream"] },
      target: { host: "target-host", args: ["receive"] },
    });
    sourceOutput.end(Buffer.alloc(513, 7));
    const result = await running;

    expect(result).toEqual({ ok: true, value: { bytesTransferred: 513 } });
  });

  it("terminates an unknown-size stream that exceeds its declared maximum", async () => {
    const sourceOutput = new PassThrough();
    const target = makeChild();
    const source = makeChild({ stdout: sourceOutput });
    const bridge = createProductionBinarySshBridge({
      spawnProcess: vi.fn().mockReturnValueOnce(target).mockReturnValueOnce(source),
    });

    const running = bridge.transfer({
      label: "snapshot-tar-stream",
      maximumBytes: 4,
      source: { host: "source-host", args: ["stream"] },
      target: { host: "target-host", args: ["receive"] },
    });
    sourceOutput.end(Buffer.from("too-large"));
    const result = await running;

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "limit_exceeded",
        message: "Binary SSH stage snapshot-tar-stream exceeded its byte limit",
      },
    });
  });

  it("reports only the stage name when a remote endpoint exits unsuccessfully", async () => {
    const sourceOutput = new PassThrough();
    const target = makeChild({ exitCode: 23 });
    const source = makeChild({ stdout: sourceOutput });
    const bridge = createProductionBinarySshBridge({
      spawnProcess: vi.fn().mockReturnValueOnce(target).mockReturnValueOnce(source),
    });

    const running = bridge.transfer({
      label: "runtime-tree",
      expectedBytes: 0,
      source: { host: "source-host", args: ["read"] },
      target: { host: "target-host", args: ["write"] },
    });
    sourceOutput.end();
    const result = await running;

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "remote_failure",
        message: "Binary SSH stage runtime-tree exited unsuccessfully",
      },
    });
  });

  it("terminates a stalled pipeline and settles when both remotes ignore termination", async () => {
    vi.useFakeTimers();
    try {
      const sourceOutput = new PassThrough();
      const target = makeChild({ autoClose: false });
      const source = makeChild({ stdout: sourceOutput, autoClose: false });
      const bridge = createProductionBinarySshBridge({
        spawnProcess: vi.fn().mockReturnValueOnce(target).mockReturnValueOnce(source),
        terminationGraceMs: 20,
      });

      const running = bridge.transfer({
        label: "stalled-transfer",
        maximumBytes: 1024,
        timeoutMs: 100,
        source: { host: "source-host", args: ["private-read"] },
        target: { host: "target-host", args: ["private-write"] },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(source.kill).toHaveBeenCalledWith("SIGTERM");
      expect(target.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(20);

      await expect(running).resolves.toEqual({
        ok: false,
        error: {
          kind: "remote_failure",
          message: "Binary SSH stage stalled-transfer exceeded its operation deadline",
        },
      });
      expect(source.kill).toHaveBeenCalledWith("SIGKILL");
      expect(target.kill).toHaveBeenCalledWith("SIGKILL");
      expect(source.stdout.destroyed).toBe(true);
      expect(target.stdin.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      sourceOutput.end();
      await vi.runAllTimersAsync();
      expect(source.kill).toHaveBeenCalledTimes(2);
      expect(target.kill).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a normal transfer unchanged when an explicit deadline is configured", async () => {
    vi.useFakeTimers();
    try {
      const sourceOutput = new PassThrough();
      const target = makeChild();
      const source = makeChild({ stdout: sourceOutput });
      const bridge = createProductionBinarySshBridge({
        spawnProcess: vi.fn().mockReturnValueOnce(target).mockReturnValueOnce(source),
      });

      const running = bridge.transfer({
        label: "bounded-normal-transfer",
        expectedBytes: 4,
        timeoutMs: 100,
        source: { host: "source-host", args: ["read"] },
        target: { host: "target-host", args: ["write"] },
      });
      sourceOutput.end(Buffer.from("safe"));

      await expect(running).resolves.toEqual({ ok: true, value: { bytesTransferred: 4 } });
      expect(source.kill).not.toHaveBeenCalled();
      expect(target.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
