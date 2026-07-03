// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for cassette.ts — two-speed replay/record seam.
 *
 * Filesystem I/O via tmpdir — no real HTTP, no real provider calls.
 * Must run with COMIS_LIVE unset — additive test tooling that never requires a live daemon or real provider calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordCassette,
  replayCassette,
  diffCassette,
  type CassetteRecord,
} from "./cassette.js";

/** Build a minimal valid CassetteRecord for use in tests. */
function makeRecord(overrides: Partial<CassetteRecord> = {}): CassetteRecord {
  return {
    ts: "2026-06-05T12:00:00.000Z",
    scenarioId: "scenario-1",
    modelSnapshot: "claude-3-5-haiku-20241022",
    provider: "anthropic",
    request: { model: "claude-3-5-haiku-20241022", messages: [] },
    response: { content: "hello", tokens: 5 },
    systemFingerprint: "fp_abc123",
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cassette-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordCassette", () => {
  it("creates the file and the line parses as valid JSON with the record fields", () => {
    const filePath = join(tmpDir, "test.jsonl");
    const record = makeRecord();

    recordCassette(filePath, record);

    // The file should exist and parse
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content) as CassetteRecord;
    expect(parsed.scenarioId).toBe("scenario-1");
    expect(parsed.modelSnapshot).toBe("claude-3-5-haiku-20241022");
    expect(parsed.ts).toBe("2026-06-05T12:00:00.000Z");
    expect(parsed).toHaveProperty("request");
    expect(parsed).toHaveProperty("response");
  });

  it("throws when request contains a secret Authorization header (assertNoSecrets fires)", () => {
    const filePath = join(tmpDir, "secret.jsonl");
    const secretRecord = makeRecord({
      request: {
        model: "claude-3-5-haiku-20241022",
        headers: { Authorization: "Bearer sk-abc12345678901234567890" },
      },
    });

    // assertNoSecrets must detect the Bearer token and throw before writing
    expect(() => recordCassette(filePath, secretRecord)).toThrow(/SECRET LEAK/);
  });
});

describe("replayCassette", () => {
  it("returns the record with matching scenarioId", () => {
    const filePath = join(tmpDir, "replay.jsonl");
    const record = makeRecord({ scenarioId: "scenario-1" });
    recordCassette(filePath, record);

    const replayed = replayCassette(filePath, "scenario-1");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.scenarioId).toBe("scenario-1");
    expect(replayed[0]!.response).toEqual({ content: "hello", tokens: 5 });
  });

  it("returns [] when file does not exist (no throw)", () => {
    const nonExistentPath = join(tmpDir, "does-not-exist.jsonl");
    const result = replayCassette(nonExistentPath, "s1");
    expect(result).toEqual([]);
  });
});

describe("diffCassette", () => {
  it("returns drift alerts when a response field changes between two cassettes", () => {
    const pathA = join(tmpDir, "a.jsonl");
    const pathB = join(tmpDir, "b.jsonl");

    const recordA = makeRecord({ response: { content: "hello", tokens: 5 } });
    const recordB = makeRecord({ response: { content: "world", tokens: 5 } });

    recordCassette(pathA, recordA);
    recordCassette(pathB, recordB);

    const alerts = diffCassette(pathA, pathB);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.scenarioId).toBe("scenario-1");
    expect(alerts[0]!.changedFields).toContain("content");
  });

  it("returns [] (no drift) when both cassette paths are identical", () => {
    const pathA = join(tmpDir, "same.jsonl");
    const record = makeRecord();
    recordCassette(pathA, record);

    const alerts = diffCassette(pathA, pathA);
    expect(alerts).toEqual([]);
  });
});
