// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceDurableFile } from "./durable-file.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "comis-durable-file-"));
  dirs.push(value);
  return value;
}

describe("scheduler durable file replacement", () => {
  it("atomically replaces exact bytes with private file permissions", async () => {
    const dir = await directory();
    const filePath = join(dir, "authority.json");
    let sequence = 0;

    expect(await replaceDurableFile({
      filePath,
      bytes: Buffer.from("first\n", "utf8"),
      temporaryToken: () => `write-${++sequence}`,
    })).toEqual({ ok: true, value: undefined });
    expect(await replaceDurableFile({
      filePath,
      bytes: Buffer.from("second\n", "utf8"),
      temporaryToken: () => `write-${++sequence}`,
    })).toEqual({ ok: true, value: undefined });

    expect(await readFile(filePath, "utf8")).toBe("second\n");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("rejects unsafe temporary tokens before creating authority bytes", async () => {
    const dir = await directory();
    const filePath = join(dir, "authority.json");

    expect(await replaceDurableFile({
      filePath,
      bytes: Buffer.from("authority\n", "utf8"),
      temporaryToken: () => "../escape",
    })).toMatchObject({ ok: false, error: { code: "invalid_input", errorKind: "validation" } });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
