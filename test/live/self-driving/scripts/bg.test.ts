// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BG_HELPER = resolve(HERE, "bg.sh");
const BG_STATE_DIRECTORY = "/tmp";
const tags: string[] = [];
const directories: string[] = [];

function uniqueTag(suffix: string): string {
  const tag = `comis-bg-test-${process.pid}-${Date.now()}-${suffix}`;
  tags.push(tag);
  return tag;
}

async function waitForCompletion(tag: string): Promise<boolean> {
  const done = resolve(BG_STATE_DIRECTORY, `bg-${tag}.done`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(done)) return true;
    await new Promise((finish) => setTimeout(finish, 20));
  }
  return false;
}

afterEach(() => {
  for (const tag of tags.splice(0)) {
    for (const suffix of ["cmd.sh", "done", "out", "pid"]) {
      rmSync(resolve(BG_STATE_DIRECTORY, `bg-${tag}.${suffix}`), { force: true });
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("detached live command helper", () => {
  it("launches and records completion when setsid is unavailable", async () => {
    const tag = uniqueTag("portable");
    const pathDirectory = realpathSync(mkdtempSync(resolve(tmpdir(), "comis-bg-path-")));
    directories.push(pathDirectory);
    symlinkSync(realpathSync("/bin/bash"), resolve(pathDirectory, "bash"));
    symlinkSync(realpathSync("/bin/rm"), resolve(pathDirectory, "rm"));
    symlinkSync(realpathSync("/usr/bin/nohup"), resolve(pathDirectory, "nohup"));

    const launched = spawnSync(
      "/bin/bash",
      [BG_HELPER, tag, "printf 'detached-ok\\n'"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: pathDirectory },
      },
    );

    expect(launched.status).toBe(0);
    expect(launched.stdout).toContain("launched detached");
    expect(await waitForCompletion(tag)).toBe(true);
    expect(readFileSync(resolve(BG_STATE_DIRECTORY, `bg-${tag}.done`), "utf8").trim()).toBe("0");
    expect(readFileSync(resolve(BG_STATE_DIRECTORY, `bg-${tag}.out`), "utf8")).toBe(
      "detached-ok\n",
    );
  });

  it("reports missing process evidence instead of claiming a command is running", () => {
    const tag = uniqueTag("missing");

    const result = spawnSync("/bin/bash", [BG_HELPER, "--tail", tag, "5"], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("not running");
    expect(result.stdout).not.toMatch(/\] running(?:\n|$)/);
  });
});
