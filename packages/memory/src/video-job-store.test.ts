// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { ensureVideoJobTable } from "./schema-video-jobs.js";
import { createVideoJobStore } from "./video-job-store.js";
import type { VideoJobStore } from "./video-job-store.js";

// The Phase-189 durable async VideoJobStore — the SQLite-backed, state-machine
// job store the background poller resumes against across a daemon restart
// (JOB-01/JOB-03/JOB-04). Modeled on the production crash-safe delivery queue
// (delivery-queue-adapter.test.ts): an in-memory :memory: db, ensureVideoJobTable
// to create the table, then the frozen factory. No real fs, deterministic.

describe("VideoJobStore", () => {
  let db: Database.Database;
  let store: VideoJobStore;

  // Deterministic clock anchors for the fixtures (the store itself stamps
  // updated_at_ms via systemNowMs() — these are the SUBMIT-time inputs only).
  const submittedAt = 1_700_000_000_000;

  /** Helper to build a minimal JOB-01 submit record. */
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
    // initSchema must create the video_jobs table (Task 2 integration check),
    // but the store's own setup uses ensureVideoJobTable directly so Task 1's
    // RED has its table dependency even before the initSchema wiring lands.
    ensureVideoJobTable(db);
    store = createVideoJobStore(db);
  });

  // -----------------------------------------------------------------------
  // Round-trip + snake→camel fidelity (JOB-01)
  // -----------------------------------------------------------------------

  describe("insert + get round-trip", () => {
    it("persists a job and reads it back with snake→camel field fidelity", async () => {
      const ins = await store.insert(makeRecord());
      expect(ins.ok).toBe(true);

      const got = await store.get("fal-req-abc123", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const job = got.value;
      expect(job).toBeDefined();
      if (!job) return;
      // snake_case columns mapped to camelCase domain fields.
      expect(job.jobId).toBe("fal-req-abc123");
      expect(job.provider).toBe("fal");
      expect(job.model).toBe("fal-ai/veo3.1/fast");
      expect(job.agentId).toBe("alpha");
      expect(job.channelType).toBe("telegram");
      expect(job.channelId).toBe("ch-999");
      expect(job.traceId).toBe("trace-xyz");
      expect(job.state).toBe("pending");
      expect(job.estimatedCostUsd).toBe(2.4);
      // submitted_at_ms → submittedAtMs.
      expect(job.submittedAtMs).toBe(submittedAt);
      expect(job.updatedAtMs).toBe(submittedAt);
    });
  });

  // -----------------------------------------------------------------------
  // listPending — only state='pending' rows (JOB-01)
  // -----------------------------------------------------------------------

  describe("listPending", () => {
    it("returns ONLY rows in state 'pending'", async () => {
      await store.insert(makeRecord({ jobId: "job-pending", agentId: "alpha" }));
      await store.insert(makeRecord({ jobId: "job-done", agentId: "alpha" }));
      // Transition the second job out of pending.
      await store.markDone("job-done", { mediaPath: "/x.mp4", actualCostUsd: 2.4 });

      const pending = await store.listPending();
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      const ids = pending.value.map((j) => j.jobId);
      expect(ids).toContain("job-pending");
      expect(ids).not.toContain("job-done");
      expect(pending.value.every((j) => j.state === "pending")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Agent-scoped get — no cross-agent leak (JOB-04 / TARGET-01 / Pitfall 6)
  // -----------------------------------------------------------------------

  describe("agent scoping", () => {
    it("get(jobId, otherAgent) is not-found; get(jobId, ownerAgent) returns it", async () => {
      await store.insert(makeRecord({ jobId: "job-alpha", agentId: "alpha" }));

      // A DIFFERENT agent's request for the same globally-unique jobId → not-found.
      const cross = await store.get("job-alpha", "beta");
      expect(cross.ok).toBe(true);
      if (cross.ok) expect(cross.value).toBeUndefined();

      // The owning agent sees it.
      const own = await store.get("job-alpha", "alpha");
      expect(own.ok).toBe(true);
      if (own.ok) {
        expect(own.value).toBeDefined();
        expect(own.value?.agentId).toBe("alpha");
      }
    });
  });

  // -----------------------------------------------------------------------
  // session_key column (OBS-04 / Phase 192) — the off-turn recorder fold key
  // -----------------------------------------------------------------------

  describe("sessionKey column (OBS-04)", () => {
    it("round-trips a sessionKey through insert/get/listPending (the off-turn recorder key)", async () => {
      const ins = await store.insert(
        makeRecord({ jobId: "job-sk", agentId: "alpha", sessionKey: "default:u1:telegram:c1" }),
      );
      expect(ins.ok).toBe(true);

      const got = await store.get("job-sk", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.sessionKey).toBe("default:u1:telegram:c1");

      // Also visible on the poller's boot-resume scan (listPending) so the
      // off-turn poller can resolve getRecorder(record.sessionKey).
      const pending = await store.listPending();
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      const row = pending.value.find((j) => j.jobId === "job-sk");
      expect(row?.sessionKey).toBe("default:u1:telegram:c1");
    });

    it("round-trips an absent sessionKey as undefined (nullable column; old rows are NULL)", async () => {
      await store.insert(makeRecord({ jobId: "job-no-sk", agentId: "alpha", sessionKey: undefined }));
      const got = await store.get("job-no-sk", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.sessionKey).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // markDone (JOB-02)
  // -----------------------------------------------------------------------

  describe("markDone", () => {
    it("transitions state to 'done' and records mediaPath + actualCostUsd; advances updatedAtMs", async () => {
      await store.insert(makeRecord({ jobId: "job-x", agentId: "alpha", updatedAtMs: submittedAt }));

      const done = await store.markDone("job-x", { mediaPath: "/videos/job-x.mp4", actualCostUsd: 3.1 });
      expect(done.ok).toBe(true);

      const got = await store.get("job-x", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.state).toBe("done");
      expect(got.value.mediaPath).toBe("/videos/job-x.mp4");
      expect(got.value.actualCostUsd).toBe(3.1);
      // systemNowMs() stamps a real now → strictly later than the fixture submit time.
      expect(got.value.updatedAtMs).toBeGreaterThan(submittedAt);
    });
  });

  // -----------------------------------------------------------------------
  // markFailed (JOB-02)
  // -----------------------------------------------------------------------

  describe("markFailed", () => {
    it("transitions state to 'failed' and records the errorKind in last_error", async () => {
      await store.insert(makeRecord({ jobId: "job-fail", agentId: "alpha" }));

      const failed = await store.markFailed("job-fail", "job_timeout");
      expect(failed.ok).toBe(true);

      const got = await store.get("job-fail", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.state).toBe("failed");
      expect(got.value.lastError).toBe("job_timeout");
    });

    // WR-02 (Phase 190): when an actionable hint is supplied it is persisted to
    // last_error INSTEAD of the bare enum token, so `video.status` returns an
    // operator-facing string (not "empty_response"). RED on pre-fix code: the
    // 3rd arg did not exist and last_error always held the kind.
    it("WR-02: persists the supplied lastError hint (not the bare kind) when provided", async () => {
      await store.insert(makeRecord({ jobId: "job-hint", agentId: "alpha" }));

      const hint = "Veo blocked the prompt by safety/responsible-AI policy. Revise the prompt and retry.";
      const failed = await store.markFailed("job-hint", "content_blocked", hint);
      expect(failed.ok).toBe(true);

      const got = await store.get("job-hint", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.state).toBe("failed");
      // The actionable hint is persisted, not the enum token.
      expect(got.value.lastError).toBe(hint);
      expect(got.value.lastError).not.toBe("content_blocked");
    });
  });

  // -----------------------------------------------------------------------
  // updateProgress (JOB-02)
  // -----------------------------------------------------------------------

  describe("updateProgress", () => {
    it("records the progress value, observable on a subsequent get", async () => {
      await store.insert(makeRecord({ jobId: "job-prog", agentId: "alpha" }));

      const upd = await store.updateProgress("job-prog", 0.5);
      expect(upd.ok).toBe(true);

      const got = await store.get("job-prog", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.progress).toBe(0.5);
      // Progress update does not leave 'pending' state.
      expect(got.value.state).toBe("pending");
    });
  });

  // -----------------------------------------------------------------------
  // incrementDeliveryAttempt (CR-01) — bounded redelivery counter
  // -----------------------------------------------------------------------

  describe("incrementDeliveryAttempt", () => {
    it("increments deliver_attempts atomically and returns the NEW count (0→1→2)", async () => {
      await store.insert(makeRecord({ jobId: "job-attempts", agentId: "alpha" }));

      // A freshly-inserted row starts at 0; the first increment returns 1.
      const first = await store.incrementDeliveryAttempt("job-attempts");
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value).toBe(1);

      const second = await store.incrementDeliveryAttempt("job-attempts");
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.value).toBe(2);

      // The counter is durable — observable on a subsequent get.
      const got = await store.get("job-attempts", "alpha");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.deliverAttempts).toBe(2);
    });

    it("returns 0 when the jobId matches no row (un-inserted row → no infinite in-memory loop signal)", async () => {
      // CR-01 / WR-02: the handler's insert-failure path tracks an un-persisted
      // job in-memory. incrementing a non-existent row must NOT throw and must
      // signal "no row" via a 0 count so the poller can bound it.
      const res = await store.incrementDeliveryAttempt("never-inserted");
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Nullable fidelity — SQLite NULL → z.nullable → undefined at the boundary
  // -----------------------------------------------------------------------

  describe("nullable fidelity", () => {
    it("round-trips absent optional fields as undefined (SQLite NULL → ?? undefined)", async () => {
      await store.insert(
        makeRecord({
          jobId: "job-min",
          agentId: "alpha",
          model: undefined,
          channelType: undefined,
          channelId: undefined,
          traceId: undefined,
          estimatedCostUsd: undefined,
        }),
      );

      const got = await store.get("job-min", "alpha");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      const job = got.value;
      expect(job.model).toBeUndefined();
      expect(job.channelType).toBeUndefined();
      expect(job.channelId).toBeUndefined();
      expect(job.traceId).toBeUndefined();
      expect(job.estimatedCostUsd).toBeUndefined();
      // Non-nullable fields still present.
      expect(job.jobId).toBe("job-min");
      expect(job.provider).toBe("fal");
      expect(job.submittedAtMs).toBe(submittedAt);
    });
  });

  // -----------------------------------------------------------------------
  // Never-throw / corrupt-row degrade — every method returns a Result
  // -----------------------------------------------------------------------

  describe("never-throw / corrupt-row degrade", () => {
    it("a malformed row degrades to err via parseRows, not a throw", async () => {
      await store.insert(makeRecord({ jobId: "job-good", agentId: "alpha" }));
      // Corrupt the row's submitted_at_ms to a TEXT value the z.number() schema rejects.
      // (A row mapper parse failure must surface as Result.err, mirroring the
      // delivery queue's pendingEntries degrade — never an unhandled throw.)
      db.prepare("UPDATE video_jobs SET submitted_at_ms = 'not-a-number' WHERE job_id = 'job-good'").run();

      const got = await store.get("job-good", "alpha");
      expect(got.ok).toBe(false);

      const pending = await store.listPending();
      expect(pending.ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Threat T-189-02: the persisted row carries NO secret column.
  // -----------------------------------------------------------------------

  describe("no-secret schema invariant", () => {
    it("video_jobs has no key/token/secret/bearer/password column", () => {
      const cols = db
        .prepare("PRAGMA table_info(video_jobs)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name.toLowerCase());
      expect(names.length).toBeGreaterThan(0);
      for (const forbidden of ["key", "api_key", "apikey", "token", "secret", "bearer", "password", "authorization"]) {
        expect(names).not.toContain(forbidden);
      }
    });
  });
});

// ===========================================================================
// Task 2: video_jobs table DDL (ensureVideoJobTable) + initSchema wiring.
// Co-located here because Task 1's setup already imports ensureVideoJobTable.
// ===========================================================================

describe("ensureVideoJobTable (video_jobs DDL)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("creates the video_jobs table on a fresh db", () => {
    ensureVideoJobTable(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='video_jobs'")
      .get();
    expect(row).toBeDefined();
  });

  it("is idempotent — calling twice does not throw (CREATE TABLE IF NOT EXISTS)", () => {
    ensureVideoJobTable(db);
    expect(() => ensureVideoJobTable(db)).not.toThrow();
  });

  it("includes a deliver_attempts column defaulting to 0 (CR-01 bounded redelivery)", () => {
    ensureVideoJobTable(db);
    const cols = db.prepare("PRAGMA table_info(video_jobs)").all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const attempts = cols.find((c) => c.name === "deliver_attempts");
    expect(attempts).toBeDefined();
    expect(attempts!.notnull).toBe(1);
    expect(String(attempts!.dflt_value)).toContain("0");
  });

  it("creates the pending partial index and the agent index", () => {
    ensureVideoJobTable(db);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='video_jobs'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_video_jobs_pending");
    expect(names).toContain("idx_video_jobs_agent");
  });

  // OBS-04 (Phase 192): the new session_key column. A fresh db gets it in the
  // CREATE; a db that ran a PRIOR v2.24 build (table without session_key) gets it
  // via the idempotent, PRAGMA-guarded ALTER. Both converge, re-run-safe.
  it("includes a session_key column on a fresh db (OBS-04)", () => {
    ensureVideoJobTable(db);
    const cols = db.prepare("PRAGMA table_info(video_jobs)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("session_key");
  });

  it("ADDs session_key to a prior-build table that lacks it (the idempotent forward-only migration)", () => {
    // Simulate a daemon that ran a prior v2.24 build: a video_jobs table WITHOUT
    // the session_key column (the 189 shape).
    db.exec(`
      CREATE TABLE video_jobs (
        job_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT, agent_id TEXT NOT NULL,
        channel_type TEXT, channel_id TEXT, trace_id TEXT, state TEXT NOT NULL,
        estimated_cost_usd REAL, actual_cost_usd REAL, media_path TEXT, progress REAL,
        last_error TEXT, deliver_attempts INTEGER NOT NULL DEFAULT 0,
        submitted_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      )
    `);
    const before = (db.prepare("PRAGMA table_info(video_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(before).not.toContain("session_key");

    // The migration adds the column (CREATE TABLE IF NOT EXISTS is a no-op on the
    // existing table, so only the ALTER closes the gap).
    ensureVideoJobTable(db);
    const after = (db.prepare("PRAGMA table_info(video_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(after).toContain("session_key");

    // Idempotent: re-running does not throw and does not add the column twice
    // (the PRAGMA guard skips the ALTER once the column is present).
    expect(() => ensureVideoJobTable(db)).not.toThrow();
    const afterTwice = (db.prepare("PRAGMA table_info(video_jobs)").all() as Array<{ name: string }>).filter(
      (c) => c.name === "session_key",
    );
    expect(afterTwice).toHaveLength(1);
  });

  it("initSchema wires the video_jobs table on the boot path", () => {
    // The anti-built-but-not-wired check at the schema layer: a fresh initSchema
    // (the single boot-time DDL call) MUST create video_jobs — not just the
    // standalone helper (JOB-01/JOB-03 restart resume reads this table on boot).
    initSchema(db, 768);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='video_jobs'")
      .get();
    expect(row).toBeDefined();
  });
});
