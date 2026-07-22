// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectTaskQuarantine } from "./task-quarantine.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("follow-up task quarantine file inspection", () => {
  it("reports a missing private evidence file as valid and empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "comis-task-quarantine-"));
    dirs.push(directory);

    await expect(inspectTaskQuarantine(join(directory, "tasks-quarantine.jsonl"))).resolves.toEqual({
      ok: true,
      value: { exists: false, bytes: 0, digest: null, recordCount: 0, state: "valid" },
    });
  });

  it("reports permissive evidence-file permissions as invalid authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "comis-task-quarantine-"));
    dirs.push(directory);
    const filePath = join(directory, "tasks-quarantine.jsonl");
    await writeFile(filePath, "", { mode: 0o600 });
    await chmod(filePath, 0o644);

    await expect(inspectTaskQuarantine(filePath)).resolves.toEqual({
      ok: true,
      value: { exists: true, bytes: 0, digest: null, recordCount: 0, state: "invalid" },
    });
  });
});
