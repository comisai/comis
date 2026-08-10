// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function scriptSource(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("offline live observability wiring", () => {
  it.each(["explain.mjs", "conversation-audit.mjs"])(
    "%s uses the store-backed CLI offline incident assembler",
    (name) => {
      const source = scriptSource(name);

      expect(source).toContain('comisDist("cli", "dist/util/offline-obs.js")');
      expect(source).toContain("assembleIncidentReportOffline");
      expect(source).not.toMatch(/makeRealReader\([^,)]*\)/u);
    },
  );
});
