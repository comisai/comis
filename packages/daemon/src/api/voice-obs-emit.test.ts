// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createVoiceObsEmitter, wireVoiceObs } from "./voice-obs-emit.js";

// createVoiceObsEmitter — the null-safe, off-turn-safe
// voice (STT/TTS) trajectory direct-emit helper, and wireVoiceObs — the thin
// emitter+logger-closure helper media-handlers.ts (at its 800-line cap, ZERO
// allowlist cushion) calls so its per-handler wiring delta is a few lines. The
// emitter is the createVideoObsEmitter twin (record-only, because the voice
// handlers/pipeline already carry structured logging — a fused log would
// double-emit); wireVoiceObs adds the SEPARATE logger line BESIDE the record
// (the video-handler convention), sanitizing the provider error before logging.

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

  it("completed() records media.stt.completed with costUsd:0 PRESENT (keyless — free is visible) + outcome:ok", () => {
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

describe("createVoiceObsEmitter — onSkip reasons on the requested record", () => {
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

describe("createVoiceObsEmitter — off-turn safety + content-free records", () => {
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

describe("wireVoiceObs — the handler-wiring helper (emitter + logger closure)", () => {
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

  it("completed() records media.stt.completed AND emits ONE logger.info with the structured completion fields", () => {
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
    // INFO completion line (one call)
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.info.mock.calls[0]!;
    expect(fields).toMatchObject({ provider: "local", keyless: true, model: "base", durationMs: 1200, audioBytes: 5000, source: "keyless-local" });
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/transcription/i);
  });

  // The keyless `costUsd:0` rule is centralized in
  // wireVoiceObs/the emitter — the caller need not pass `0`. A keyless completion
  // WITHOUT costUsd must still show `costUsd:0` (free is VISIBLE) on BOTH
  // the trajectory record AND the log line; a keyed completion without cost
  // omits it; an explicit cost always wins. This pins the invariant in one place
  // so a future voice handler can't silently regress keyless $0 visibility.
  it("keyless completion WITHOUT costUsd derives costUsd:0 on the record AND the log line", () => {
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
    // NOTE: no costUsd passed — the centralized rule must supply 0 for keyless.
    w.completed({ provider: "local", keyless: true, audioBytes: 5000, source: "keyless-local" });
    const rec = recorder.calls.find((c) => c.type === "media.stt.completed");
    expect(rec!.data.costUsd).toBe(0);
    expect(logger.info.mock.calls[0]![0].costUsd).toBe(0);
  });

  it("keyed completion WITHOUT costUsd omits costUsd; an explicit cost wins on both record and log", () => {
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
    // keyed, no cost → omitted (not 0).
    w.completed({ provider: "elevenlabs", keyless: false, audioBytes: 4096, source: "explicit" });
    const rec1 = recorder.calls.find((c) => c.type === "media.tts.completed");
    expect(rec1!.data).not.toHaveProperty("costUsd");
    expect(logger.info.mock.calls[0]![0]).not.toHaveProperty("costUsd");
    // keyed WITH an explicit cost → that cost is carried verbatim (the override wins).
    w.completed({ provider: "elevenlabs", keyless: false, costUsd: 0.0123, source: "explicit" });
    const rec2 = recorder.calls.filter((c) => c.type === "media.tts.completed")[1]!;
    expect(rec2.data.costUsd).toBe(0.0123);
    expect(logger.info.mock.calls[1]![0].costUsd).toBe(0.0123);
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
    // WARN failure line (one call): closed log union + the domain kind
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

  it("no-leak: a credential-bearing URL/Bearer in errMessage never survives in the WARN err: line, and no credential reaches the trajectory data", () => {
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

  // An OPAQUE bearer token (NOT sk-/hex/
  // a known-prefix shape — e.g. a Deepgram/ElevenLabs/custom STT-TTS provider
  // token) must not survive in the WARN err: line. The only sanitizeLogString
  // rule that catches a generic opaque bearer is BEARER_TOKEN_LOG, which is
  // ANCHORED on the literal `Bearer `. Stripping
  // `Bearer` BEFORE calling sanitizeLogString destroys that anchor → the
  // opaque token leaks verbatim. The single sk-proj- token in the test above is
  // caught by the bare-sk- pattern, masking the gap; these opaque/16-char tokens
  // expose it — they fail on a strip-before-sanitize order.
  it("no-leak: an OPAQUE (non-sk-/non-hex) Bearer token from a custom STT/TTS provider never survives in the WARN err: line", () => {
    const recorder = captureRecorder();
    const logger = captureLogger();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      logger,
      agentId: "a",
      kind: "stt",
      requested: { provider: "deepgram", mainProvider: "openai", source: "explicit" },
    });
    // A long opaque token (Deepgram-style) AND a shorter 16-char one — neither
    // matches sk-/hex-40+/a known prefix, so only the Bearer anchor catches them.
    const opaqueLong = "abc123XYZ_shortish_token99";
    const opaqueShort = "DG0123456789abcd";
    const leaky =
      `401 from provider: Authorization: Bearer ${opaqueLong}; retry header Bearer ${opaqueShort}`;
    w.failed({ sttErrorKind: "auth_required", provider: "deepgram", source: "explicit", errMessage: leaky });
    const errField = String(logger.warn.mock.calls[0]![0].err);
    expect(errField).not.toContain(opaqueLong);
    expect(errField).not.toContain(opaqueShort);
    // No raw bearer token of any kind should ride a trailing `Bearer <token>`.
    expect(errField).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/i);
    // The trajectory record never carries the opaque token.
    const rec = recorder.calls.find((c) => c.type === "media.stt.failed");
    expect(JSON.stringify(rec!.data)).not.toContain(opaqueLong);
    expect(JSON.stringify(rec!.data)).not.toContain(opaqueShort);
  });

  it("wireVoiceObs is off-turn-safe: no recorder → no throw, but the log lines STILL fire", () => {
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

// ---------------------------------------------------------------------------
// The voice_degraded system emit.
//
// On a transcription/synthesis FAILURE, wireVoiceObs.failed() ALSO inserts a
// `voice_degraded` health_signal diagnostic row (when an obsStore is wired) so the
// cross-session `comis system-health` voice_health finding (system-findings.ts) has a
// source. The row is CONTENT-FREE: signal + the closed domain errorKind + the
// voice family ONLY — never the raw provider message, never a secret. Insertion is
// best-effort: an absent store no-ops, and a throwing store never breaks the
// handler (the log lines + the trajectory record are the primary obligations).
// ---------------------------------------------------------------------------

/** A capture ObservabilityStore exposing only insertDiagnostic (+ an optional throw). */
function captureObsStore(opts: { throwOnInsert?: boolean } = {}) {
  const rows: Array<{ category: string; details?: string; message: string; severity: string }> = [];
  return {
    rows,
    insertDiagnostic: vi.fn((row: { category: string; details?: string; message: string; severity: string }) => {
      if (opts.throwOnInsert) throw new Error("db is broken");
      rows.push(row);
    }),
  };
}

describe("wireVoiceObs — voice_degraded system emit", () => {
  it("failed() inserts ONE voice_degraded health_signal row carrying the closed domain errorKind + the voice family", () => {
    const logger = captureLogger();
    const obsStore = captureObsStore();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: undefined,
      logger,
      obsStore: obsStore as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    w.failed({ sttErrorKind: "model_load_failed", provider: "local", source: "keyless-local", errMessage: "whisper model failed to load" });
    expect(obsStore.insertDiagnostic).toHaveBeenCalledTimes(1);
    const row = obsStore.rows[0]!;
    expect(row.category).toBe("health_signal");
    const details = JSON.parse(row.details!) as { signal: string; errorKind: string; kind: string };
    expect(details.signal).toBe("voice_degraded");
    expect(details.errorKind).toBe("model_load_failed");
    expect(details.kind).toBe("stt");
  });

  it("completed() inserts NO voice_degraded row (only failures degrade)", () => {
    const logger = captureLogger();
    const obsStore = captureObsStore();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: undefined,
      logger,
      obsStore: obsStore as never,
      agentId: "a",
      kind: "tts",
      requested: { provider: "edge", mainProvider: "openai", source: "keyless-local" },
    });
    w.completed({ provider: "edge", keyless: true, costUsd: 0, source: "keyless-local" });
    expect(obsStore.insertDiagnostic).not.toHaveBeenCalled();
  });

  it("the inserted row is CONTENT-FREE — no raw provider message, no secret in details", () => {
    const logger = captureLogger();
    const obsStore = captureObsStore();
    const w = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: undefined,
      logger,
      obsStore: obsStore as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "openai", mainProvider: "openai", source: "follow-main-key" },
    });
    const leaky = "POST https://api.openai.com/v1/audio/transcriptions failed (Authorization: Bearer sk-proj-abc123def456)";
    w.failed({ sttErrorKind: "network", provider: "openai", source: "follow-main-key", errMessage: leaky });
    const serialized = JSON.stringify(obsStore.rows[0]);
    expect(serialized).not.toContain("sk-proj");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("/v1/audio/transcriptions");
    expect(serialized).not.toContain("api.openai.com");
  });

  it("is best-effort: an absent obsStore no-ops and a throwing obsStore never breaks the handler", () => {
    const logger = captureLogger();
    // absent store
    const wNoStore = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: undefined,
      logger,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(() => wNoStore.failed({ sttErrorKind: "timeout", provider: "local", source: "keyless-local", errMessage: "x" })).not.toThrow();
    // throwing store
    const throwingStore = captureObsStore({ throwOnInsert: true });
    const wThrow = wireVoiceObs({
      sessionKey: "s",
      trajectoryRegistry: undefined,
      logger,
      obsStore: throwingStore as never,
      agentId: "a",
      kind: "stt",
      requested: { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
    });
    expect(() => wThrow.failed({ sttErrorKind: "timeout", provider: "local", source: "keyless-local", errMessage: "x" })).not.toThrow();
    // the WARN failure line still fired despite the insert throwing
    expect(logger.warn).toHaveBeenCalled();
  });
});
