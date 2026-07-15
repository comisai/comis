import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  buildRemoteLeaseSshArgs,
  createProductionRemoteLeaseClient,
  type ProductionRemoteLeaseChildProcess,
  type ProductionRemoteLeaseRequest,
} from "./production-remote-lease.js";

interface ControllableLeaseChild extends ProductionRemoteLeaseChildProcess {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly emitEvent: (event: "close" | "error", value?: unknown) => void;
}

function makeChild(): ControllableLeaseChild {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: ControllableLeaseChild = {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    on(event, listener) {
      events.on(event, listener);
      return child;
    },
    emitEvent(event, value) {
      events.emit(event, value);
    },
  };
  return child;
}

function makeRequest(
  overrides: Partial<ProductionRemoteLeaseRequest> = {},
): ProductionRemoteLeaseRequest {
  return {
    label: "runtime-vault-controller",
    host: "target-host",
    args: ["sudo", "bash", "-s", "--", "runtime vault"],
    remoteProgram: "set -euo pipefail\nprintf 'LEASE_READY\\n'\nread -r _ || true\n",
    readyLine: "LEASE_READY",
    startupTimeoutMs: 100,
    leaseTimeoutMs: 1_000,
    releaseTimeoutMs: 100,
    ...overrides,
  };
}

describe("production remote SSH lease", () => {
  it("quotes every remote argument while keeping the local shell disabled", () => {
    const literalArguments = [
      "space separated",
      "single'quote",
      "$(printf command-substitution)",
      "semicolon;printf injected",
      "line one\nline two",
    ];
    const args = buildRemoteLeaseSshArgs({
      host: "target-host",
      port: 2202,
      args: [
        "sh",
        "-c",
        "printf '%s\\037' \"$@\"",
        "remote-command",
        ...literalArguments,
      ],
    });
    const remoteCommand = args.slice(args.indexOf("target-host") + 1).join(" ");

    const execution = spawnSync("sh", ["-c", remoteCommand], { encoding: "utf8" });

    expect(args.slice(0, 12)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-p",
      "2202",
      "--",
      "target-host",
    ]);
    expect(execution.status).toBe(0);
    expect(execution.stdout.split("\u001f").slice(0, -1)).toEqual(literalArguments);
  });

  it("delivers the bounded program and holds stdin open after exact readiness", async () => {
    const child = makeChild();
    const programChunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => programChunks.push(chunk));
    const spawnProcess = vi.fn(() => child);
    const client = createProductionRemoteLeaseClient({ spawnProcess });

    let acquired = false;
    const acquiring = client.acquire(makeRequest()).then((result) => {
      acquired = true;
      return result;
    });
    child.stdout.write("LEASE_");
    await Promise.resolve();
    expect(acquired).toBe(false);
    child.stdout.write("READY\n");

    const result = await acquiring;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.concat(programChunks).toString("utf8")).toBe(
      makeRequest().remoteProgram,
    );
    expect(child.stdin.writableEnded).toBe(false);
    expect(spawnProcess).toHaveBeenCalledWith(
      "ssh",
      expect.any(Array),
      { stdio: ["pipe", "pipe", "pipe"], shell: false },
    );

    const releasing = result.value.release();
    expect(child.stdin.writableEnded).toBe(true);
    child.emitEvent("close", 0);
    await expect(releasing).resolves.toEqual({
      ok: true,
      value: { exitCode: 0 },
    });
  });

  it("executes a real bash stdin program before the lease input reaches EOF", async () => {
    const client = createProductionRemoteLeaseClient({
      spawnProcess: () =>
        spawn("bash", ["-s"], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        }) as unknown as ProductionRemoteLeaseChildProcess,
    });

    const acquired = await client.acquire(
      makeRequest({
        startupTimeoutMs: 1_000,
        releaseTimeoutMs: 1_000,
      }),
    );

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    await expect(acquired.value.release()).resolves.toEqual({
      ok: true,
      value: { exitCode: 0 },
    });
  });

  it("rejects an inexact readiness line without exposing remote stderr", async () => {
    const child = makeChild();
    const client = createProductionRemoteLeaseClient({
      spawnProcess: vi.fn(() => child),
    });
    const acquiring = client.acquire(makeRequest());

    child.stderr.write("private-token-value\n");
    child.stdout.write("ALMOST_READY\n");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emitEvent("close", 143);

    const result = await acquiring;
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "protocol_failure",
        message: "Remote lease runtime-vault-controller returned an invalid readiness response",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-token-value");
    expect(child.stderr.readableFlowing).toBe(true);
  });

  it("rejects oversized or ambiguous remote programs before spawning SSH", async () => {
    const spawnProcess = vi.fn();
    const client = createProductionRemoteLeaseClient({ spawnProcess });

    const oversized = await client.acquire(
      makeRequest({ remoteProgram: "x".repeat(256 * 1024 + 1) }),
    );
    const ambiguousReadyLine = await client.acquire(
      makeRequest({ readyLine: "LEASE_READY\nSECOND_LINE" }),
    );

    expect(oversized).toEqual({
      ok: false,
      error: { kind: "invalid_request", message: "Remote lease request is invalid" },
    });
    expect(ambiguousReadyLine).toEqual({
      ok: false,
      error: { kind: "invalid_request", message: "Remote lease request is invalid" },
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("terminates a process that misses the bounded startup deadline", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const client = createProductionRemoteLeaseClient({
        spawnProcess: vi.fn(() => child),
        terminationGraceMs: 20,
      });
      const acquiring = client.acquire(makeRequest({ startupTimeoutMs: 100 }));

      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(20);

      await expect(acquiring).resolves.toEqual({
        ok: false,
        error: {
          kind: "deadline",
          message: "Remote lease runtime-vault-controller exceeded its startup deadline",
        },
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a ready lease when its maximum lifetime expires", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const client = createProductionRemoteLeaseClient({
        spawnProcess: vi.fn(() => child),
        terminationGraceMs: 20,
      });
      const acquiring = client.acquire(makeRequest({ leaseTimeoutMs: 100 }));
      child.stdout.write("LEASE_READY\n");
      const acquired = await acquiring;
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(20);

      await expect(acquired.value.release()).resolves.toEqual({
        ok: false,
        error: {
          kind: "deadline",
          message: "Remote lease runtime-vault-controller exceeded its lease deadline",
        },
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the lease deadline result when release races termination", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const client = createProductionRemoteLeaseClient({
        spawnProcess: vi.fn(() => child),
        terminationGraceMs: 20,
      });
      const acquiring = client.acquire(makeRequest({ leaseTimeoutMs: 100 }));
      child.stdout.write("LEASE_READY\n");
      const acquired = await acquiring;
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      await vi.advanceTimersByTimeAsync(100);
      const releasing = acquired.value.release();
      child.emitEvent("close", 143);

      await expect(releasing).resolves.toEqual({
        ok: false,
        error: {
          kind: "deadline",
          message: "Remote lease runtime-vault-controller exceeded its lease deadline",
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes release idempotent and requires a clean remote exit", async () => {
    const child = makeChild();
    const client = createProductionRemoteLeaseClient({
      spawnProcess: vi.fn(() => child),
    });
    const acquiring = client.acquire(makeRequest());
    child.stdout.write("LEASE_READY\n");
    const acquired = await acquiring;
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const firstRelease = acquired.value.release();
    const secondRelease = acquired.value.release();
    expect(secondRelease).toBe(firstRelease);
    child.emitEvent("close", 23);

    const expectedFailure = {
      ok: false,
      error: {
        kind: "remote_failure",
        message: "Remote lease runtime-vault-controller exited unsuccessfully",
      },
    } as const;
    await expect(firstRelease).resolves.toEqual(expectedFailure);
    await expect(acquired.value.release()).resolves.toEqual(expectedFailure);
  });

  it("terminates a remote that does not exit within the release deadline", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const client = createProductionRemoteLeaseClient({
        spawnProcess: vi.fn(() => child),
        terminationGraceMs: 20,
      });
      const acquiring = client.acquire(makeRequest({ releaseTimeoutMs: 100 }));
      child.stdout.write("LEASE_READY\n");
      const acquired = await acquiring;
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      const releasing = acquired.value.release();
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(20);

      await expect(releasing).resolves.toEqual({
        ok: false,
        error: {
          kind: "deadline",
          message: "Remote lease runtime-vault-controller exceeded its release deadline",
        },
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a process that exits after readiness but before release", async () => {
    const child = makeChild();
    const client = createProductionRemoteLeaseClient({
      spawnProcess: vi.fn(() => child),
    });
    const acquiring = client.acquire(makeRequest());
    child.stdout.write("LEASE_READY\n");
    const acquired = await acquiring;
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    child.emitEvent("close", 0);

    await expect(acquired.value.release()).resolves.toEqual({
      ok: false,
      error: {
        kind: "remote_failure",
        message: "Remote lease runtime-vault-controller exited before release",
      },
    });
  });
});
