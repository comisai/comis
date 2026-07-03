// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage tests for HANDLER_CAPABILITY_MAP (the single method→capability source-of-truth).
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
import { HANDLER_CAPABILITY_MAP, SELF_SCOPED_AGENT_READS } from "./handler-capability-map.js";
import { API_CONTRACTS_ORDERED } from "../api-contracts/index.js";
import { SUB_AGENT_TOOL_DENYLIST } from "../domain/sub-agent-tool-denylist.js";

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

    // orch:message exposes ONLY the genuinely-outward send
    // subset (send/reply/react). edit/delete/fetch/attach stay admin-only
    // (deny-by-origin) and are NOT part of the cap.
    const messageOutward = ["message.send", "message.reply", "message.react"];
    for (const m of messageOutward) expect(HANDLER_CAPABILITY_MAP[m]).toBe("orch:message");

    const messageAdminOnly = ["message.edit", "message.delete", "message.attach", "message.fetch"];
    for (const m of messageAdminOnly) expect(HANDLER_CAPABILITY_MAP[m]).toBe("deny-by-origin");

    const skillsMutating = [
      "skills.create",
      "skills.update",
      "skills.delete",
      "skills.import",
      "skills.upload",
    ];
    for (const m of skillsMutating) expect(HANDLER_CAPABILITY_MAP[m]).toBe("orch:skill");
  });

  it("classifies the arbitrary-session lifecycle ops (in-handler admin check) as deny-by-origin and the agent-reachable reads as ungated", () => {
    // delete/export/reset_conversation carry an in-handler _trustLevel === "admin"
    // check and target an ARBITRARY session by key → genuine control plane.
    for (const m of ["session.delete", "session.export", "session.reset_conversation"]) {
      expect(HANDLER_CAPABILITY_MAP[m], `${m} must be deny-by-origin`).toBe("deny-by-origin");
    }
    // list/compact/reset have NO in-handler admin check → agent-reachable reads.
    for (const m of ["session.list", "session.compact", "session.reset"]) {
      expect(HANDLER_CAPABILITY_MAP[m], `${m} must be ungated`).toBe("ungated");
    }
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
    // (message.fetch is NOT here — it stays admin-only / deny-by-origin.)
    expect(HANDLER_CAPABILITY_MAP["session.list"]).toBe("ungated");
    expect(HANDLER_CAPABILITY_MAP["graph.list"]).toBe("ungated");
    expect(HANDLER_CAPABILITY_MAP["cron.list"]).toBe("ungated");
    expect(HANDLER_CAPABILITY_MAP["skills.list"]).toBe("ungated");
  });

  it("capabilities.introspect is ungated — read-only, agent-reachable, NO cap", () => {
    // The agent can query its OWN caps + remaining budget with no cap required
    // (the read-only "ungated" class, beside session.status). The contract is
    // scopes:["rpc"]; the handler enforces _agentId self-scope, NOT a
    // requireCapability gate.
    expect(HANDLER_CAPABILITY_MAP["capabilities.introspect"]).toBe("ungated");
  });

  it("classifies the admin-only / deny-by-origin methods (proves the deny-by-origin class is populated)", () => {
    // The deny-by-origin class is non-empty: the message subset kept
    // admin-only + the arbitrary-session lifecycle ops.
    for (const m of [
      "message.edit",
      "message.delete",
      "message.attach",
      "message.fetch",
      "session.delete",
      "session.export",
      "session.reset_conversation",
    ]) {
      expect(HANDLER_CAPABILITY_MAP[m], `${m} must be deny-by-origin`).toBe("deny-by-origin");
    }
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
      // Only the genuinely-outward send subset is gated on orch:message.
      "message.send": "orch:message",
      "message.reply": "orch:message",
      "message.react": "orch:message",
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

describe("SELF_SCOPED_AGENT_READS — the tight cap-socket audience exception", () => {
  // The audience exception (lease-manager.ts validate) lets ANY valid lease reach
  // exactly these three ungated, self-`_agentId`-scoped, scopes:["rpc"] reads
  // (whoami / status). The set is named + pinned here so a future typo adding a
  // fourth — or moving one of these to a gated/admin classification — fails the
  // build instead of silently widening the lease audience.

  it("is exactly the three self-scoped reads {capabilities.introspect, session.status, session.list} (tightness pin)", () => {
    expect([...SELF_SCOPED_AGENT_READS].sort()).toEqual(
      ["capabilities.introspect", "session.list", "session.status"].sort(),
    );
    // length pin: adding a fourth member without intent fails here.
    expect(SELF_SCOPED_AGENT_READS).toHaveLength(3);
  });

  it("classifies every member 'ungated' in HANDLER_CAPABILITY_MAP (NOT an orch:* cap, NOT deny-by-origin)", () => {
    for (const method of SELF_SCOPED_AGENT_READS) {
      expect(
        HANDLER_CAPABILITY_MAP[method],
        `${method} must stay ungated — the audience exception is for cap-less, non-admin reads only`,
      ).toBe("ungated");
    }
  });

  it("pins every member to scopes:['rpc'] per its API contract (not admin → not deny-by-origin → not destructive)", () => {
    const scopeByMethod = new Map(API_CONTRACTS_ORDERED.map((c) => [c.method, c.scopes]));
    for (const method of SELF_SCOPED_AGENT_READS) {
      const scopes = scopeByMethod.get(method);
      expect(scopes, `${method} must have a registered API contract`).toBeDefined();
      expect(scopes, `${method} must be scopes:['rpc'] — an admin scope would be deny-by-origin`).toEqual([
        "rpc",
      ]);
    }
  });

  it("never includes a SUB_AGENT_TOOL_DENYLIST'd name (the exception can never grant reach to a destructive tool)", () => {
    for (const method of SELF_SCOPED_AGENT_READS) {
      expect(
        SUB_AGENT_TOOL_DENYLIST.has(method),
        `${method} must not be denylisted`,
      ).toBe(false);
    }
  });
});
