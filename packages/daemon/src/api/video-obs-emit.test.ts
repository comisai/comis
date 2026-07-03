// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createVideoObsEmitter } from "./video-obs-emit.js";

// createVideoObsEmitter — the null-safe, off-turn-safe video
// trajectory direct-emit helper. It is the createVisionObsEmitter twin, but
// trajectory-RECORD-focused: the video handler + poller already
// carry the complete §2.7 logger floor (an INFO completion line + an ERROR/WARN
// with errorKind+hint on EVERY branch), so this emitter adds ONLY the per-session
// trajectory records — it does NOT re-log (which would double-emit the §2.7 line
// the handler / poller-step tests pin). Its value is the recorder resolution by
// sessionKey + the no-op-when-gone primitive off-turn emits need.

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

describe("createVideoObsEmitter", () => {
  it("fires video.requested at construction (the entry record) via the resolved recorder", () => {
    const recorder = captureRecorder();
    const obs = createVideoObsEmitter({
      sessionKey: "default:u1:telegram:c1",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "agent-1",
      requested: { provider: "veo", mainProvider: "google" },
    });
    expect(obs.active).toBe(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("video.requested");
    expect(recorder.calls[0]!.data).toEqual({ provider: "veo", mainProvider: "google" });
  });

  it("submitted() records video.submitted {provider, jobId} (content-free)", () => {
    const recorder = captureRecorder();
    const obs = createVideoObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      requested: { provider: "veo", mainProvider: "google" },
    });
    obs.submitted({ provider: "veo", jobId: "veo-op-1" });
    const rec = recorder.calls.find((c) => c.type === "video.submitted");
    expect(rec).toBeDefined();
    expect(rec!.data).toEqual({ provider: "veo", jobId: "veo-op-1" });
  });

  it("generated() records video.generated with the cost-carry (presence-conditional optionals)", () => {
    const recorder = captureRecorder();
    const obs = createVideoObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      requested: { provider: "veo", mainProvider: "google" },
    });
    obs.generated({ provider: "veo", model: "veo-3.1", costUsd: 1.2, sizeBytes: 9, durationSecs: 8 });
    const rec = recorder.calls.find((c) => c.type === "video.generated");
    expect(rec).toBeDefined();
    expect(rec!.data).toEqual({
      provider: "veo",
      outcome: "ok",
      model: "veo-3.1",
      costUsd: 1.2,
      sizeBytes: 9,
      durationSecs: 8,
    });
  });

  it("generated() omits absent optionals (FAL no-actual-cost) — content stays content-free", () => {
    const recorder = captureRecorder();
    const obs = createVideoObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      requested: { provider: "fal", mainProvider: "fal" },
    });
    obs.generated({ provider: "fal" });
    const rec = recorder.calls.find((c) => c.type === "video.generated");
    expect(rec!.data).toEqual({ provider: "fal", outcome: "ok" });
    expect("costUsd" in rec!.data).toBe(false);
  });

  it("delivered() records video.delivered {channelType, delivered}", () => {
    const recorder = captureRecorder();
    const obs = createVideoObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      requested: { provider: "veo", mainProvider: "google" },
    });
    obs.delivered({ channelType: "telegram", delivered: true });
    const rec = recorder.calls.find((c) => c.type === "video.delivered");
    expect(rec!.data).toEqual({ channelType: "telegram", delivered: true });
  });

  it("failed() records video.failed {errorKind, provider} (the domain kind, no raw message)", () => {
    const recorder = captureRecorder();
    const obs = createVideoObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => recorder } as never,
      agentId: "a",
      requested: { provider: "veo", mainProvider: "google" },
    });
    obs.failed({ errorKind: "content_blocked", provider: "veo" });
    const rec = recorder.calls.find((c) => c.type === "video.failed");
    expect(rec!.data).toEqual({ errorKind: "content_blocked", provider: "veo" });
  });

  it("off-turn safety: no sessionKey / no registry → active=false, every method no-ops (no throw, no record)", () => {
    // The common off-turn case: the recorder is gone (session closed / daemon
    // restarted) or there is no session key. The emitter must NOT throw and must
    // emit NO trajectory record — the offline assembler is the binding
    // oracle; the live emit is best-effort.
    const obs1 = createVideoObsEmitter({
      sessionKey: undefined,
      trajectoryRegistry: undefined,
      agentId: "a",
      requested: { provider: "veo", mainProvider: "google" },
    });
    expect(obs1.active).toBe(false);
    expect(() => {
      obs1.submitted({ provider: "veo", jobId: "j" });
      obs1.generated({ provider: "veo", costUsd: 1 });
      obs1.delivered({ channelType: "telegram", delivered: true });
      obs1.failed({ errorKind: "job_timeout", provider: "veo" });
    }).not.toThrow();

    // A registry whose getRecorder returns undefined (recorder closed) is also a
    // no-op.
    const obs2 = createVideoObsEmitter({
      sessionKey: "s",
      trajectoryRegistry: { getRecorder: () => undefined } as never,
      agentId: "a",
      requested: { provider: "veo", mainProvider: "google" },
    });
    expect(obs2.active).toBe(false);
    expect(() => obs2.generated({ provider: "veo" })).not.toThrow();
  });
});
