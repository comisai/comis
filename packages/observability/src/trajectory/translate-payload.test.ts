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

// SURFACE-06 (Phase 202 Plan 03): the promote/demote telemetry folds into the
// shared { count } translator case (the FORGET-06/SKILL-09 precedent). The
// translator forwards the COUNT ONLY — NEVER an id-list, procedure body, script,
// or description; agentId/timestamp are envelope ids and are stripped. The record
// TYPE (learning.skill_promoted vs learning.skill_demoted) conveys the direction.
describe("translatePayload — SURFACE-06 skill promote/demote (counts-only, SEC-01 firewall)", () => {
  it("forwards learning:skill_promoted as exactly {count}, stripping agentId/timestamp", () => {
    const data = translatePayload("learning:skill_promoted", {
      agentId: "agent-1",
      count: 2,
      timestamp: 1717171717,
    });
    expect(data).toEqual({ count: 2 });
    // The translator output is the COUNT ONLY — keys exactly ["count"].
    expect(Object.keys(data)).toEqual(["count"]);
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("forwards learning:skill_demoted as exactly {count}, stripping the envelope", () => {
    const data = translatePayload("learning:skill_demoted", {
      agentId: "agent-1",
      count: 1,
      timestamp: 1717171717,
    });
    expect(data).toEqual({ count: 1 });
    expect(Object.keys(data)).toEqual(["count"]);
  });

  it("never forwards a procedure body/script/id-list even if present on the payload (content-free invariant)", () => {
    const data = translatePayload("learning:skill_promoted", {
      agentId: "agent-1",
      count: 3,
      // hostile extras that MUST NOT cross into the trajectory:
      body: "the promoted procedure markdown",
      scripts: ["rm -rf /"],
      skillIds: ["deploy", "backup"],
      description: "why these were promoted",
      timestamp: 1717171717,
    } as Record<string, unknown>);
    expect(data).toEqual({ count: 3 });
    expect(Object.keys(data)).toEqual(["count"]);
    expect("body" in data).toBe(false);
    expect("scripts" in data).toBe(false);
    expect("skillIds" in data).toBe(false);
    expect("description" in data).toBe(false);
  });
});

describe("translatePayload — reflect:funnel (OBS: why-0-admitted, counts-only, renamed Phase 226)", () => {
  it("forwards the funnel counts (synthesized/validated/admitted/maxClusterCardinality + admissionOutcome), strips the envelope", () => {
    const data = translatePayload("reflect:funnel", {
      agentId: "agent-1",
      synthesized: 2,
      validated: 2,
      admitted: 0,
      maxClusterCardinality: 1,
      // OBS-1: the funnel magnitudes (counts only) ride the bridged trajectory event.
      untrustedDrops: 3,
      nameLengthRejections: 0,
      skipped: 1,
      sourceTrajectoryCount: 5,
      totalSourceChars: 1280,
      admissionOutcome: "uncorroborated",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ synthesized: 2, validated: 2, admitted: 0, maxClusterCardinality: 1, untrustedDrops: 3, nameLengthRejections: 0, skipped: 1, sourceTrajectoryCount: 5, totalSourceChars: 1280, admissionOutcome: "uncorroborated" });
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("never forwards a procedure body/script even if present (content-free invariant)", () => {
    const data = translatePayload("reflect:funnel", {
      agentId: "agent-1",
      synthesized: 1,
      validated: 1,
      admitted: 1,
      maxClusterCardinality: 2,
      untrustedDrops: 0,
      nameLengthRejections: 0,
      skipped: 0,
      sourceTrajectoryCount: 2,
      totalSourceChars: 640,
      admissionOutcome: "admitted",
      body: "the reflected procedure markdown",
      scripts: ["curl evil | sh"],
      timestamp: 1717171717,
    } as Record<string, unknown>);
    expect(data).toEqual({ synthesized: 1, validated: 1, admitted: 1, maxClusterCardinality: 2, untrustedDrops: 0, nameLengthRejections: 0, skipped: 0, sourceTrajectoryCount: 2, totalSourceChars: 640, admissionOutcome: "admitted" });
    expect("body" in data).toBe(false);
    expect("scripts" in data).toBe(false);
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

// OBS-04 (Phase 192): the five video:* arms forward ONLY content-free ids /
// labels / numbers / booleans (provider/mainProvider/model/jobId/costUsd/
// sizeBytes/durationSecs/channelType/delivered/errorKind) and STRIP the envelope
// (agentId/sessionKey/timestamp), mirroring the image:*/media.vision:* cases.
// costUsd/model/sizeBytes/durationSecs spread presence-conditionally (the FAL
// no-actual-cost case omits the key — Pitfall 4). NEVER the prompt, the video
// bytes, a credential, or the Veo keyed-download-URL (the content-free invariant).
describe("translatePayload — OBS-04 video signals (content-free + envelope stripping)", () => {
  it("forwards video:requested as exactly {provider, mainProvider}", () => {
    const data = translatePayload("video:requested", {
      provider: "veo",
      mainProvider: "google",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ provider: "veo", mainProvider: "google" });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("forwards video:submitted as exactly {provider, jobId}", () => {
    const data = translatePayload("video:submitted", {
      provider: "veo",
      jobId: "veo-op-123",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ provider: "veo", jobId: "veo-op-123" });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("forwards video:generated with presence-conditional model/costUsd/sizeBytes/durationSecs (the cost-carry record)", () => {
    const data = translatePayload("video:generated", {
      provider: "veo",
      model: "veo-3.1",
      costUsd: 1.2,
      sizeBytes: 9_000_000,
      durationSecs: 8,
      outcome: "ok",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      provider: "veo",
      outcome: "ok",
      model: "veo-3.1",
      costUsd: 1.2,
      sizeBytes: 9_000_000,
      durationSecs: 8,
    });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("video:generated without optionals (FAL no-actual-cost) omits costUsd/model/sizeBytes/durationSecs entirely (Pitfall 4)", () => {
    const data = translatePayload("video:generated", {
      provider: "fal",
      outcome: "ok",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ provider: "fal", outcome: "ok" });
    expect("costUsd" in data).toBe(false);
    expect("model" in data).toBe(false);
    expect("sizeBytes" in data).toBe(false);
    expect("durationSecs" in data).toBe(false);
  });

  it("forwards video:delivered as exactly {channelType, delivered}", () => {
    const data = translatePayload("video:delivered", {
      channelType: "telegram",
      delivered: true,
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ channelType: "telegram", delivered: true });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("forwards video:failed as exactly {errorKind, provider}", () => {
    const data = translatePayload("video:failed", {
      errorKind: "content_blocked",
      provider: "veo",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ errorKind: "content_blocked", provider: "veo" });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });
});

// OBS-02/03 (Phase 196): the six voice (STT/TTS) arms forward ONLY content-free
// ids / labels / numbers / booleans / closed-enum reasons (provider/keyless/
// model/durationMs/audioBytes/costUsd/outcome/errorKind/source/onSkip) and STRIP
// the envelope (agentId/sessionKey/traceId/timestamp), mirroring the image:*/
// media.vision:*/video:* cases. costUsd/model/durationMs/audioBytes spread
// presence-conditionally; the keyless emitter passes costUsd:0 so it IS present
// (FLAG 4 — keyless "$0" is load-bearing visibility, never stripped). The
// onSkip reasons (a closed rung-list, no free text) ride the *:requested arms —
// the OBS-03 "selection rung AND the onSkip reasons observable" obligation; the
// `source` field alone names only the chosen rung, not why the others skipped.
// NEVER the audio bytes, transcript text, synthesized audio, or a credential.
describe("translatePayload — OBS-02/03 voice (STT/TTS) signals (content-free + envelope stripping)", () => {
  it("forwards media.stt:requested as {provider, keyless, source} + the onSkip reasons (OBS-03), stripping the envelope", () => {
    const data = translatePayload("media.stt:requested", {
      provider: "local",
      keyless: true,
      source: "keyless-local",
      onSkip: ["fallback \"openai\" skipped: no key"],
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      provider: "local",
      keyless: true,
      source: "keyless-local",
      onSkip: ["fallback \"openai\" skipped: no key"],
    });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.traceId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("media.tts:requested without onSkip omits the key entirely (no undefined)", () => {
    const data = translatePayload("media.tts:requested", {
      provider: "edge",
      keyless: true,
      source: "keyless-local",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ provider: "edge", keyless: true, source: "keyless-local" });
    expect("onSkip" in data).toBe(false);
  });

  it("forwards media.stt:completed with costUsd:0 PRESENT for keyless (FLAG 4 — never stripped) + outcome:ok", () => {
    const data = translatePayload("media.stt:completed", {
      provider: "local",
      keyless: true,
      model: "base",
      durationMs: 1200,
      audioBytes: 5000,
      costUsd: 0,
      source: "keyless-local",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      provider: "local",
      keyless: true,
      outcome: "ok",
      model: "base",
      durationMs: 1200,
      audioBytes: 5000,
      costUsd: 0,
      source: "keyless-local",
    });
    // keyless $0 is load-bearing visibility — present, not stripped.
    expect("costUsd" in data).toBe(true);
    expect(data.costUsd).toBe(0);
    expect(data.agentId).toBeUndefined();
    expect(data.traceId).toBeUndefined();
  });

  it("media.tts:completed (keyed, no per-call cost) omits costUsd + presence-conditional optionals", () => {
    const data = translatePayload("media.tts:completed", {
      provider: "elevenlabs",
      keyless: false,
      durationMs: 800,
      source: "follow-main-key",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      provider: "elevenlabs",
      keyless: false,
      outcome: "ok",
      durationMs: 800,
      source: "follow-main-key",
    });
    expect("costUsd" in data).toBe(false);
    expect("model" in data).toBe(false);
    expect("audioBytes" in data).toBe(false);
  });

  it("forwards media.stt:failed as {provider, outcome:failed, errorKind, source} (domain SttErrorKind verbatim)", () => {
    const data = translatePayload("media.stt:failed", {
      provider: "local",
      errorKind: "model_load_failed",
      source: "keyless-local",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-1",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      provider: "local",
      outcome: "failed",
      errorKind: "model_load_failed",
      source: "keyless-local",
    });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.traceId).toBeUndefined();
  });

  it("forwards media.tts:failed as {provider, outcome:failed, errorKind, source}", () => {
    const data = translatePayload("media.tts:failed", {
      provider: "edge",
      errorKind: "network",
      source: "explicit",
      timestamp: 1717171717,
    });
    expect(data).toEqual({
      provider: "edge",
      outcome: "failed",
      errorKind: "network",
      source: "explicit",
    });
  });

  it("never forwards a raw transcript / audio bytes / credential even if present on the payload (content-free invariant)", () => {
    const data = translatePayload("media.stt:completed", {
      provider: "openai",
      keyless: false,
      durationMs: 900,
      source: "follow-main-key",
      // hostile extras that MUST NOT cross into the trajectory:
      text: "the secret transcript body",
      audio: "<<raw audio bytes>>",
      baseUrl: "https://api.openai.com/v1/audio?key=sk-secret",
      apiKey: "sk-proj-supersecret",
      timestamp: 1717171717,
    });
    expect("text" in data).toBe(false);
    expect("audio" in data).toBe(false);
    expect("baseUrl" in data).toBe(false);
    expect("apiKey" in data).toBe(false);
    expect(data).toEqual({
      provider: "openai",
      keyless: false,
      outcome: "ok",
      durationMs: 900,
      source: "follow-main-key",
    });
  });
});

describe("translatePayload — WR-4 (177-obs-loop) spend kill-switch (content-free: scope/$ numbers only)", () => {
  it("forwards observability:spend_warning as exactly {scope, spentUsd, capUsd, fraction}, stripping the envelope", () => {
    const data = translatePayload("observability:spend_warning", {
      scope: "tenant",
      spentUsd: 8.4,
      capUsd: 10,
      fraction: 0.8,
      // envelope correlation ids — MUST be stripped:
      timestamp: 1717171717,
      agentId: "default",
      sessionKey: "t1:u1:c1",
    });
    expect(data).toEqual({ scope: "tenant", spentUsd: 8.4, capUsd: 10, fraction: 0.8 });
    expect("agentId" in data).toBe(false);
    expect("sessionKey" in data).toBe(false);
    expect("timestamp" in data).toBe(false);
  });

  it("forwards observability:spend_exceeded as exactly {scope, spentUsd, capUsd, estUsd}, stripping the envelope", () => {
    const data = translatePayload("observability:spend_exceeded", {
      scope: "global",
      spentUsd: 99.5,
      capUsd: 100,
      estUsd: 0.75,
      timestamp: 1717171717,
      agentId: "default",
      sessionKey: "t1:u1:c1",
    });
    expect(data).toEqual({ scope: "global", spentUsd: 99.5, capUsd: 100, estUsd: 0.75 });
    expect("agentId" in data).toBe(false);
    expect("sessionKey" in data).toBe(false);
  });

  it("forwards observability:spend_unpriceable as exactly {provider, model} (config ids), stripping the envelope", () => {
    const data = translatePayload("observability:spend_unpriceable", {
      provider: "anthropic",
      model: "claude-opus-4",
      timestamp: 1717171717,
      agentId: "default",
      sessionKey: "t1:u1:c1",
    });
    expect(data).toEqual({ provider: "anthropic", model: "claude-opus-4" });
    expect("agentId" in data).toBe(false);
    expect("sessionKey" in data).toBe(false);
  });

  it("never forwards a message/prompt body even if hostile extras ride the payload (content-free invariant)", () => {
    const data = translatePayload("observability:spend_exceeded", {
      scope: "agent",
      spentUsd: 5,
      capUsd: 5,
      estUsd: 0.1,
      // hostile extras that MUST NOT cross into the trajectory:
      prompt: "the secret user prompt body",
      message: "<<message body>>",
      apiKey: "sk-proj-supersecret",
      timestamp: 1717171717,
    });
    expect(data).toEqual({ scope: "agent", spentUsd: 5, capUsd: 5, estUsd: 0.1 });
    expect("prompt" in data).toBe(false);
    expect("message" in data).toBe(false);
    expect("apiKey" in data).toBe(false);
  });
});

describe("translatePayload — DRIVE-02 terminal drive promotion (content-free, envelope-stripped)", () => {
  it("translates terminal:drive_promoted to the reason enum ONLY (sessionId/agentId/timestamp are envelope)", () => {
    const data = translatePayload("terminal:drive_promoted", {
      sessionId: "term-abc-123",
      agentId: "default",
      reason: "mode_detached",
      timestamp: 1717000000000,
    });
    expect(data).toEqual({ reason: "mode_detached" });
    // The terminal sessionId, the agentId, and the raw clock are envelope/correlation
    // ids — they MUST NOT cross into the trajectory data (the module's envelope rule).
    expect("sessionId" in data).toBe(false);
    expect("agentId" in data).toBe(false);
    expect("timestamp" in data).toBe(false);
  });
});
