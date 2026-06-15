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

describe("translatePayload — T2.2 background_task lifecycle (F9: now visible on the trajectory)", () => {
  it("promoted: keeps taskId/toolName, strips the envelope agentId/timestamp", () => {
    const data = translatePayload("background_task:promoted", {
      agentId: "a1",
      taskId: "t-1",
      toolName: "terminal_session_wait",
      timestamp: 100,
    });
    expect(data).toEqual({ taskId: "t-1", toolName: "terminal_session_wait" });
    expect(data.agentId).toBeUndefined();
  });

  it("completed: keeps taskId/toolName/durationMs, strips agentId/origin/timestamp", () => {
    const data = translatePayload("background_task:completed", {
      agentId: "a1",
      taskId: "t-1",
      toolName: "terminal_session_wait",
      durationMs: 4200,
      origin: { agentId: "a1", sessionKey: "k" },
      timestamp: 200,
    });
    expect(data).toEqual({ taskId: "t-1", toolName: "terminal_session_wait", durationMs: 4200 });
    expect(data.origin).toBeUndefined();
  });

  it("failed: omits the error body (H1) — only ids + duration cross the bus", () => {
    const data = translatePayload("background_task:failed", {
      agentId: "a1",
      taskId: "t-1",
      toolName: "exec",
      error: "secret-looking stack trace",
      durationMs: 9,
      origin: { agentId: "a1", sessionKey: "k" },
      timestamp: 300,
    });
    expect(data).toEqual({ taskId: "t-1", toolName: "exec", durationMs: 9 });
    expect(JSON.stringify(data)).not.toMatch(/secret-looking stack trace/);
  });
});

// VIS-04 (Phase 187): the vision translators forward ONLY content-free
// labels/numbers (provider/mainProvider/model/path/costUsd/outcome/errorKind) and
// STRIP the envelope fields (agentId/sessionKey/timestamp), mirroring the
// image:* cases. costUsd/model spread presence-conditionally (Pitfall 4 — the
// registry/gemini-video tiers return no cost). NEVER the image bytes, the prompt,
// or the model's answer (T-187-12).
describe("translatePayload — VIS-04 vision signals (content-free + envelope stripping)", () => {
  it("forwards media.vision:requested as exactly {provider, mainProvider}", () => {
    const data = translatePayload("media.vision:requested", {
      provider: "anthropic",
      mainProvider: "anthropic",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ provider: "anthropic", mainProvider: "anthropic" });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("forwards media.vision:completed with the path label + presence-conditional model/costUsd", () => {
    const data = translatePayload("media.vision:completed", {
      provider: "anthropic",
      mainProvider: "anthropic",
      model: "claude-sonnet-4-5",
      costUsd: 0.002,
      path: "main-vision",
      outcome: "ok",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      provider: "anthropic",
      mainProvider: "anthropic",
      model: "claude-sonnet-4-5",
      costUsd: 0.002,
      path: "main-vision",
      outcome: "ok",
    });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("media.vision:completed without costUsd (registry tier) omits the key entirely (Pitfall 4)", () => {
    const data = translatePayload("media.vision:completed", {
      provider: "gemini",
      mainProvider: "anthropic",
      path: "registry",
      outcome: "ok",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ provider: "gemini", mainProvider: "anthropic", path: "registry", outcome: "ok" });
    expect("costUsd" in data).toBe(false);
    expect("model" in data).toBe(false);
  });

  it("forwards media.vision:failed as {errorKind, path, provider, mainProvider}", () => {
    const data = translatePayload("media.vision:failed", {
      errorKind: "empty_response",
      path: "main-vision",
      provider: "anthropic",
      mainProvider: "anthropic",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      errorKind: "empty_response",
      path: "main-vision",
      provider: "anthropic",
      mainProvider: "anthropic",
    });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });
});
