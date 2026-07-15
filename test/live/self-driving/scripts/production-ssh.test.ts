import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  buildSshProcessArgs,
  createProductionSshExecutor,
  resolveSshOperationTimeout,
  resolveSshStdoutLimit,
  type ProductionSshChildProcess,
} from "./production-ssh.js";

interface ControllableSshChild extends ProductionSshChildProcess {
  readonly stdout: PassThrough;
  readonly emitEvent: (event: "close" | "error", value?: unknown) => void;
}

function makeChild(): ControllableSshChild {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    emitEvent: (event, value) => {
      events.emit(event, value);
    },
  };
}

describe("production replay SSH boundary", () => {
  it("builds a non-interactive argument vector without a local shell", () => {
    const args = buildSshProcessArgs({
      label: "probe-source",
      host: "ubuntu@comis-harel",
      args: ["bash", "-s", "--", "comis", "/home/comis/.comis", "comis"],
      stdin: "probe",
    });

    expect(args).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "--",
      "ubuntu@comis-harel",
      "bash",
      "-s",
      "--",
      "comis",
      "/home/comis/.comis",
      "comis",
    ]);
    expect(args).not.toContain("sh -c");
  });

  it("models a non-default SSH port as an option before the endpoint", () => {
    const args = buildSshProcessArgs({
      label: "probe-target",
      host: "test-host",
      port: 2222,
      args: ["bash", "-s"],
      stdin: "probe",
    });

    expect(args.slice(-6)).toEqual(["-p", "2222", "--", "test-host", "bash", "-s"]);
  });

  it("allows an explicit bounded manifest output limit without making it unbounded", () => {
    const invocation = {
      label: "read-manifest",
      host: "test-host",
      args: ["bash", "-s"],
      stdin: "probe",
    };

    expect(resolveSshStdoutLimit(invocation)).toBe(8 * 1024 * 1024);
    expect(
      resolveSshStdoutLimit({ ...invocation, stdoutLimitBytes: 64 * 1024 * 1024 }),
    ).toBe(64 * 1024 * 1024);
    expect(
      resolveSshStdoutLimit({ ...invocation, stdoutLimitBytes: 64 * 1024 * 1024 + 1 }),
    ).toBeNull();
  });

  it("uses a bounded operation deadline suitable for long remote stages", () => {
    const invocation = {
      label: "read-manifest",
      host: "test-host",
      args: ["bash", "-s"],
      stdin: "probe",
    };

    expect(resolveSshOperationTimeout(invocation)).toBe(6 * 60 * 60 * 1_000);
    expect(
      resolveSshOperationTimeout({ ...invocation, timeoutMs: 6 * 60 * 60 * 1_000 }),
    ).toBe(6 * 60 * 60 * 1_000);
    expect(
      resolveSshOperationTimeout({ ...invocation, timeoutMs: 24 * 60 * 60 * 1_000 + 1 }),
    ).toBeNull();
  });

  it("settles a connected command that ignores both termination signals", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const executor = createProductionSshExecutor({
        spawnProcess: vi.fn(() => child),
        terminationGraceMs: 25,
      });
      const running = executor.run({
        label: "hung-stage",
        host: "test-host",
        args: ["bash", "-s", "--", "private-command"],
        stdin: "private-input",
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

      await vi.advanceTimersByTimeAsync(25);
      await expect(running).resolves.toEqual({
        ok: false,
        error: {
          kind: "remote",
          message: "SSH stage hung-stage exceeded its operation deadline",
        },
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(child.stdin.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      child.emitEvent("close", 0);
      await vi.runAllTimersAsync();
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps successful remote output behavior and clears its deadline", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const executor = createProductionSshExecutor({ spawnProcess: vi.fn(() => child) });
      const running = executor.run({
        label: "normal-stage",
        host: "test-host",
        args: ["bash", "-s"],
        stdin: "probe",
        timeoutMs: 100,
      });

      child.stdout.write("manifest\n");
      child.emitEvent("close", 0);

      await expect(running).resolves.toEqual({
        ok: true,
        value: { stdout: "manifest\n", exitCode: 0 },
      });
      expect(child.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave an escalation timer when SIGTERM closes the process synchronously", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      vi.mocked(child.kill).mockImplementation((signal) => {
        if (signal === "SIGTERM") child.emitEvent("close", 143);
        return true;
      });
      const executor = createProductionSshExecutor({
        spawnProcess: vi.fn(() => child),
        terminationGraceMs: 25,
      });
      const running = executor.run({
        label: "responsive-stage",
        host: "test-host",
        args: ["bash", "-s"],
        stdin: "probe",
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(running).resolves.toEqual({
        ok: false,
        error: {
          kind: "remote",
          message: "SSH stage responsive-stage exceeded its operation deadline",
        },
      });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
