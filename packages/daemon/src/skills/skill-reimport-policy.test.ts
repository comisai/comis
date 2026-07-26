// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { checkSkillReimport } from "./skill-reimport-policy.js";

describe("checkSkillReimport", () => {
  it("allows installation when no incumbent directory exists", () => {
    const missingRoot = join(tmpdir(), `comis-reimport-${randomUUID()}`);
    const result = checkSkillReimport({
      dataDir: join(missingRoot, "data"),
      skillDir: join(missingRoot, "skill"),
      scope: "local",
      skillName: "example-skill",
      source: "github",
      candidate: {
        trust: "community",
        verdict: "safe",
        decision: "allow",
        contentHash: "sha256:candidate",
        findings: [],
        warnings: [],
      },
      confirmed: false,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
    });

    expect(result).toEqual({ ok: true, value: { kind: "install" } });
  });
});
