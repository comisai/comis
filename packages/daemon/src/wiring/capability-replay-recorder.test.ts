// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeResultRunId } from "@comis/skills/tools";
import { createReplayRecorder, replayParamsDigest } from "./capability-replay-recorder.js";

const LEASE = {
  leaseId: "lease-a",
  rootRunId: "root-a",
  checkpointId: "checkpoint-a",
  sessionKey: "tenant-a:user-a:chat-a",
  agentId: "agent-a",
  caps: ["orch:read"],
  issuedAt: 0,
  expiresAt: 10,
  audience: ["memory.search"],
  trustLevel: "user",
} as never;
const TEST_REPLAY_LOG_MAX_BYTES = 1024 * 1024;

describe("capability replay recorder", () => {
  it("hashes canonical parameter order without retaining raw values", () => {
    const marker = "private-parameter-marker";
    const first = replayParamsDigest({ z: marker, nested: { b: 2, a: 1 } });
    const second = replayParamsDigest({ nested: { a: 1, b: 2 }, z: marker });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(marker);
  });

  it("contains serialization failures without changing the completed live call", async () => {
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const materialize = vi.fn();
    const recorder = createReplayRecorder({
      isEnabled: () => true,
      recordingRootPath: "/tmp/unused-replay-workspace",
      materialize,
      nowMs: () => 1,
      logger: logger as never,
    });
    const result: Record<string, unknown> = { marker: "private-result-marker" };
    result.self = result;

    await expect(recorder.record(LEASE, "memory.search", {}, result)).resolves.toBeUndefined();

    expect(materialize).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "internal", hint: expect.any(String) }),
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-result-marker");
  });

  it("continues persisted sequence after a crash-truncated tail without concatenating the next line", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "replay-seq-"));
    const runDir = join(workspace, "results", safeResultRunId("checkpoint-a"));
    const logPath = join(runDir, "replay.jsonl");
    try {
      mkdirSync(runDir, { recursive: true });
      appendFileSync(
        logPath,
        `${JSON.stringify({ seq: 7, method: "memory.search", paramsDigest: "a", result: "results/a" })}\n` +
          "not-json\n" +
          '{"seq":999',
      );
      const recorder = createReplayRecorder({
        isEnabled: () => true,
        recordingRootPath: workspace,
        materialize: async () => ({ ref: "results/ref.json" }),
        nowMs: () => 1,
      });

      await recorder.record(LEASE, "memory.search", { q: "x" }, { ok: true });

      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(JSON.parse(lines.at(-1) ?? "{}").seq).toBe(8);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows sequence gaps after a failed append because replay follows physical line order", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "replay-gap-"));
    const runDir = join(workspace, "results", safeResultRunId("checkpoint-a"));
    const logPath = join(runDir, "replay.jsonl");
    let materializeCall = 0;
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(logPath, "");
      const recorder = createReplayRecorder({
        isEnabled: () => true,
        recordingRootPath: workspace,
        materialize: async () => {
          materializeCall += 1;
          rmSync(logPath, { recursive: true, force: true });
          if (materializeCall === 1) mkdirSync(logPath);
          else writeFileSync(logPath, "");
          return { ref: "results/ref.json" };
        },
        nowMs: () => 1,
      });

      await recorder.record(LEASE, "memory.search", { q: "first" }, { ok: true });
      await recorder.record(LEASE, "memory.search", { q: "second" }, { ok: true });

      expect(JSON.parse(readFileSync(logPath, "utf8").trim()).seq).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("stops recording best-effort when the persisted sequence is exhausted", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "replay-seq-max-"));
    const runDir = join(workspace, "results", safeResultRunId("checkpoint-a"));
    const logPath = join(runDir, "replay.jsonl");
    const materialize = vi.fn(async () => ({ ref: "results/ref.json" }));
    try {
      mkdirSync(runDir, { recursive: true });
      const original = `${JSON.stringify({ seq: Number.MAX_SAFE_INTEGER })}\n`;
      writeFileSync(logPath, original);
      const recorder = createReplayRecorder({
        isEnabled: () => true,
        recordingRootPath: workspace,
        materialize,
        nowMs: () => 1,
      });

      await expect(recorder.record(LEASE, "memory.search", {}, { ok: true })).resolves.toBeUndefined();

      expect(materialize).not.toHaveBeenCalled();
      expect(readFileSync(logPath, "utf8")).toBe(original);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("refuses an oversized persisted replay log before allocating or materializing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "replay-log-cap-"));
    const runDir = join(workspace, "results", safeResultRunId("checkpoint-a"));
    const logPath = join(runDir, "replay.jsonl");
    const materialize = vi.fn(async () => ({ ref: "results/ref.json" }));
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(logPath, "");
      truncateSync(logPath, TEST_REPLAY_LOG_MAX_BYTES + 1);
      const recorder = createReplayRecorder({
        isEnabled: () => true,
        recordingRootPath: workspace,
        materialize,
        nowMs: () => 1,
      });

      await expect(recorder.record(LEASE, "memory.search", {}, { ok: true })).resolves.toBeUndefined();

      expect(materialize).not.toHaveBeenCalled();
      expect(readFileSync(logPath).byteLength).toBe(TEST_REPLAY_LOG_MAX_BYTES + 1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
