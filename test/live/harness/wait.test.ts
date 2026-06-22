// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for `wait.ts` — the AUTO-03 `tg wait` trajectory-tail mechanic
 * (Phase 205, Plan 02).
 *
 * Two suites:
 *   1. `resolveTrajectoryFile` — the canonical pointer resolution chain
 *      (mirror of obs-explain-readers.ts): runtimeFile › co-located fallback ›
 *      no-pointer fallback. NEVER the §2.10 hand-built `<dataDir>/sessions/<id>`
 *      base path that never existed on disk.
 *   2. `waitForTrajectorySignal` — block-until-signal with an enum-validated
 *      `--event` (Pitfall 5), a `--tool` `tool.result` match, an honest
 *      unknown-event reject BEFORE tailing, and the settle-timeout/hard-timeout
 *      fallback (§13-Q4) — never a hang, never a false match.
 *
 * Pure file-I/O against temp dirs + the committed real-shape fixture — no
 * daemon, no key, no network. The trajectory JSONL line shape is the
 * production contract (runtime.ts buildEvent): a top-level `type` envelope with
 * the tool name carried at `data.toolName` (event-bus-bridge tool:executed →
 * tool.result). The fixture pins exactly that shape.
 *
 * TEST-HARNESS — lives under the test tree, never the packages source tree;
 * ZERO production code change. `mkdtempSync` / `writeFileSync` / raw `throw`
 * are fine here (outside every packages source-tree architecture rule).
 *
 * @module
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveTrajectoryFile,
  waitForTrajectorySignal,
} from "./wait.js";

// ---------------------------------------------------------------------------
// The committed real-shape fixture (one line per signal the waiter matches).
// ---------------------------------------------------------------------------

const HERE = join(import.meta.dirname);
const FIXTURE_PATH = join(HERE, "fixtures", "sample-trajectory.jsonl");

// ---------------------------------------------------------------------------
// A temp session-tree layout helper: <tmp>/workspace/sessions/<tenant>/<channel>/x.jsonl
// plus the co-located pointer + the co-located trajectory file.
// ---------------------------------------------------------------------------

interface Layout {
  readonly root: string;
  readonly sessionFile: string;
  readonly pointerPath: string;
  readonly colocatedTrajectory: string;
}

function buildLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), "comis-wait-test-"));
  const channelDir = join(root, "workspace", "sessions", "test", "telegram");
  mkdirSync(channelDir, { recursive: true });
  const sessionFile = join(channelDir, "x.jsonl");
  writeFileSync(sessionFile, "", "utf-8");
  return {
    root,
    sessionFile,
    pointerPath: `${sessionFile}.trajectory-path.json`,
    colocatedTrajectory: `${sessionFile}.trajectory.jsonl`,
  };
}

// ---------------------------------------------------------------------------
// Suite 1 — resolveTrajectoryFile (Task 1).
// ---------------------------------------------------------------------------

describe("resolveTrajectoryFile — canonical pointer resolution chain", () => {
  let layout: Layout;

  beforeEach(() => {
    layout = buildLayout();
  });

  afterEach(() => {
    rmSync(layout.root, { recursive: true, force: true });
  });

  it("returns the pointer runtimeFile when the pointer fence-checks with a non-empty runtimeFile", () => {
    const realPath = join(layout.root, "redirected", "real.jsonl");
    writeFileSync(
      layout.pointerPath,
      JSON.stringify({
        traceSchema: "comis-trajectory-pointer",
        schemaVersion: 1,
        runtimeFile: realPath,
      }),
      "utf-8",
    );

    expect(resolveTrajectoryFile(layout.sessionFile)).toBe(realPath);
  });

  it("falls back to the co-located trajectory file when the pointer runtimeFile is empty", () => {
    writeFileSync(
      layout.pointerPath,
      JSON.stringify({
        traceSchema: "comis-trajectory-pointer",
        schemaVersion: 1,
        runtimeFile: "",
      }),
      "utf-8",
    );

    expect(resolveTrajectoryFile(layout.sessionFile)).toBe(layout.colocatedTrajectory);
  });

  it("falls back to the co-located trajectory file when no pointer file exists at all", () => {
    // No pointer written — must NOT throw the §2.10 wrong-base-path; resolve the
    // co-located convention instead.
    expect(resolveTrajectoryFile(layout.sessionFile)).toBe(layout.colocatedTrajectory);
  });

  it("never returns a hand-built dataDir/sessions/<id> path — only runtimeFile or the co-located file", () => {
    // A malformed (non-fence-checking) pointer also falls back to co-located.
    writeFileSync(layout.pointerPath, "{ not valid json", "utf-8");
    const resolved = resolveTrajectoryFile(layout.sessionFile);
    expect(resolved).toBe(layout.colocatedTrajectory);
    // Defensive: the resolved path stays under the workspace/sessions base, never
    // a flat <root>/sessions/<id> sibling.
    expect(resolved).toContain(join("workspace", "sessions"));
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — waitForTrajectorySignal (Task 2).
// ---------------------------------------------------------------------------

describe("waitForTrajectorySignal — enum-validated block-until-signal with a settle-timeout fallback", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-wait-signal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Copy the committed fixture into a writable temp file the test can append to. */
  function seedFromFixture(name = "traj.jsonl"): string {
    const dest = join(dir, name);
    writeFileSync(dest, readFileSync(FIXTURE_PATH, "utf-8"), "utf-8");
    return dest;
  }

  it("resolves matched on an already-present model.completed line with the matched record", async () => {
    const file = seedFromFixture();
    const result = await waitForTrajectorySignal({
      trajectoryFile: file,
      event: "model.completed",
      settleMs: 50,
      timeoutMs: 2_000,
    });

    expect(result.matched).toBe(true);
    expect(result.type).toBe("model.completed");
    expect(result.reason).toBe("matched");
    const record = result.record as Record<string, unknown>;
    expect(record["type"]).toBe("model.completed");
  });

  it("resolves matched on a tool.result whose data.toolName equals the requested --tool", async () => {
    const file = seedFromFixture();
    const result = await waitForTrajectorySignal({
      trajectoryFile: file,
      tool: "web_search",
      settleMs: 50,
      timeoutMs: 2_000,
    });

    expect(result.matched).toBe(true);
    expect(result.type).toBe("tool.result");
    const record = result.record as { data?: { toolName?: string } };
    expect(record.data?.toolName).toBe("web_search");
  });

  it("does NOT match a tool.result line for a different --tool name (settle-times out honestly instead)", async () => {
    const file = seedFromFixture();
    const result = await waitForTrajectorySignal({
      trajectoryFile: file,
      tool: "no_such_tool",
      settleMs: 50,
      timeoutMs: 2_000,
    });

    expect(result.matched).toBe(false);
    expect(result.reason).toBe("settle_timeout");
  });

  it("rejects an unknown --event BEFORE tailing, naming the invalid value", async () => {
    const file = seedFromFixture();
    await expect(
      waitForTrajectorySignal({
        trajectoryFile: file,
        event: "not_a_real_type",
        settleMs: 50,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/not_a_real_type/);
  });

  it("rejects when neither --event nor --tool is supplied (exactly one required)", async () => {
    const file = seedFromFixture();
    await expect(
      waitForTrajectorySignal({ trajectoryFile: file, settleMs: 50, timeoutMs: 2_000 }),
    ).rejects.toThrow();
  });

  it("settle-times out in well under timeoutMs when the file is static and never matches", async () => {
    // A static file (no matching line, no further appends) with a small settleMs
    // and a large timeoutMs → resolves settle_timeout fast, NOT after timeoutMs.
    const file = join(dir, "static.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "prompt.submitted", data: {} })}\n`,
      "utf-8",
    );
    const start = Date.now();
    const result = await waitForTrajectorySignal({
      trajectoryFile: file,
      event: "model.completed",
      settleMs: 50,
      timeoutMs: 5_000,
    });
    const elapsed = Date.now() - start;

    expect(result.matched).toBe(false);
    expect(result.reason).toBe("settle_timeout");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("resolves on a matching line that appears mid-wait (tail of an append-only file)", async () => {
    const file = join(dir, "appended.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session.started", data: {} })}\n`, "utf-8");

    const waiting = waitForTrajectorySignal({
      trajectoryFile: file,
      event: "session.summary",
      // settleMs long enough that the append wins the race before a settle.
      settleMs: 1_000,
      timeoutMs: 5_000,
    });

    // Append the matching line shortly after the wait begins.
    const appendTimer = setTimeout(() => {
      writeFileSync(
        file,
        `${JSON.stringify({ type: "session.summary", data: { degraded: false } })}\n`,
        { flag: "a" },
      );
    }, 120);
    if (typeof appendTimer.unref === "function") appendTimer.unref();

    const result = await waiting;
    expect(result.matched).toBe(true);
    expect(result.type).toBe("session.summary");
  });

  it("tolerates a not-yet-existing trajectory file and settle-times out honestly", async () => {
    // The daemon writes the trajectory lazily; a wait that starts before the file
    // exists must not throw — it polls, then settle-times out.
    const file = join(dir, "does-not-exist-yet.jsonl");
    const result = await waitForTrajectorySignal({
      trajectoryFile: file,
      event: "model.completed",
      settleMs: 50,
      timeoutMs: 2_000,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("settle_timeout");
  });

  it("skips a malformed JSONL line without crashing and still matches a later valid line", async () => {
    const file = join(dir, "with-garbage.jsonl");
    writeFileSync(
      file,
      [
        "{ this is not json",
        JSON.stringify({ type: "model.completed", data: { durationMs: 10 } }),
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await waitForTrajectorySignal({
      trajectoryFile: file,
      event: "model.completed",
      settleMs: 50,
      timeoutMs: 2_000,
    });
    expect(result.matched).toBe(true);
    expect(result.type).toBe("model.completed");
  });
});
