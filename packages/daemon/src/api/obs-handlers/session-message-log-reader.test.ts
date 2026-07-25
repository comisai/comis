// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readLatestLogicalRecords,
} from "./session-message-log-reader.js";

const tmpDirs: string[] = [];

function tmpFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-message-reader-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readLatestLogicalRecords", () => {
  it("retains thirty-two bounded predecessors beyond the ordinary record cap", () => {
    const file = tmpFile(Array.from({ length: 5_033 }, (_, index) => `record-${index}`));

    const result = readLatestLogicalRecords(file, 16 * 1024 * 1024);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.records).toHaveLength(5_032);
    expect(result.value.records.filter((record) => record.contextOnly)).toHaveLength(32);
    expect(result.value.records[0]).toEqual({
      kind: "line",
      line: "record-1",
      contextOnly: true,
    });
    expect(result.value.capped).toBe(true);
    expect(result.value.prefixUncertain).toBe(true);
  });

  it("reports an uncertain prefix when the byte window starts inside a record", () => {
    const file = tmpFile(["older-prefix", "newer"]);
    const fileBytes = fs.statSync(file).size;

    const result = readLatestLogicalRecords(file, fileBytes - 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.records).toEqual([{
      kind: "line",
      line: "newer",
      contextOnly: false,
    }]);
    expect(result.value.byteCapped).toBe(true);
    expect(result.value.prefixUncertain).toBe(true);
  });

  it("rejects a final-component symlink instead of following it", () => {
    const target = tmpFile(["outside-session-content"]);
    const link = path.join(path.dirname(target), "linked-session.jsonl");
    fs.symlinkSync(target, link);

    const result = readLatestLogicalRecords(link, 16 * 1024 * 1024);

    expect(result.ok).toBe(false);
  });
});
