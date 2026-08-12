// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE = resolve(HERE, "browser-oracle.mjs");

it("rejects syntax errors inside inline entry scripts", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "comis-browser-oracle-"));
  try {
    writeFileSync(
      resolve(directory, "run-tracker.html"),
      "<!doctype html><script>const name = document.getElementById('runName').value.trim());</script>",
    );
    const port = String(20_000 + (process.pid % 20_000));

    const result = spawnSync(
      process.execPath,
      [ORACLE, directory, "--entry", "run-tracker.html", "--port", port],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("inline script 1");
    expect(result.stdout).toContain("syntax error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
