// SPDX-License-Identifier: Apache-2.0
/**
 * The live-kit rig-env parser must recover the SAME value the shell would.
 *
 * `/root/comis-rig.env` is read twice with different parsers: the `.sh` helpers `source` it
 * (shell quoting rules) and the `.mjs` helpers parse it with `readRigEnv` (a regex). When the two
 * disagree the rig looks healthy and every RPC fails: a single-quoted `GWTOKEN='<48 chars>'` was
 * read by the regex as a 50-character value INCLUDING the quotes, so the gateway answered
 * `WS close 4001 Unauthorized` while `rig-doctor`'s length-comparison check still reported PASS
 * (it compared raw line text, so both sides were "wrong by the same two characters").
 *
 * Live on comis-moshe 2026-08-02: several diagnostic round-trips spent on a token that was correct.
 *
 * @module
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRigEnv } from "../live/self-driving/scripts/_rig.mjs";

/** Write a rig-env file containing `line` and return its parsed vars. */
function parseLine(line: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "rig-env-"));
  const path = join(dir, "comis-rig.env");
  writeFileSync(path, `# comment\n${line}\n`);
  return readRigEnv(path) as Record<string, string>;
}

describe("readRigEnv quoting", () => {
  const TOKEN = "a".repeat(48);

  it("recovers a single-quoted value without the quotes", () => {
    // The shell reads '<tok>' as <tok>. The regex parser must agree, or the token it
    // hands the gateway is two characters longer than the one the daemon accepts.
    expect(parseLine(`GWTOKEN='${TOKEN}'`).GWTOKEN).toBe(TOKEN);
  });

  it("recovers an exported single-quoted value", () => {
    expect(parseLine(`export GWTOKEN='${TOKEN}'`).GWTOKEN).toBe(TOKEN);
  });

  it("still recovers the forms deploy-scripts renders", () => {
    expect(parseLine(`export GWTOKEN="\${GWTOKEN:-${TOKEN}}"`).GWTOKEN).toBe(TOKEN);
    expect(parseLine(`GWTOKEN="${TOKEN}"`).GWTOKEN).toBe(TOKEN);
    expect(parseLine(`GWTOKEN=${TOKEN}`).GWTOKEN).toBe(TOKEN);
  });

  it("keeps a quote that is part of the value rather than a wrapper", () => {
    // Only a MATCHED wrapping pair is stripped — an unpaired quote is data.
    expect(parseLine(`NOTE=it's-fine`).NOTE).toBe("it's-fine");
  });
});
