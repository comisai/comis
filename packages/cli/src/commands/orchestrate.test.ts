// SPDX-License-Identifier: Apache-2.0
/**
 * `comis orchestrate replay <runId>` CLI tests.
 *
 * Mirrors `cache.test.ts` mocking: `vi.mock` `withClient` while letting the real
 * `callTyped` resolve, so the RPC params (`{ runId }`) + response
 * (`{ stdout, diverged? }`) pass through `OrchestrateReplayContract`'s Zod
 * parsing end-to-end. Asserts the command drives the typed admin RPC and prints
 * the recorded stdout (byte-faithful via process.stdout.write) + a divergence
 * note, and that `--format json` emits the raw response.
 *
 * The cli-uses-typed-rpc architecture gate additionally proves the command uses
 * ONLY `callTyped` (never a raw `client.call`).
 *
 * @module
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockRpcClient } from "../mock-rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";
import type { MockInstance } from "vitest";

// Mock withClient at module level for ESM hoisting; preserve real callTyped.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return { ...actual, withClient: vi.fn() };
});

// Pass-through spinner so tests don't see ora output.
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

const { registerOrchestrateCommand } = await import("./orchestrate.js");
const { withClient } = await import("../client/rpc-client.js");

const REPLAY_PAYLOAD = { stdout: "hello from the replayed run\n", diverged: false };

describe("comis orchestrate replay", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    stdoutSpy.mockRestore();
  });

  it("text mode prints the recorded stdout returned by the orchestrate.replay RPC", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const client = createMockRpcClient().onCall("orchestrate.replay", REPLAY_PAYLOAD).build();
      return fn(client);
    });

    const program = createTestProgram();
    registerOrchestrateCommand(program);
    await program.parseAsync(["node", "test", "orchestrate", "replay", "root-abc"]);

    // The recorded stdout is written verbatim to process.stdout.
    expect(getSpyOutput(stdoutSpy)).toContain("hello from the replayed run");
  });

  it("--format json prints the raw response (stdout + diverged) for scripting", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const client = createMockRpcClient().onCall("orchestrate.replay", REPLAY_PAYLOAD).build();
      return fn(client);
    });

    const program = createTestProgram();
    registerOrchestrateCommand(program);
    await program.parseAsync(["node", "test", "orchestrate", "replay", "root-abc", "--format", "json"]);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("hello from the replayed run");
    expect(out).toContain("diverged");
  });

  it("prints a divergence note when the replay diverged from the recorded results", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const client = createMockRpcClient()
        .onCall("orchestrate.replay", { stdout: "partial\n", diverged: true })
        .build();
      return fn(client);
    });

    const program = createTestProgram();
    registerOrchestrateCommand(program);
    await program.parseAsync(["node", "test", "orchestrate", "replay", "root-xyz"]);

    // A human-readable divergence note goes to the annotated (console) channel…
    expect(getSpyOutput(consoleSpy.log).toLowerCase()).toContain("diverg");
    // …and the (partial) recorded stdout is still printed verbatim.
    expect(getSpyOutput(stdoutSpy)).toContain("partial");
  });

  it("exits non-zero when the RPC fails", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const client = createMockRpcClient().onError("orchestrate.replay", "no resumable orchestrate run found to replay").build();
      return fn(client);
    });

    const program = createTestProgram();
    registerOrchestrateCommand(program);
    await expect(
      program.parseAsync(["node", "test", "orchestrate", "replay", "root-missing"]),
    ).rejects.toThrow("process.exit called");
    expect(getSpyOutput(consoleSpy.error)).toContain("replay failed");
  });
});
