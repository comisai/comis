// SPDX-License-Identifier: Apache-2.0
/**
 * Direct unit tests for `translatePayload` — the per-event payload massaging
 * that decides which fields cross into the persisted trajectory `data`.
 *
 * Focused here on the OBS-01 / Phase 180 multilingual signals
 * (`context:script_zero_hit`, `context:summary_language_mismatch`): the
 * translator MUST forward ONLY the closed-union/identifier fields and STRIP the
 * envelope fields (`agentId`, `sessionKey`, `timestamp`) per the
 * `context:budget_computed` precedent (translate-payload.ts SECURITY INVARIANT).
 *
 * RED: the two event names are not keys of TRAJECTORY_BRIDGE_MAPPING yet, so
 * `TrajectoryBridgedEventName` does not include them and these calls fail to
 * type-check / return the populated shape until Task 2 wires the mapping +
 * translator cases.
 */
import { describe, it, expect } from "vitest";
import { translatePayload } from "./translate-payload.js";

describe("translatePayload — OBS-01 script signals (envelope stripping)", () => {
  it("forwards context:script_zero_hit as exactly {scriptClass, lane, conversationId}", () => {
    const data = translatePayload("context:script_zero_hit", {
      conversationId: "t1:u1:c1",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      scriptClass: "arabic",
      lane: "word",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ scriptClass: "arabic", lane: "word", conversationId: "t1:u1:c1" });
    // Envelope fields MUST NOT leak into data.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("forwards context:summary_language_mismatch as exactly {sourceScript, summaryScript, depth}", () => {
    const data = translatePayload("context:summary_language_mismatch", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      sourceScript: "cjk",
      summaryScript: "latin",
      depth: -1,
      timestamp: 1717171717,
    });
    expect(data).toEqual({ sourceScript: "cjk", summaryScript: "latin", depth: -1 });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });
});
