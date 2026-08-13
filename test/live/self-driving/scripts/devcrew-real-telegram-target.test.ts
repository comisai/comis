// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const target = readFileSync(
  new URL("../targets/devcrew-real-telegram-comis.md", import.meta.url),
  "utf8",
);

describe("real Telegram DevCrew dogfood target", () => {
  it("pins human origin, isolated Comis dogfood, recovery, restart, and no-merge boundaries", () => {
    for (const required of [
      "real human sender",
      "comisai/comis",
      "protected default",
      "reconcile_task",
      "handback_task",
      "comis messages --channel telegram",
      "comis system-health",
      "make test-live",
      "open, unmerged",
      "control agent",
      "count-only residency",
    ]) {
      expect(target).toContain(required);
    }
    expect(target).toContain("must observe both exact task handles simultaneously");
    expect(target).toContain("bot-token impersonation");
    expect(target).toContain("may not merge, publish, release, deploy");
  });
});
