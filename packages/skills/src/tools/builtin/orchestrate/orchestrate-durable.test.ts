// SPDX-License-Identifier: Apache-2.0
/**
 * macOS-unit tests for the orchestrate durable-run sibling: the resumable-row
 * lifecycle (build the row, register at start, mark resumable on a timeout, the
 * skip-clean decision) + the pinned-byte resume loader. Pure — an injected fake
 * durable-run store + fake fs seam, no real sqlite / spawn / bwrap.
 *
 * @module
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok, err, type Result } from "@comis/shared";
import type { DurableRunRecord } from "@comis/core";

import {
  buildResumableRow,
  registerDurableRun,
  markResumable,
  loadResumeSpec,
  resolveScriptSource,
  startDurableKeepAlive,
  withDurableKeepAlive,
  defaultOrchestrateDurableFs,
  type OrchestrateDurableRuns,
  type OrchestrateDurableFs,
} from "./orchestrate-durable.js";

/**
 * A fake durable-run store that captures every upsert and serves a canned
 * `getByRootRun` — so the row shape written + the resume lookup are both
 * assertable without a real sqlite store.
 */
function makeFakeRuns(over?: {
  getRow?: DurableRunRecord | undefined;
  getError?: Error;
  upsertError?: Error;
  touchError?: Error;
  omitTouch?: boolean;
}): OrchestrateDurableRuns & { upserts: DurableRunRecord[]; touches: Array<{ rootRunId: string; atMs: number }> } {
  const upserts: DurableRunRecord[] = [];
  const touches: Array<{ rootRunId: string; atMs: number }> = [];
  const base: OrchestrateDurableRuns & {
    upserts: DurableRunRecord[];
    touches: Array<{ rootRunId: string; atMs: number }>;
  } = {
    upserts,
    touches,
    upsertCheckpoint: vi.fn(
      async (record: DurableRunRecord): Promise<Result<void, Error>> => {
        upserts.push(record);
        return over?.upsertError ? err(over.upsertError) : ok(undefined);
      },
    ),
    getByRootRun: vi.fn(
      async (): Promise<Result<DurableRunRecord | undefined, Error>> =>
        over?.getError ? err(over.getError) : ok(over?.getRow),
    ),
  };
  if (!over?.omitTouch) {
    base.touchHeartbeat = vi.fn(
      async (rootRunId: string, atMs: number): Promise<Result<void, Error>> => {
        touches.push({ rootRunId, atMs });
        return over?.touchError ? err(over.touchError) : ok(undefined);
      },
    );
  }
  return base;
}

/** A fake fs seam — canned exists/read so the loader logic is pure. */
function makeFakeFs(over?: {
  exists?: boolean;
  read?: () => string;
}): OrchestrateDurableFs {
  return {
    exists: () => over?.exists ?? true,
    read: over?.read ?? (() => "PINNED-BYTES"),
  };
}

/** A canned resumable row for the loader tests. */
function makeRow(over?: Partial<DurableRunRecord>): DurableRunRecord {
  return {
    rootRunId: "root-abc",
    spawnTree: [],
    caps: [],
    leaseIds: [],
    budgetConsumed: 0,
    cronOrigin: null,
    stepIndex: -1,
    status: "running",
    lastHeartbeatAt: 1_700_000_000_000,
    scriptRef: "orch-abc-def.ts",
    ...over,
  };
}

describe("orchestrate-durable — startDurableKeepAlive", () => {
  it("touches the durable heartbeat with a FRESH clock read on each scheduled tick", () => {
    // A flat orchestrate run stamps lastHeartbeatAt only at start / checkpoint / timeout.
    // Without a keep-alive, a long LIVE run that never checkpoints goes stale and the
    // watchdog's no-progress re-anchor cap can orphan + reclaim it mid-run. The keep-alive
    // advances the heartbeat while the child is alive so a live run is never seen as stale.
    const runs = makeFakeRuns();
    let captured: (() => void) | undefined;
    let capturedMs = 0;
    let stopped = false;
    const scheduler = (cb: () => void, ms: number): (() => void) => {
      captured = cb;
      capturedMs = ms;
      return () => {
        stopped = true;
      };
    };
    let clock = 1_000;
    const stop = startDurableKeepAlive({
      runs,
      rootRunId: "orch-root",
      now: () => clock,
      keepAliveMs: 30_000,
      scheduler,
    });
    expect(capturedMs).toBe(30_000);
    expect(runs.touches).toHaveLength(0); // nothing until a tick fires

    clock = 40_000;
    captured?.();
    clock = 70_000;
    captured?.();

    expect(runs.touches).toEqual([
      { rootRunId: "orch-root", atMs: 40_000 },
      { rootRunId: "orch-root", atMs: 70_000 },
    ]);
    stop();
    expect(stopped).toBe(true);
  });

  it("is a no-op (never schedules) when the store cannot touch heartbeats", () => {
    const runs = makeFakeRuns({ omitTouch: true });
    let scheduled = false;
    const scheduler = (): (() => void) => {
      scheduled = true;
      return () => {};
    };
    const stop = startDurableKeepAlive({
      runs,
      rootRunId: "orch-root",
      now: () => 1,
      keepAliveMs: 30_000,
      scheduler,
    });
    expect(scheduled).toBe(false);
    stop(); // safe no-op
  });
});

describe("orchestrate-durable — withDurableKeepAlive", () => {
  it("keeps the heartbeat alive for the whole fn and stops it after (even on throw)", async () => {
    const runs = makeFakeRuns();
    let clock = 1_000;
    let stopped = false;
    const scheduler = (cb: () => void, _ms: number): (() => void) => {
      // fire one tick synchronously while fn is in flight, then a stop() that flips the flag
      cb();
      return () => {
        stopped = true;
      };
    };
    const result = await withDurableKeepAlive(
      runs,
      "orch-root",
      { now: () => clock, scheduler },
      async () => {
        clock = 2_000;
        return "OK";
      },
    );
    expect(result).toBe("OK");
    expect(runs.touches).toEqual([{ rootRunId: "orch-root", atMs: 1_000 }]);
    expect(stopped).toBe(true);

    // Stops even when fn throws.
    stopped = false;
    await expect(
      withDurableKeepAlive(runs, "orch-root", { now: () => clock, scheduler }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(stopped).toBe(true);
  });

  it("is a pass-through no-op when durability is off (runs undefined) — never touches", async () => {
    const runs = makeFakeRuns();
    const result = await withDurableKeepAlive(
      undefined,
      "orch-root",
      { now: () => 1 },
      async () => "PLAIN",
    );
    expect(result).toBe("PLAIN");
    expect(runs.touches).toHaveLength(0);
  });
});

describe("orchestrate-durable — buildResumableRow", () => {
  it("builds a FLAT running row carrying scriptRef with the never-sent step sentinel", () => {
    const row = buildResumableRow({
      rootRunId: "root-1",
      scriptRef: "orch-1-a.ts",
      nowMs: 42,
    });
    expect(row.rootRunId).toBe("root-1");
    expect(row.scriptRef).toBe("orch-1-a.ts");
    expect(row.status).toBe("running");
    // FLAT spawn tree (a string[]) so the DAG-vs-flat discriminator routes it to
    // the flat arm — never a DAG {nodeId,status}[].
    expect(Array.isArray(row.spawnTree)).toBe(true);
    expect(row.spawnTree).toEqual([]);
    // The step index is the -1 never-sent sentinel (maps to outward_step, which
    // the store's upsert omits — the counter is never written here).
    expect(row.stepIndex).toBe(-1);
    expect(row.caps).toEqual([]);
    expect(row.leaseIds).toEqual([]);
    expect(row.budgetConsumed).toBe(0);
    expect(row.cronOrigin).toBeNull();
    expect(row.lastHeartbeatAt).toBe(42);
    // No checkpoint yet at run start — the field is omitted, not a phantom null.
    expect(row.checkpointRef).toBeUndefined();
  });

  it("carries checkpointRef through when a prior checkpoint exists", () => {
    const row = buildResumableRow({
      rootRunId: "root-2",
      scriptRef: "orch-2-b.py",
      checkpointRef: "results/ckpt-1.json",
      nowMs: 7,
    });
    expect(row.checkpointRef).toBe("results/ckpt-1.json");
    expect(row.scriptRef).toBe("orch-2-b.py");
  });
});

describe("orchestrate-durable — registerDurableRun", () => {
  it("registers a running durable row with scriptRef via the injected store upsert", async () => {
    const runs = makeFakeRuns();
    const result = await registerDurableRun(runs, {
      rootRunId: "root-3",
      scriptRef: "orch-3-c.ts",
      nowMs: 99,
    });
    expect(result.ok).toBe(true);
    expect(runs.upserts).toHaveLength(1);
    expect(runs.upserts[0]!.rootRunId).toBe("root-3");
    expect(runs.upserts[0]!.scriptRef).toBe("orch-3-c.ts");
    expect(runs.upserts[0]!.status).toBe("running");
    expect(runs.upserts[0]!.spawnTree).toEqual([]);
  });

  it("forwards a store error so the runner can treat registration as non-fatal", async () => {
    const runs = makeFakeRuns({ upsertError: new Error("db locked") });
    const result = await registerDurableRun(runs, {
      rootRunId: "root-4",
      scriptRef: "orch-4-d.ts",
      nowMs: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("orchestrate-durable — markResumable", () => {
  it("marks the row resumable and returns skipCleanup true when a store is present", async () => {
    const runs = makeFakeRuns();
    const decision = await markResumable(runs, {
      rootRunId: "root-5",
      scriptRef: "orch-5-e.ts",
      nowMs: 5,
    });
    expect(decision.skipCleanup).toBe(true);
    expect(runs.upserts).toHaveLength(1);
    expect(runs.upserts[0]!.status).toBe("running");
    expect(runs.upserts[0]!.scriptRef).toBe("orch-5-e.ts");
  });

  it("is a no-op returning skipCleanup false when no store is present (a non-durable run)", async () => {
    const decision = await markResumable(undefined, {
      rootRunId: "root-6",
      scriptRef: "orch-6-f.ts",
      nowMs: 6,
    });
    expect(decision.skipCleanup).toBe(false);
  });

  it("still skips cleanup when the re-affirm upsert errors (the start row survives)", async () => {
    const runs = makeFakeRuns({ upsertError: new Error("db locked") });
    const decision = await markResumable(runs, {
      rootRunId: "root-7",
      scriptRef: "orch-7-g.ts",
      nowMs: 7,
    });
    // The row was already written at run start; a failed re-affirm must not flip
    // the skip decision — the pinned script + checkpoint must survive regardless.
    expect(decision.skipCleanup).toBe(true);
  });
});

describe("orchestrate-durable — loadResumeSpec", () => {
  const workspacePath = "/ws";

  it("loads the pinned bytes for a resumable row, deriving language from the scriptRef", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-abc-def.ts" }) });
    const fs = makeFakeFs({ read: () => "console.log('pinned');\n" });
    const result = await loadResumeSpec(runs, fs, { resumeRunId: "root-abc", workspacePath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scriptBytes).toBe("console.log('pinned');\n");
    expect(result.value.language).toBe("ts");
    expect(result.value.scriptRef).toBe("orch-abc-def.ts");
  });

  it("derives the py and js language from the pinned scriptRef extension", async () => {
    const py = await loadResumeSpec(
      makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-x.py" }) }),
      makeFakeFs(),
      { resumeRunId: "root-abc", workspacePath },
    );
    expect(py.ok && py.value.language).toBe("py");
    const js = await loadResumeSpec(
      makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-y.js" }) }),
      makeFakeFs(),
      { resumeRunId: "root-abc", workspacePath },
    );
    expect(js.ok && js.value.language).toBe("js");
  });

  it("returns the pinned fs bytes as the sole source — it takes no script param", async () => {
    // The loader signature has no `script` param, so a resume can never smuggle
    // new bytes: the returned bytes are exactly what the fs seam read.
    const runs = makeFakeRuns({ getRow: makeRow() });
    const fs = makeFakeFs({ read: () => "THE-ONLY-PINNED-BYTES" });
    const result = await loadResumeSpec(runs, fs, { resumeRunId: "root-abc", workspacePath });
    expect(result.ok && result.value.scriptBytes).toBe("THE-ONLY-PINNED-BYTES");
  });

  it("carries the resumed run's checkpointRef so resume() rehydrates its checkpoint", async () => {
    // The resumed run HAS a prior checkpoint. loadResumeSpec must surface its ref so the
    // caller seeds it onto the NEW run's durable row → the replayed script's resume() returns
    // that checkpoint (skip completed work) instead of an empty new-root checkpoint.
    const runs = makeFakeRuns({
      getRow: makeRow({ scriptRef: "orch-abc-def.ts", checkpointRef: "results/ckpt-x.json" }),
    });
    const result = await loadResumeSpec(runs, makeFakeFs(), { resumeRunId: "root-abc", workspacePath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkpointRef).toBe("results/ckpt-x.json");
  });

  it("checkpointRef is undefined when the resumed run never checkpointed", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-abc-def.ts" }) }); // no checkpointRef
    const result = await loadResumeSpec(runs, makeFakeFs(), { resumeRunId: "root-abc", workspacePath });
    expect(result.ok && result.value.checkpointRef).toBeUndefined();
  });

  it("honest-errors when the durable row is missing", async () => {
    const runs = makeFakeRuns({ getRow: undefined });
    const result = await loadResumeSpec(runs, makeFakeFs(), {
      resumeRunId: "root-gone",
      workspacePath,
    });
    expect(result.ok).toBe(false);
  });

  it("honest-errors when the row has no pinned scriptRef (not a re-runnable row)", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: null }) });
    const result = await loadResumeSpec(runs, makeFakeFs(), {
      resumeRunId: "root-abc",
      workspacePath,
    });
    expect(result.ok).toBe(false);
  });

  it("honest-errors when the scriptRef extension is not a known language", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-x.md" }) });
    const result = await loadResumeSpec(runs, makeFakeFs(), {
      resumeRunId: "root-abc",
      workspacePath,
    });
    expect(result.ok).toBe(false);
  });

  it("honest-errors (no throw) when the pinned script file is gone", async () => {
    const runs = makeFakeRuns({ getRow: makeRow() });
    const result = await loadResumeSpec(runs, makeFakeFs({ exists: false }), {
      resumeRunId: "root-abc",
      workspacePath,
    });
    expect(result.ok).toBe(false);
  });

  it("honest-errors (no throw) when the pinned script cannot be read", async () => {
    const runs = makeFakeRuns({ getRow: makeRow() });
    const fs = makeFakeFs({
      read: () => {
        throw new Error("EIO");
      },
    });
    const result = await loadResumeSpec(runs, fs, { resumeRunId: "root-abc", workspacePath });
    expect(result.ok).toBe(false);
  });

  it("honest-errors when the store lookup itself fails", async () => {
    const runs = makeFakeRuns({ getError: new Error("row validation failed") });
    const result = await loadResumeSpec(runs, makeFakeFs(), {
      resumeRunId: "root-abc",
      workspacePath,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a scriptRef that escapes the workspace (path traversal) before any read", async () => {
    let readCalled = false;
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: "../evil.ts" }) });
    const fs = makeFakeFs({
      read: () => {
        readCalled = true;
        return "x";
      },
    });
    const result = await loadResumeSpec(runs, fs, { resumeRunId: "root-abc", workspacePath });
    expect(result.ok).toBe(false);
    // The traversal is refused BEFORE the fs read is ever attempted.
    expect(readCalled).toBe(false);
  });
});

describe("orchestrate-durable — resolveScriptSource (checkpoint carry)", () => {
  const ctx = { workspacePath: "/ws", runId: "orch-new-run" };

  it("threads the resumed run's checkpointRef onto the resolved source", async () => {
    const runs = makeFakeRuns({
      getRow: makeRow({ scriptRef: "orch-old.js", checkpointRef: "results/ckpt-old.json" }),
    });
    const resolved = await resolveScriptSource(
      { script: "IGNORED", language: "js", resumeRunId: "root-old" },
      runs,
      makeFakeFs({ read: () => "PINNED" }),
      ctx,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // pinned bytes (smuggled `script` ignored) AND the resumed checkpointRef carried through
    expect(resolved.value.script).toBe("PINNED");
    expect(resolved.value.checkpointRef).toBe("results/ckpt-old.json");
  });

  it("a fresh run (no resumeRunId) carries no checkpointRef", async () => {
    const resolved = await resolveScriptSource(
      { script: "fresh();", language: "ts" },
      makeFakeRuns(),
      makeFakeFs(),
      ctx,
    );
    expect(resolved.ok && resolved.value.script).toBe("fresh();");
    expect(resolved.ok && resolved.value.checkpointRef).toBeUndefined();
  });
});

describe("orchestrate-durable — defaultOrchestrateDurableFs", () => {
  it("exists and read reflect the real filesystem for a pinned script", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-orch-durable-"));
    try {
      const file = join(dir, "orch-real.ts");
      writeFileSync(file, "REAL-BYTES\n");
      expect(defaultOrchestrateDurableFs.exists(file)).toBe(true);
      expect(defaultOrchestrateDurableFs.read(file)).toBe("REAL-BYTES\n");
      expect(defaultOrchestrateDurableFs.exists(join(dir, "missing.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
