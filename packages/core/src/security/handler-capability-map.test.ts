// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage tests for HANDLER_CAPABILITY_MAP (CAP-04 source-of-truth).
 *
 * Asserts the map classifies every orchestration-core method correctly and
 * that no value is a typo'd capability. The companion arch-test
 * (`test/architecture/gated-handlers-require-capability.test.ts`) consumes the
 * SAME map to prove each AgentCapability-valued method's handler actually calls
 * `requireCapability` — so the gate and the auditable table cannot drift.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { AGENT_CAPABILITIES, type AgentCapability } from "./capability.js";
import { HANDLER_CAPABILITY_MAP } from "./handler-capability-map.js";

const AGENT_CAP_SET = new Set<string>(AGENT_CAPABILITIES);

describe("HANDLER_CAPABILITY_MAP", () => {
  it("classifies the five orchestration-core anchor methods to their caps", () => {
    expect(HANDLER_CAPABILITY_MAP["session.spawn"]).toBe("orch:spawn");
    expect(HANDLER_CAPABILITY_MAP["graph.define"]).toBe("orch:graph");
    expect(HANDLER_CAPABILITY_MAP["cron.add"]).toBe("orch:cron");
    expect(HANDLER_CAPABILITY_MAP["message.send"]).toBe("orch:message");
    expect(HANDLER_CAPABILITY_MAP["skills.create"]).toBe("orch:skill");
  });

  it("maps every mutating method in each gated family to the family cap", () => {
    const graphMutating = [
      "graph.define",
      "graph.execute",
      "graph.save",
      "graph.load",
      "graph.delete",
      "graph.cancel",
      "graph.deleteRun",
    ];
    for (const m of graphMutating) expect(HANDLER_CAPABILITY_MAP[m]).toBe("orch:graph");

    const cronMutating = ["cron.add", "cron.update", "cron.remove", "cron.run"];
    for (const m of cronMutating) expect(HANDLER_CAPABILITY_MAP[m]).toBe("orch:cron");

    const messageOutward = [
      "message.send",
      "message.reply",
      "message.react",
      "message.edit",
      "message.delete",
      "message.attach",
    ];
    for (const m of messageOutward) expect(HANDLER_CAPABILITY_MAP[m]).toBe("orch:message");

    const skillsMutating = [
      "skills.create",
      "skills.update",
      "skills.delete",
      "skills.import",
      "skills.upload",
    ];
    for (const m of skillsMutating) expect(HANDLER_CAPABILITY_MAP[m]).toBe("orch:skill");
  });

  it("never assigns a value that is a typo'd capability (every cap ∈ AGENT_CAPABILITIES)", () => {
    const classifications = new Set(["deny-by-origin", "ungated"]);
    for (const [method, value] of Object.entries(HANDLER_CAPABILITY_MAP)) {
      if (classifications.has(value)) continue;
      expect(
        AGENT_CAP_SET.has(value),
        `${method} → "${value}" is not a member of AGENT_CAPABILITIES`,
      ).toBe(true);
    }
  });

  it("classifies read-only orchestration methods as ungated (proves the three-way classification is real)", () => {
    // At least one read-only method per family is explicitly ungated. Adding a
    // gated method without classifying it must NOT silently inherit a cap.
    expect(HANDLER_CAPABILITY_MAP["message.fetch"]).toBe("ungated");
    expect(HANDLER_CAPABILITY_MAP["graph.list"]).toBe("ungated");
    expect(HANDLER_CAPABILITY_MAP["cron.list"]).toBe("ungated");
    expect(HANDLER_CAPABILITY_MAP["skills.list"]).toBe("ungated");
  });

  it("is exhaustive over the orchestration gated table (each gated method is a key with the expected cap)", () => {
    // The exact gated method→cap table the interfaces block specifies. Adding a
    // gated method without an entry here is caught by the arch-test's
    // API_CONTRACTS_ORDERED completeness assertion; this pins the current set.
    const gatedTable: Record<string, AgentCapability> = {
      "session.spawn": "orch:spawn",
      "graph.define": "orch:graph",
      "graph.execute": "orch:graph",
      "graph.save": "orch:graph",
      "graph.load": "orch:graph",
      "graph.delete": "orch:graph",
      "graph.cancel": "orch:graph",
      "graph.deleteRun": "orch:graph",
      "cron.add": "orch:cron",
      "cron.update": "orch:cron",
      "cron.remove": "orch:cron",
      "cron.run": "orch:cron",
      "message.send": "orch:message",
      "message.reply": "orch:message",
      "message.react": "orch:message",
      "message.edit": "orch:message",
      "message.delete": "orch:message",
      "message.attach": "orch:message",
      "skills.create": "orch:skill",
      "skills.update": "orch:skill",
      "skills.delete": "orch:skill",
      "skills.import": "orch:skill",
      "skills.upload": "orch:skill",
    };
    for (const [method, cap] of Object.entries(gatedTable)) {
      expect(HANDLER_CAPABILITY_MAP[method], `missing/incorrect map entry for ${method}`).toBe(cap);
    }
  });
});
