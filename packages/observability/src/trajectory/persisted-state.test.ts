// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPersistedTrajectoryState } from "./persisted-state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-persisted-trajectory-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function row(
  seq: number,
  type = "model.completed",
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    source: "runtime",
    type,
    seq,
    agentId: "default",
    sessionId: "sid-resume",
    traceId: "trace-resume",
    entryId: `entry-${seq}`,
    data,
  };
}

describe("readPersistedTrajectoryState", () => {
  it("recovers durable counters and detects a physical sequence regression", () => {
    const filePath = join(tmpDir, "trajectory.jsonl");
    const records = [
      row(290),
      row(291, "session.started"),
      row(1),
      row(17),
    ];
    writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const result = readPersistedTrajectoryState({
      filePath,
      sessionId: "sid-resume",
      maxFileBytes: 1024 * 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.maxSeq).toBe(291);
    expect(result.value.sequenceRegressions).toBe(1);
    expect(result.value.sessionStartedActive).toBe(true);
  });

  it("classifies null scalar and array JSON lines as malformed without throwing", () => {
    const filePath = join(tmpDir, "malformed-shapes.jsonl");
    writeFileSync(
      filePath,
      `${[JSON.stringify(row(7)), "null", "42", "[]"].join("\n")}\n`,
    );

    const result = readPersistedTrajectoryState({
      filePath,
      sessionId: "sid-resume",
      maxFileBytes: 1024 * 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.maxSeq).toBe(7);
    expect(result.value.malformedRecords).toBe(3);
  });

  it("fails closed when the only row cannot be followed by another safe integer seq", () => {
    const filePath = join(tmpDir, "unsafe-seq.jsonl");
    writeFileSync(filePath, `${JSON.stringify(row(Number.MAX_SAFE_INTEGER))}\n`);

    const result = readPersistedTrajectoryState({
      filePath,
      sessionId: "sid-resume",
      maxFileBytes: 1024 * 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failureKind).toBe("invalid_jsonl");
  });

  it("tracks whether the last persisted session lifecycle is still active", () => {
    const filePath = join(tmpDir, "session-lifecycle.jsonl");
    writeFileSync(
      filePath,
      `${[
        JSON.stringify(row(1, "session.started")),
        JSON.stringify(row(2, "session.ended")),
      ].join("\n")}\n`,
    );

    const result = readPersistedTrajectoryState({
      filePath,
      sessionId: "sid-resume",
      maxFileBytes: 1024 * 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.sessionStartedActive).toBe(false);
  });

  it("reports a valid final JSON line without a newline for atomic continuation", () => {
    const filePath = join(tmpDir, "no-final-newline.jsonl");
    writeFileSync(filePath, JSON.stringify(row(9)));

    const result = readPersistedTrajectoryState({
      filePath,
      sessionId: "sid-resume",
      maxFileBytes: 1024 * 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.needsLineBreak).toBe(true);
  });

  it("returns a typed non-regular failure without traversing outside confinement", () => {
    const filePath = join(tmpDir, "directory-target");
    mkdirSync(filePath);

    const result = readPersistedTrajectoryState({
      filePath,
      sessionId: "sid-resume",
      maxFileBytes: 1024 * 1024,
      confinedBaseDir: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failureKind).toBe("non_regular");
  });
});
