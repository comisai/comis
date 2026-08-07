// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("approval prompt driver rig isolation", () => {
  it("uses the selected rig wiring path for approval callbacks", () => {
    const source = readFileSync(
      resolve(__dirname, "approve-pending.mjs"),
      "utf8",
    );

    expect(source).toContain('import { rig } from "./_rig.mjs";');
    expect(source).toContain("readFileSync(rig.emuWiringPath");
    expect(source).not.toContain('readFileSync("/tmp/comis-emu.json"');
  });
});
