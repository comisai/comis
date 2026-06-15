// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the video.status RPC handler (Phase 189 Plan 03 — JOB-04).
 *
 * `video.status{job_id}` reads the durable VideoJobStore and reports
 * `{state, progress?, mediaPath?, costUsd?, error?}` for a job, SCOPED to the
 * calling agent. The load-bearing assertion (JOB-04 / TARGET-01 / Pitfall 6 /
 * threat T-189-10): a job belonging to a DIFFERENT agent returns not-found —
 * NEVER the other agent's data. The handler resolves the agent explicitly
 * (`?? "default"`, never silent) and calls the agent-scoped
 * `videoJobStore.get(job_id, agentId)`.
 *
 * The store is the REAL Plan-01 :memory: `createVideoJobStore(db)` (frozen,
 * agent-scoped `get`), seeded with the fixtures — no mock store, so the
 * cross-agent not-found is proven against the actual SQL predicate.
 *
 * @module
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createVideoJobStore, ensureVideoJobTable, type VideoJobStore } from "@comis/memory";
import { VideoStatusContract } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createVideoStatusHandlers } from "./video-status-handlers.js";

describe("video.status handler (JOB-04 — agent-scoped status read)", () => {
  let db: Database.Database;
  let store: VideoJobStore;
  let handler: (params: Record<string, unknown>) => Promise<unknown>;

  const submittedAt = 1_700_000_000_000;

  /** Build a JOB-01 submit record (the SUBMIT-time inputs; markDone/markFailed/
   *  updateProgress mutate the terminal columns). */
  function makeRecord(overrides: Record<string, unknown> = {}) {
    return {
      jobId: "fal-req-abc123",
      provider: "fal",
      model: "fal-ai/veo3.1/fast",
      agentId: "alpha",
      channelType: "telegram",
      channelId: "ch-999",
      traceId: "trace-xyz",
      state: "pending" as const,
      estimatedCostUsd: 2.4,
      submittedAtMs: submittedAt,
      updatedAtMs: submittedAt,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    ensureVideoJobTable(db);
    store = createVideoJobStore(db);
    const handlers = createVideoStatusHandlers({ videoJobStore: store, logger: createMockLogger() });
    handler = handlers[VideoStatusContract.method] as typeof handler;
  });

  // -------------------------------------------------------------------------
  // Contract presence — VideoStatusContract is exported + has the z.enum state
  // -------------------------------------------------------------------------
  it("registers exactly the [video.status] method key", () => {
    const handlers = createVideoStatusHandlers({ videoJobStore: store, logger: createMockLogger() });
    expect(Object.keys(handlers)).toEqual([VideoStatusContract.method]);
    expect(VideoStatusContract.method).toBe("video.status");
  });

  // -------------------------------------------------------------------------
  // Happy path — a 'done' job maps actualCostUsd→costUsd (lastError absent)
  // -------------------------------------------------------------------------
  it("returns {state:'done', mediaPath, costUsd} for a completed job (maps actualCostUsd→costUsd)", async () => {
    await store.insert(makeRecord());
    const done = await store.markDone("fal-req-abc123", {
      mediaPath: "/ws/media/videos/abc.mp4",
      actualCostUsd: 2.1,
    });
    expect(done.ok).toBe(true);

    const res = (await handler({ job_id: "fal-req-abc123", _agentId: "alpha" })) as Record<string, unknown>;
    expect(res.state).toBe("done");
    expect(res.mediaPath).toBe("/ws/media/videos/abc.mp4");
    expect(res.costUsd).toBe(2.1);
    // lastError is absent → no `error` key on a done job.
    expect(res.error).toBeUndefined();
    // The response validates against the contract (state is the z.enum).
    expect(() => VideoStatusContract.response.parse(res)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Pending — progress surfaced, no mediaPath/costUsd
  // -------------------------------------------------------------------------
  it("returns {state:'pending', progress} for an in-flight job (no mediaPath/costUsd)", async () => {
    await store.insert(makeRecord());
    await store.updateProgress("fal-req-abc123", 0.3);

    const res = (await handler({ job_id: "fal-req-abc123", _agentId: "alpha" })) as Record<string, unknown>;
    expect(res.state).toBe("pending");
    expect(res.progress).toBe(0.3);
    expect(res.mediaPath).toBeUndefined();
    expect(res.costUsd).toBeUndefined();
    expect(() => VideoStatusContract.response.parse(res)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Failed — last_error surfaced as `error`
  // -------------------------------------------------------------------------
  it("returns {state:'failed', error} for a failed job (last_error → error)", async () => {
    await store.insert(makeRecord());
    await store.markFailed("fal-req-abc123", "content_blocked");

    const res = (await handler({ job_id: "fal-req-abc123", _agentId: "alpha" })) as Record<string, unknown>;
    expect(res.state).toBe("failed");
    expect(res.error).toBe("content_blocked");
    expect(() => VideoStatusContract.response.parse(res)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // THE MUST-DIFFER POINT — cross-agent scoping (JOB-04 / Pitfall 6 / T-189-10)
  // -------------------------------------------------------------------------
  it("returns not-found for a job owned by ANOTHER agent — never the other agent's data", async () => {
    // A 'done' job for alpha with a real mediaPath + cost.
    await store.insert(makeRecord({ agentId: "alpha" }));
    await store.markDone("fal-req-abc123", {
      mediaPath: "/ws/media/videos/alpha-secret.mp4",
      actualCostUsd: 9.99,
    });

    // Beta queries alpha's globally-unique jobId.
    const res = (await handler({ job_id: "fal-req-abc123", _agentId: "beta" })) as Record<string, unknown>;

    // Not-found response — the contract-valid failed shape with the scoped message.
    expect(res.state).toBe("failed");
    expect(res.error).toBe("No video job fal-req-abc123 for this agent");
    expect(() => VideoStatusContract.response.parse(res)).not.toThrow();

    // The CORE leak assertion: alpha's mediaPath + cost must NOT appear anywhere
    // in beta's response.
    expect(res.mediaPath).toBeUndefined();
    expect(res.costUsd).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("alpha-secret.mp4");
    expect(JSON.stringify(res)).not.toContain("9.99");
  });

  // -------------------------------------------------------------------------
  // Explicit default (never silent) — TARGET-01
  // -------------------------------------------------------------------------
  it("resolves _agentId='default' explicitly when omitted (a job under 'default' is found)", async () => {
    await store.insert(makeRecord({ agentId: "default" }));
    await store.markDone("fal-req-abc123", { mediaPath: "/ws/media/videos/d.mp4" });

    // No _agentId on the request → resolves "default" explicitly.
    const res = (await handler({ job_id: "fal-req-abc123" })) as Record<string, unknown>;
    expect(res.state).toBe("done");
    expect(res.mediaPath).toBe("/ws/media/videos/d.mp4");

    // The SAME job is NOT visible to a non-default agent (scoping holds for default too).
    const beta = (await handler({ job_id: "fal-req-abc123", _agentId: "beta" })) as Record<string, unknown>;
    expect(beta.state).toBe("failed");
    expect(beta.mediaPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // A genuinely-unknown jobId (this agent) is not-found, not a thrown error
  // -------------------------------------------------------------------------
  it("returns the not-found failed shape for a jobId that does not exist", async () => {
    const res = (await handler({ job_id: "nope-404", _agentId: "alpha" })) as Record<string, unknown>;
    expect(res.state).toBe("failed");
    expect(res.error).toBe("No video job nope-404 for this agent");
    expect(() => VideoStatusContract.response.parse(res)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Contract input validation — a malformed request (missing job_id) is rejected
  // -------------------------------------------------------------------------
  it("rejects a malformed request (missing job_id) via VideoStatusContract.request.parse", async () => {
    await expect(handler({ _agentId: "alpha" })).rejects.toThrow();
  });
});
