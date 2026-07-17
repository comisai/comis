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
import type { DurableRunRecord, DurableRunResumeClaimOutcome } from "@comis/core";

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
  type DurableRowInput,
  type ResumePrincipal,
} from "./orchestrate-durable.js";

/**
 * A fake durable-run store that captures every upsert and serves a canned
 * `getByCheckpoint` — so the row shape written + the resume lookup are both
 * assertable without a real sqlite store.
 */
function makeFakeRuns(over?: {
  getRow?: DurableRunRecord | undefined;
  getError?: Error;
  upsertError?: Error;
  touchError?: Error;
  omitTouch?: boolean;
}): OrchestrateDurableRuns & { upserts: DurableRunRecord[]; touches: Array<{ checkpointId: string; atMs: number }> } {
  const upserts: DurableRunRecord[] = [];
  const touches: Array<{ checkpointId: string; atMs: number }> = [];
  const base: OrchestrateDurableRuns & {
    upserts: DurableRunRecord[];
    touches: Array<{ checkpointId: string; atMs: number }>;
  } = {
    upserts,
    touches,
    upsertCheckpoint: vi.fn(
      async (record: DurableRunRecord): Promise<Result<void, Error>> => {
        upserts.push(record);
        return over?.upsertError ? err(over.upsertError) : ok(undefined);
      },
    ),
    getByCheckpoint: vi.fn(
      async (): Promise<Result<DurableRunRecord | undefined, Error>> =>
        over?.getError ? err(over.getError) : ok(over?.getRow),
    ),
    claimForResume: vi.fn(
      async (): Promise<Result<DurableRunResumeClaimOutcome, Error>> => {
        if (over?.getError) return err(over.getError);
        return over?.getRow
          ? ok({ kind: "claimed", record: over.getRow })
          : ok({ kind: "not_found" });
      },
    ),
  };
  if (!over?.omitTouch) {
    base.touchHeartbeat = vi.fn(
      async (checkpointId: string, atMs: number): Promise<Result<void, Error>> => {
        touches.push({ checkpointId, atMs });
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
    checkpointId: "checkpoint-abc",
    rootRunId: "root-abc",
    agentId: "agent-a",
    sessionKey: "tenant-a:user-a:chat-a",
    ownerTenantId: "tenant-a",
    ownerUserId: "user-a",
    deliveryOrigin: null,
    spawnTree: [],
    caps: [],
    leaseIds: [],
    rootBudget: {
      startedAtMs: 1,
      tokensConsumed: 12,
      usdConsumed: 0.25,
    },
    budgetConsumed: 0.25,
    cronOrigin: null,
    trustLevel: "user",
    status: "running",
    lastHeartbeatAt: 1_700_000_000_000,
    scriptRef: "orch-abc-def.ts",
    checkpointRef: null,
    ...over,
  };
}

const RESUME_PRINCIPAL: ResumePrincipal = {
  agentId: "agent-a",
  sessionKey: "tenant-a:user-a:chat-a",
  ownerTenantId: "tenant-a",
  ownerUserId: "user-a",
  deliveryOrigin: null,
  trustLevel: "user",
  caps: [],
};

function durableInput(over: Partial<DurableRowInput> = {}): DurableRowInput {
  return {
    checkpointId: "checkpoint-1",
    rootRunId: "root-1",
    agentId: RESUME_PRINCIPAL.agentId,
    sessionKey: RESUME_PRINCIPAL.sessionKey,
    ownerTenantId: RESUME_PRINCIPAL.ownerTenantId,
    ownerUserId: RESUME_PRINCIPAL.ownerUserId,
    deliveryOrigin: RESUME_PRINCIPAL.deliveryOrigin,
    caps: [],
    leaseIds: [],
    rootBudget: {
      startedAtMs: 1,
      tokensConsumed: 12,
      usdConsumed: 0.25,
    },
    scriptRef: "orch-1-a.ts",
    nowMs: 1,
    trustLevel: "user",
    ...over,
  };
}

function resumeInput(resumeRunId: string, workspacePath: string, principal = RESUME_PRINCIPAL) {
  return { resumeRunId, workspacePath, principal };
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
      checkpointId: "orch-root",
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
      { checkpointId: "orch-root", atMs: 40_000 },
      { checkpointId: "orch-root", atMs: 70_000 },
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
      checkpointId: "orch-root",
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
    expect(runs.touches).toEqual([{ checkpointId: "orch-root", atMs: 1_000 }]);
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
  it("builds a flat running checkpoint carrying its authenticated identity", () => {
    const row = buildResumableRow(durableInput({
      checkpointId: "checkpoint-1",
      rootRunId: "root-1",
      scriptRef: "orch-1-a.ts",
      nowMs: 42,
      trustLevel: "admin",
    }));
    expect(row.checkpointId).toBe("checkpoint-1");
    expect(row.rootRunId).toBe("root-1");
    expect(row.scriptRef).toBe("orch-1-a.ts");
    expect(row.status).toBe("running");
    // FLAT spawn tree (a string[]) so the DAG-vs-flat discriminator routes it to
    // the flat arm — never a DAG {nodeId,status}[].
    expect(Array.isArray(row.spawnTree)).toBe(true);
    expect(row.spawnTree).toEqual([]);
    expect(row.agentId).toBe(RESUME_PRINCIPAL.agentId);
    expect(row.sessionKey).toBe(RESUME_PRINCIPAL.sessionKey);
    expect(row.ownerTenantId).toBe(RESUME_PRINCIPAL.ownerTenantId);
    expect(row.ownerUserId).toBe(RESUME_PRINCIPAL.ownerUserId);
    expect(row.caps).toEqual([]);
    expect(row.leaseIds).toEqual([]);
    expect(row.budgetConsumed).toBe(0.25);
    expect(row.rootBudget).toEqual({
      startedAtMs: 1,
      tokensConsumed: 12,
      usdConsumed: 0.25,
    });
    expect(row.cronOrigin).toBeNull();
    expect(row.trustLevel).toBe("admin");
    expect(row.lastHeartbeatAt).toBe(42);
    expect(row.checkpointRef).toBeNull();
  });

  it("carries checkpointRef through when a prior checkpoint exists", () => {
    const row = buildResumableRow(durableInput({
      checkpointId: "checkpoint-2",
      rootRunId: "root-2",
      scriptRef: "orch-2-b.py",
      checkpointRef: "results/ckpt-1.json",
      nowMs: 7,
      trustLevel: "user",
    }));
    expect(row.checkpointRef).toBe("results/ckpt-1.json");
    expect(row.scriptRef).toBe("orch-2-b.py");
  });
});

describe("orchestrate-durable — registerDurableRun", () => {
  it("registers a running durable row with scriptRef via the injected store upsert", async () => {
    const runs = makeFakeRuns();
    const result = await registerDurableRun(runs, durableInput({
      checkpointId: "checkpoint-3",
      rootRunId: "root-3",
      scriptRef: "orch-3-c.ts",
      nowMs: 99,
      trustLevel: "guest",
    }));
    expect(result.ok).toBe(true);
    expect(runs.upserts).toHaveLength(1);
    expect(runs.upserts[0]!.rootRunId).toBe("root-3");
    expect(runs.upserts[0]!.scriptRef).toBe("orch-3-c.ts");
    expect(runs.upserts[0]!.status).toBe("running");
    expect(runs.upserts[0]!.spawnTree).toEqual([]);
    expect(runs.upserts[0]!.trustLevel).toBe("guest");
  });

  it("forwards a store error so the runner can treat registration as non-fatal", async () => {
    const runs = makeFakeRuns({ upsertError: new Error("db locked") });
    const result = await registerDurableRun(runs, durableInput({
      checkpointId: "checkpoint-4",
      rootRunId: "root-4",
      scriptRef: "orch-4-d.ts",
      nowMs: 1,
      trustLevel: "user",
    }));
    expect(result.ok).toBe(false);
  });
});

describe("orchestrate-durable — markResumable", () => {
  it("marks the row resumable and returns skipCleanup true when a store is present", async () => {
    const runs = makeFakeRuns();
    const decision = await markResumable(runs, durableInput({
      checkpointId: "checkpoint-5",
      rootRunId: "root-5",
      scriptRef: "orch-5-e.ts",
      nowMs: 5,
      trustLevel: "user",
    }));
    expect(decision.skipCleanup).toBe(true);
    expect(runs.upserts).toHaveLength(1);
    expect(runs.upserts[0]!.status).toBe("running");
    expect(runs.upserts[0]!.scriptRef).toBe("orch-5-e.ts");
  });

  it("is a no-op returning skipCleanup false when no store is present (a non-durable run)", async () => {
    const decision = await markResumable(undefined, durableInput({
      checkpointId: "checkpoint-6",
      rootRunId: "root-6",
      scriptRef: "orch-6-f.ts",
      nowMs: 6,
      trustLevel: "user",
    }));
    expect(decision.skipCleanup).toBe(false);
  });

  it("still skips cleanup when the re-affirm upsert errors (the start row survives)", async () => {
    const runs = makeFakeRuns({ upsertError: new Error("db locked") });
    const decision = await markResumable(runs, durableInput({
      checkpointId: "checkpoint-7",
      rootRunId: "root-7",
      scriptRef: "orch-7-g.ts",
      nowMs: 7,
      trustLevel: "user",
    }));
    // The row was already written at run start; a failed re-affirm must not flip
    // the skip decision — the pinned script + checkpoint must survive regardless.
    expect(decision.skipCleanup).toBe(true);
  });
});

describe("orchestrate-durable — loadResumeSpec", () => {
  const workspacePath = "/ws";

  it("uses the authoritative source-to-replacement claim before reading pinned bytes", async () => {
    const row = makeRow({ caps: ["orch:read"] });
    const claimForResume = vi.fn(async () => ok({ kind: "claimed" as const, record: row }));
    const getByCheckpoint = vi.fn(async () => ok(row));
    const runs = {
      ...makeFakeRuns({ getRow: row }),
      claimForResume,
      getByCheckpoint,
    } as OrchestrateDurableRuns;
    const fs = makeFakeFs();

    const result = await loadResumeSpec(runs, fs, {
      ...resumeInput("checkpoint-abc", workspacePath, {
        ...RESUME_PRINCIPAL,
        caps: ["orch:read", "orch:message"],
      }),
      replacementCheckpointId: "checkpoint-replacement",
      claimedAtMs: 42,
    } as unknown as Parameters<typeof loadResumeSpec>[2]);

    expect(result.ok).toBe(true);
    expect(claimForResume).toHaveBeenCalledWith({
      checkpointId: "checkpoint-abc",
      replacementCheckpointId: "checkpoint-replacement",
      principal: expect.objectContaining({ agentId: "agent-a" }),
      claimedAtMs: 42,
    });
    expect(getByCheckpoint).not.toHaveBeenCalled();
  });

  it("orphans the claimed replacement when its pinned script cannot be loaded", async () => {
    const row = makeRow();
    const markOrphaned = vi.fn(async () => ok(undefined));
    const runs = {
      ...makeFakeRuns({ getRow: row }),
      claimForResume: vi.fn(async () => ok({ kind: "claimed" as const, record: row })),
      markOrphaned,
    } as OrchestrateDurableRuns;

    const result = await loadResumeSpec(runs, makeFakeFs({ exists: false }), {
      ...resumeInput("checkpoint-abc", workspacePath),
      replacementCheckpointId: "checkpoint-replacement",
      claimedAtMs: 42,
    });

    expect(result.ok).toBe(false);
    expect(markOrphaned).toHaveBeenCalledWith(
      "checkpoint-replacement",
      "resume_artifact_validation_failed",
    );
  });

  it("rejects a cross-principal resume before probing or reading the pinned script", async () => {
    const exists = vi.fn(() => true);
    const read = vi.fn(() => "PINNED");
    const runs = makeFakeRuns({
      getRow: makeRow({
        agentId: "agent-owner",
        sessionKey: "tenant-a:user-a:chat-a",
        ownerTenantId: "tenant-a",
        ownerUserId: "user-a",
        deliveryOrigin: null,
      }),
    });

    const result = await loadResumeSpec(runs, { exists, read }, {
      resumeRunId: "checkpoint-owner",
      workspacePath,
      principal: {
        agentId: "agent-attacker",
        sessionKey: "tenant-a:user-a:chat-a",
        ownerTenantId: "tenant-a",
        ownerUserId: "user-a",
        deliveryOrigin: null,
        trustLevel: "user",
        caps: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(exists).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a demoted principal before probing the pinned script", async () => {
    const exists = vi.fn(() => true);
    const read = vi.fn(() => "PINNED");
    const runs = makeFakeRuns({ getRow: makeRow({ trustLevel: "admin" }) });

    const result = await loadResumeSpec(
      runs,
      { exists, read },
      resumeInput("checkpoint-abc", workspacePath, {
        ...RESUME_PRINCIPAL,
        trustLevel: "user",
      }),
    );

    expect(result.ok).toBe(false);
    expect(exists).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps persisted trust and intersects capabilities when the current principal was promoted", async () => {
    const runs = makeFakeRuns({
      getRow: makeRow({ trustLevel: "user", caps: ["orch:read"] }),
    });
    const result = await loadResumeSpec(
      runs,
      makeFakeFs(),
      resumeInput("checkpoint-abc", workspacePath, {
        ...RESUME_PRINCIPAL,
        trustLevel: "admin",
        caps: ["orch:read", "orch:message"],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authority.trustLevel).toBe("user");
    expect(result.value.authority.caps).toEqual(["orch:read"]);
    expect(result.value.authority.rootRunId).toBe("root-abc");
    expect(result.value.authority.sourceCheckpointId).toBe("checkpoint-abc");
  });

  it("loads the pinned bytes for a resumable row, deriving language from the scriptRef", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-abc-def.ts" }) });
    const fs = makeFakeFs({ read: () => "console.log('pinned');\n" });
    const result = await loadResumeSpec(runs, fs, resumeInput("checkpoint-abc", workspacePath));
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
      resumeInput("checkpoint-abc", workspacePath),
    );
    expect(py.ok && py.value.language).toBe("py");
    const js = await loadResumeSpec(
      makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-y.js" }) }),
      makeFakeFs(),
      resumeInput("checkpoint-abc", workspacePath),
    );
    expect(js.ok && js.value.language).toBe("js");
  });

  it("returns the pinned fs bytes as the sole source — it takes no script param", async () => {
    // The loader signature has no `script` param, so a resume can never smuggle
    // new bytes: the returned bytes are exactly what the fs seam read.
    const runs = makeFakeRuns({ getRow: makeRow() });
    const fs = makeFakeFs({ read: () => "THE-ONLY-PINNED-BYTES" });
    const result = await loadResumeSpec(runs, fs, resumeInput("checkpoint-abc", workspacePath));
    expect(result.ok && result.value.scriptBytes).toBe("THE-ONLY-PINNED-BYTES");
  });

  it("carries the resumed run's checkpointRef so resume() rehydrates its checkpoint", async () => {
    // The resumed run HAS a prior checkpoint. loadResumeSpec must surface its ref so the
    // caller seeds it onto the NEW run's durable row → the replayed script's resume() returns
    // that checkpoint (skip completed work) instead of an empty new-root checkpoint.
    const runs = makeFakeRuns({
      getRow: makeRow({ scriptRef: "orch-abc-def.ts", checkpointRef: "results/ckpt-x.json" }),
    });
    const result = await loadResumeSpec(runs, makeFakeFs(), resumeInput("checkpoint-abc", workspacePath));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkpointRef).toBe("results/ckpt-x.json");
  });

  it("checkpointRef is undefined when the resumed run never checkpointed", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-abc-def.ts" }) }); // no checkpointRef
    const result = await loadResumeSpec(runs, makeFakeFs(), resumeInput("checkpoint-abc", workspacePath));
    expect(result.ok && result.value.checkpointRef).toBeUndefined();
  });

  it("honest-errors when the durable row is missing", async () => {
    const runs = makeFakeRuns({ getRow: undefined });
    const result = await loadResumeSpec(runs, makeFakeFs(), resumeInput("checkpoint-gone", workspacePath));
    expect(result.ok).toBe(false);
  });

  it("honest-errors when the row has no pinned scriptRef (not a re-runnable row)", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: null }) });
    const result = await loadResumeSpec(runs, makeFakeFs(), resumeInput("checkpoint-abc", workspacePath));
    expect(result.ok).toBe(false);
  });

  it("honest-errors when the scriptRef extension is not a known language", async () => {
    const runs = makeFakeRuns({ getRow: makeRow({ scriptRef: "orch-x.md" }) });
    const result = await loadResumeSpec(runs, makeFakeFs(), resumeInput("checkpoint-abc", workspacePath));
    expect(result.ok).toBe(false);
  });

  it("honest-errors (no throw) when the pinned script file is gone", async () => {
    const runs = makeFakeRuns({ getRow: makeRow() });
    const result = await loadResumeSpec(
      runs,
      makeFakeFs({ exists: false }),
      resumeInput("checkpoint-abc", workspacePath),
    );
    expect(result.ok).toBe(false);
  });

  it("honest-errors (no throw) when the pinned script cannot be read", async () => {
    const runs = makeFakeRuns({ getRow: makeRow() });
    const fs = makeFakeFs({
      read: () => {
        throw new Error("EIO");
      },
    });
    const result = await loadResumeSpec(runs, fs, resumeInput("checkpoint-abc", workspacePath));
    expect(result.ok).toBe(false);
  });

  it("honest-errors when the store lookup itself fails", async () => {
    const runs = makeFakeRuns({ getError: new Error("row validation failed") });
    const result = await loadResumeSpec(runs, makeFakeFs(), resumeInput("checkpoint-abc", workspacePath));
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
    const result = await loadResumeSpec(runs, fs, resumeInput("checkpoint-abc", workspacePath));
    expect(result.ok).toBe(false);
    // The traversal is refused BEFORE the fs read is ever attempted.
    expect(readCalled).toBe(false);
  });
});

describe("orchestrate-durable — resolveScriptSource (checkpoint carry)", () => {
  const ctx = {
    workspacePath: "/ws",
    runId: "orch-new-run",
    claimedAtMs: 42,
    principal: RESUME_PRINCIPAL,
  };

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
