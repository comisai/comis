// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createVoiceObsEmitter, wireVoiceObs } from "./voice-obs-emit.js";

// OBS-02/03 (Phase 196): createVoiceObsEmitter — the null-safe, off-turn-safe
// voice (STT/TTS) trajectory direct-emit helper, and wireVoiceObs — the thin
// emitter+§2.7-logger-closure helper Plan 03's media-handlers.ts (799/800, ZERO
// allowlist cushion) calls so its per-handler wiring delta is a few lines. The
// emitter is the createVideoObsEmitter twin (record-only, because the voice
// handlers/pipeline already carry §2.7 logging — a fused log would double-emit);
// wireVoiceObs adds the SEPARATE §2.7 logger line BESIDE the record (the
// video-handler convention), sanitizing the provider error before logging.

/** A capture recorder mirroring the SessionTrajectoryHandleRegistry recorder. */
function captureRecorder() {
  const calls: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    calls,
    recordEvent: vi.fn((type: string, data: Record<string, unknown>) => {
      calls.push({ type, data });
    }),
  };
}

/** A capture logger mirroring the ComisLogger info/warn spies. */
function captureLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  return { info, warn, debug, error: vi.fn(), fatal: vi.fn(), trace: vi.fn(), audit: vi.fn(), level: "info", child: () => captureLogger() } as never;
}

describe("createVoiceObsEmitter — STT", () => {
  it("fires media.stt.requested at construction (DOT name) via the resolved recorder", () => {
    const recorder = captureRecorder();
    const obs = createVoiceObsEmitter({
      sessionKey: "default:u1:telegram:c1",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "agent-1",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(obs.active).toBe(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("media.stt.requested");
    expect(recorder.calls[0]!.data).toEqual({
      provider: "local",
      mainProvider: "openai-codex",
      source: "keyless-local",
    });
  });

  it("completed() records media.stt.completed with costUsd:0 PRESENT (keyless — FLAG 4) + outcome:ok", () => {
    const recorder = captureRecorder();
    const obs = createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    obs.completed({ provider: "local", keyless: true, model: "base", durationMs: 1200, audioBytes: 5000, costUsd: 0, source: "keyless-local" });
    const rec = recorder.calls.find((c) => c.type === "media.stt.completed");
    expect(rec).toBeDefined();
    expect(rec!.data).toEqual({
      provider: "local",
      keyless: true,
      outcome: "ok",
      model: "base",
      durationMs: 1200,
      audioBytes: 5000,
      costUsd: 0,
      source: "keyless-local",
    });
    expect("costUsd" in rec!.data).toBe(true);
    expect(rec!.data.costUsd).toBe(0);
  });

  it("completed() (keyed, no per-call cost) omits costUsd + absent optionals", () => {
    const recorder = captureRecorder();
    const obs = createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "openai", mainProvider: "openai", source: "follow-main-key" },
    });
    obs.completed({ provider: "openai", keyless: false, durationMs: 900, source: "follow-main-key" });
    const rec = recorder.calls.find((c) => c.type === "media.stt.completed");
    expect(rec!.data).toEqual({ provider: "openai", keyless: false, outcome: "ok", durationMs: 900, source: "follow-main-key" });
    expect("costUsd" in rec!.data).toBe(false);
    expect("model" in rec!.data).toBe(false);
    expect("audioBytes" in rec!.data).toBe(false);
  });

  it("failed() records media.stt.failed {errorKind, provider, outcome:failed, source} (domain kind, no raw message)", () => {
    const recorder = captureRecorder();
    const obs = createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    obs.failed({ errorKind: "model_load_failed", provider: "local", source: "keyless-local" });
    const rec = recorder.calls.find((c) => c.type === "media.stt.failed");
    expect(rec!.data).toEqual({ errorKind: "model_load_failed", provider: "local", outcome: "failed", source: "keyless-local" });
  });
});

describe("createVoiceObsEmitter — TTS", () => {
  it("fires media.tts.requested at construction + records media.tts.completed/failed (DOT names)", () => {
    const recorder = captureRecorder();
    const obs = createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      kind: "tts",
      requested: { provider: "edge", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(recorder.calls[0]!.type).toBe("media.tts.requested");
    obs.completed({ provider: "edge", keyless: true, model: "en-US-AriaNeural", durationMs: 700, costUsd: 0, source: "keyless-local" });
    obs.failed({ errorKind: "network", provider: "edge", source: "keyless-local" });
    expect(recorder.calls.find((c) => c.type === "media.tts.completed")!.data.costUsd).toBe(0);
    expect(recorder.calls.find((c) => c.type === "media.tts.failed")!.data).toEqual({ errorKind: "network", provider: "edge", outcome: "failed", source: "keyless-local" });
  });
});

describe("createVoiceObsEmitter — onSkip on requested (OBS-03)", () => {
  it("forwards the onSkip reasons on media.stt.requested so an operator sees WHY auto picked the rung", () => {
    const recorder = captureRecorder();
    createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      kind: "stt",
      requested: {
        provider: "openai",
        mainProvider: "openai",
        source: "follow-main-key",
        onSkip: ["keyless-local unavailable; main \"openai\" has a usable audio key"],
      },
    });
    expect(recorder.calls[0]!.data).toEqual({
      provider: "openai",
      mainProvider: "openai",
      source: "follow-main-key",
      onSkip: ["keyless-local unavailable; main \"openai\" has a usable audio key"],
    });
  });

  it("omits onSkip from the requested data when not supplied (no undefined)", () => {
    const recorder = captureRecorder();
    createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect("onSkip" in recorder.calls[0]!.data).toBe(false);
  });
});

describe("createVoiceObsEmitter — off-turn safety + content-free (SEC-01)", () => {
  it("no sessionKey / no registry → active=false, every method no-ops (no throw, no record)", () => {
    const obs1 = createVoiceObsEmitter({
      sessionKey: undefined,
      trajectoryRegistry: undefined,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(obs1.active).toBe(false);
    expect(() => {
      obs1.completed({ provider: "local", keyless: true, costUsd: 0, source: "keyless-local" });
      obs1.failed({ errorKind: "timeout", provider: "local", source: "keyless-local" });
    }).not.toThrow();

    const recorder = captureRecorder();
    const obs2 = createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => undefined } as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(obs2.active).toBe(false);
    expect(() => obs2.completed({ provider: "local", keyless: true, costUsd: 0, source: "keyless-local" })).not.toThrow();
    expect(recorder.calls).toHaveLength(0);
  });

  it("the recorded data carries NO envelope key (agentId/sessionKey/traceId) and no baseUrl/key/URL field", () => {
    const recorder = captureRecorder();
    const obs = createVoiceObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "agent-1",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    obs.completed({ provider: "local", keyless: true, costUsd: 0, source: "keyless-local" });
    for (const c of recorder.calls) {
      expect("agentId" in c.data).toBe(false);
      expect("sessionKey" in c.data).toBe(false);
      expect("traceId" in c.data).toBe(false);
      expect("baseUrl" in c.data).toBe(false);
      expect("apiKey" in c.data).toBe(false);
    }
  });
});

describe("wireVoiceObs — the handler-wiring helper (emitter + §2.7 logger closure)", () => {
  it("returns { obs, completed, failed }; the *.requested record already fired", () => {
    const recorder = captureRecorder();
    const logger = captureLogger();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      logger,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(w.obs.active).toBe(true);
    expect(typeof w.completed).toBe("function");
    expect(typeof w.failed).toBe("function");
    expect(recorder.calls[0]!.type).toBe("media.stt.requested");
  });

  it("completed() records media.stt.completed AND emits ONE logger.info with the §2.7 fields", () => {
    const recorder = captureRecorder();
    const logger = captureLogger();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      logger,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    w.completed({ provider: "local", keyless: true, model: "base", durationMs: 1200, audioBytes: 5000, costUsd: 0, source: "keyless-local" });
    // trajectory record
    const rec = recorder.calls.find((c) => c.type === "media.stt.completed");
    expect(rec!.data.costUsd).toBe(0);
    // §2.7 INFO line (one call)
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.info.mock.calls[0]!;
    expect(fields).toMatchObject({ provider: "local", keyless: true, model: "base", durationMs: 1200, audioBytes: 5000, source: "keyless-local" });
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/transcription/i);
  });

  it("failed() records media.stt.failed AND emits ONE logger.warn with err:+hint+errorKind(STT_ERR_TO_LOG)+sttErrorKind", () => {
    const recorder = captureRecorder();
    const logger = captureLogger();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      logger,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    w.failed({ sttErrorKind: "model_load_failed", provider: "local", source: "keyless-local", errMessage: "whisper model failed to load" });
    // trajectory record (domain kind verbatim)
    const rec = recorder.calls.find((c) => c.type === "media.stt.failed");
    expect(rec!.data).toEqual({ errorKind: "model_load_failed", provider: "local", outcome: "failed", source: "keyless-local" });
    // §2.7 WARN line (one call): closed log union + the domain kind
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.warn.mock.calls[0]!;
    // model_load_failed maps to the closed log union "dependency" (STT_ERR_TO_LOG)
    expect(fields).toMatchObject({ errorKind: "dependency", sttErrorKind: "model_load_failed" });
    expect(fields.err).toBeDefined();
    expect(fields.hint).toBeDefined();
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/transcription/i);
  });

  it("TTS messages key off kind (synthesis), and auth_required maps to the closed log union 'auth'", () => {
    const recorder = captureRecorder();
    const logger = captureLogger();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      logger,
      agentId: "a",
      kind: "tts",
      requested: { provider: "elevenlabs", mainProvider: "openai", source: "explicit" },
    });
    w.completed({ provider: "elevenlabs", keyless: false, durationMs: 600, source: "explicit" });
    expect(logger.info.mock.calls[0]![1]).toMatch(/synthesis|speech/i);
    w.failed({ sttErrorKind: "auth_required", provider: "elevenlabs", source: "explicit", errMessage: "401 unauthorized" });
    expect(logger.warn.mock.calls[0]![0]).toMatchObject({ errorKind: "auth", sttErrorKind: "auth_required" });
    expect(logger.warn.mock.calls[0]![1]).toMatch(/synthesis|speech/i);
  });

  it("SEC-01 no-leak: a credential-bearing URL/Bearer in errMessage never survives in the WARN err: line, and no credential reaches the trajectory data", () => {
    const recorder = captureRecorder();
    const logger = captureLogger();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      logger,
      agentId: "a",
      kind: "stt",
      requested: { provider: "openai", mainProvider: "openai", source: "follow-main-key" },
    });
    const leaky = "POST https://api.openai.com/v1/audio/transcriptions failed (Authorization: Bearer sk-proj-abc123def456ghi789jkl012)";
    w.failed({ sttErrorKind: "network", provider: "openai", source: "follow-main-key", errMessage: leaky });
    const errField = String(logger.warn.mock.calls[0]![0].err);
    expect(errField).not.toContain("sk-proj-abc123def456ghi789jkl012");
    expect(errField).not.toMatch(/Bearer\s+sk-/i);
    // host-only: the full path + query must not survive verbatim
    expect(errField).not.toContain("/v1/audio/transcriptions");
    // the trajectory record carries no credential
    const rec = recorder.calls.find((c) => c.type === "media.stt.failed");
    expect(JSON.stringify(rec!.data)).not.toContain("sk-proj");
    expect(JSON.stringify(rec!.data)).not.toContain("Bearer");
  });

  it("wireVoiceObs is off-turn-safe: no recorder → no throw, but the §2.7 log lines STILL fire", () => {
    const logger = captureLogger();
    const w = wireVoiceObs({
      sessionKey: undefined,
      trajectoryRegistry: undefined,
      logger,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(w.obs.active).toBe(false);
    expect(() => {
      w.completed({ provider: "local", keyless: true, costUsd: 0, source: "keyless-local" });
      w.failed({ sttErrorKind: "timeout", provider: "local", source: "keyless-local", errMessage: "timed out" });
    }).not.toThrow();
    // the log lines always fire (recorder or not)
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
