// SPDX-License-Identifier: Apache-2.0
/**
 * Gate for the artifact-to-action runtime-redrive harness's own guarantees: the
 * scripted policy really drives every shipped world variant to a passing terminal
 * grade, a published record is bound to the invocation that produced it, a drive
 * that did not succeed cannot read as evidence, and cleanup can only remove a data
 * root this harness created.
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bare,
  captureRollupWatermark,
  createDataRoot,
  DATA_ROOT_MARKER,
  disposeDataRoot,
  driveFailures,
  nextCall,
  observedFrom,
  resolveArtifactKind,
  resolveTrajectoryPath,
  selectRunRollup,
  traceBoundToolResults,
} from "./artifact-to-action-drive-oracle.mjs";

type JsonObject = Record<string, unknown>;

interface SimWorkload {
  call(tool: string, args?: JsonObject): JsonObject;
}

const scratchPaths: string[] = [];

function scratchDir() {
  const path = mkdtempSync(join(tmpdir(), "artifact-drive-oracle-"));
  scratchPaths.push(path);
  return path;
}

afterEach(() => {
  while (scratchPaths.length > 0) {
    rmSync(scratchPaths.pop() as string, { recursive: true, force: true });
  }
});

async function loadVariant(variant: string): Promise<SimWorkload> {
  const registry = (await import("../sim/shared/registry.mjs")) as {
    loadWorkload(name: string, opts: { seed: string; variant: string }): Promise<SimWorkload>;
  };
  return registry.loadWorkload("artifact-to-action", { seed: "drive-oracle", variant });
}

/**
 * Replay the scripted policy against the real workload through an OpenAI-shaped
 * message list — the same conversation the harness's provider sees.
 */
function replayScriptedPolicy(sim: SimWorkload) {
  const messages: JsonObject[] = [{ role: "user", content: "process the pending artifact" }];
  const dispatched: string[] = [];
  let grade: JsonObject | undefined;
  for (let turn = 0; turn < 40; turn += 1) {
    const step = nextCall(observedFrom(messages));
    if (!step) return { dispatched, grade };
    const result = sim.call(step.tool, step.args);
    if (step.tool === "finish_case") grade = result;
    dispatched.push(step.tool);
    const callId = `call_${turn}`;
    messages.push({
      role: "assistant",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: `mcp__artifact-action-sim--${step.tool}`, arguments: "{}" },
        },
      ],
    });
    messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify(result) });
  }
  throw new Error("the scripted policy never finished the case");
}

function successRecord(): Parameters<typeof driveFailures>[0] {
  return {
    executeError: undefined,
    expectCommit: true,
    dispatchedTools: ["list_intakes", "finish_case"],
    durableToolResults: 2,
    sessionKey: "test:agent:default:…",
    traceId: "trace-1",
    endReason: "success",
    degraded: false,
    explainSeverity: "ok",
    grade: {
      outcome: "success",
      score: 1,
      committedActions: 1,
      readbackAfterCommit: true,
      rationale: "ok",
    },
  } as never;
}

function writeRollup(dir: string, name: string, rollup: JsonObject) {
  const rollupPath = join(dir, `${name}_session-metadata.json`);
  writeFileSync(rollupPath, JSON.stringify(rollup));
  writeFileSync(
    join(dir, `${name}.jsonl.trajectory-path.json`),
    JSON.stringify({ runtimeFile: `${name}.jsonl.trajectory.jsonl` }),
  );
  return rollupPath;
}

describe("artifact-to-action runtime-drive oracle", () => {
  for (const variant of ["A", "B", "C"]) {
    it(`drives variant ${variant} to a passing terminal grade`, async () => {
      const sim = await loadVariant(variant);
      const replay = replayScriptedPolicy(sim);

      expect(replay.dispatched).toContain("stage_action");
      expect(replay.dispatched.filter((tool) => tool === "commit_action")).toHaveLength(1);
      expect(replay.grade).toMatchObject({
        outcome: "success",
        score: 1,
        committedActions: 1,
        readbackAfterCommit: true,
        embeddedTargetStagedAttempts: 0,
        deniedAuthorizationRequests: 0,
      });
    });
  }

  it("drives the degraded variant to an honest no-commit grade", async () => {
    const sim = await loadVariant("A-degraded");
    const replay = replayScriptedPolicy(sim);

    expect(replay.dispatched).not.toContain("stage_action");
    expect(replay.grade).toMatchObject({ outcome: "success", score: 1, committedActions: 0 });
  });

  it("rejects an unknown world on the command line before acquiring anything", () => {
    const harness = fileURLToPath(new URL("./artifact-to-action-runtime-drive.mjs", import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [harness, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });

    const mistyped = run(["--variant", "A-degrade"]);
    expect(mistyped.status).toBe(2);
    expect(mistyped.stderr).toContain('unknown --variant "A-degrade"');
    expect(mistyped.stderr).toContain("A-degraded");
    expect(mistyped.stdout).toBe("");

    const valueless = run(["--variant"]);
    expect(valueless.status).toBe(2);
    expect(valueless.stderr).toContain("--variant with no value");
  });

  it("rejects a world it cannot classify instead of guessing provenance", () => {
    expect(() => resolveArtifactKind("mystery_artifact", ["a"])).toThrow(/unsupported artifact kind/u);
    expect(() => resolveArtifactKind("object_photo", ["title", "surprise"])).toThrow(
      /classifies .* but the intake requires/u,
    );
  });

  it("reports no failure for a complete successful drive", () => {
    expect(driveFailures(successRecord())).toEqual([]);
  });

  it("distinguishes a missing degraded flag from a reported degraded turn", () => {
    const missing = { ...successRecord(), degraded: undefined };
    const failures = driveFailures(missing as never);

    expect(failures).toContain("the session rollup carried no degraded flag");
    expect(failures).not.toContain("the session rollup reported a degraded turn");
  });

  it("refuses to publish a drive whose terminal grade did not pass", () => {
    const failed = { ...successRecord(), grade: { ...successRecord().grade, outcome: "failure", score: 0 } };
    expect(driveFailures(failed as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("terminal grade was failure")]),
    );

    const missing = { ...successRecord(), grade: undefined };
    expect(driveFailures(missing as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("no terminal grade")]),
    );
  });

  it("refuses to publish a drive whose agent turn failed in band", () => {
    const errored = { ...successRecord(), executeError: "model provider unreachable" };
    expect(driveFailures(errored as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("model provider unreachable")]),
    );
  });

  it("attributes a harness-side scripting failure to the provider, not to agent.execute", () => {
    const unmatched = {
      ...successRecord(),
      policyError: "this completion request offered no tool named commit_action (0 offered)",
    };
    const failures = driveFailures(unmatched as never);

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the scripted provider could not script the next call"),
      ]),
    );
    expect(failures.some((failure) => failure.includes("agent.execute reported"))).toBe(false);
  });

  it("refuses to publish a drive in which the runtime accepted no tool call", () => {
    const silent = { ...successRecord(), dispatchedTools: [], durableToolResults: 0 };
    expect(driveFailures(silent as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("the runtime accepted no tool call")]),
    );
  });

  it("resolves a transport-prefixed tool name to the name the policy scripts", () => {
    expect(bare("mcp__artifact-action-sim--commit_action")).toBe("commit_action");
    expect(bare("commit_action")).toBe("commit_action");
    expect(nextCall(observedFrom([]))).toMatchObject({ tool: "list_intakes" });
    expect(
      nextCall([{ name: "mcp__artifact-action-sim--list_intakes", result: { intakes: [{ id: "I1" }] } }]),
    ).toMatchObject({ tool: "begin_case", args: { intake: "I1" } });
  });

  it("refuses to publish a drive whose durable trace does not match the dispatched calls", () => {
    const orphaned = { ...successRecord(), durableToolResults: 0 };
    expect(driveFailures(orphaned as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("no durable tool results")]),
    );

    const partial = { ...successRecord(), durableToolResults: 1 };
    expect(driveFailures(partial as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("the trajectory recorded 1")]),
    );
  });

  it("refuses to publish a drive whose incident explanation did not complete cleanly", () => {
    const missing = { ...successRecord(), explainSeverity: undefined };
    expect(driveFailures(missing as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("incident explanation")]),
    );

    const degraded = { ...successRecord(), explainSeverity: "warning" };
    expect(driveFailures(degraded as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("incident explanation was warning")]),
    );
  });

  it("requires the degraded variant to commit nothing", () => {
    const degraded = {
      ...successRecord(),
      expectCommit: false,
      grade: { ...successRecord().grade, committedActions: 1 },
    };
    expect(driveFailures(degraded as never)).toEqual(
      expect.arrayContaining([expect.stringContaining("expected no commit")]),
    );
  });

  it("binds the record to this run's rollup and ignores an earlier drive's session", () => {
    const sessions = scratchDir();
    writeRollup(sessions, "prior", { sessionKey: "old", traceId: "old-trace", runId: "old-run", sessionEnd: {} });

    const watermark = captureRollupWatermark(sessions);
    expect(selectRunRollup(sessions, watermark)).toBeUndefined();

    writeRollup(sessions, "other", { sessionKey: "new", traceId: "new-trace", runId: "new-run", sessionEnd: {} });
    expect(selectRunRollup(sessions, watermark)?.rollup).toMatchObject({ traceId: "new-trace" });
  });

  it("re-binds when this run appends to the same session file the previous drive used", () => {
    const sessions = scratchDir();
    writeRollup(sessions, "shared", { sessionKey: "k", traceId: "old-trace", runId: "old-run", sessionEnd: {} });

    const watermark = captureRollupWatermark(sessions);
    expect(selectRunRollup(sessions, watermark)).toBeUndefined();

    writeRollup(sessions, "shared", { sessionKey: "k", traceId: "this-trace", runId: "this-run", sessionEnd: {} });
    expect(selectRunRollup(sessions, watermark)?.rollup).toMatchObject({
      traceId: "this-trace",
      runId: "this-run",
    });
  });

  it("ignores a rollup whose session has not ended", () => {
    const sessions = scratchDir();
    const watermark = captureRollupWatermark(sessions);
    writeRollup(sessions, "inflight", { sessionKey: "k", traceId: "t" });
    expect(selectRunRollup(sessions, watermark)).toBeUndefined();
  });

  it("resolves the trajectory through the rollup's own pointer and counts this trace only", () => {
    const sessions = scratchDir();
    const rollupPath = writeRollup(sessions, "run", {
      sessionKey: "k",
      traceId: "trace-current",
      sessionEnd: {},
    });
    writeFileSync(
      join(sessions, "run.jsonl.trajectory.jsonl"),
      [
        JSON.stringify({ type: "tool.result", traceId: "trace-current" }),
        JSON.stringify({ type: "tool.result", traceId: "trace-earlier" }),
        JSON.stringify({ type: "model.completed", traceId: "trace-current" }),
      ].join("\n"),
    );

    const trajectoryPath = resolveTrajectoryPath(rollupPath);
    expect(trajectoryPath).toBe(join(sessions, "run.jsonl.trajectory.jsonl"));
    expect(traceBoundToolResults(trajectoryPath, "trace-current")).toBe(1);
  });

  it("fails loudly when a rollup has no trajectory pointer beside it", () => {
    const sessions = scratchDir();
    const rollupPath = join(sessions, "orphan_session-metadata.json");
    writeFileSync(rollupPath, JSON.stringify({ sessionEnd: {} }));
    expect(() => resolveTrajectoryPath(rollupPath)).toThrow(/no trajectory pointer/u);
  });

  it("creates its own throwaway data root outside the checkout and removes it", () => {
    const root = createDataRoot(undefined);
    scratchPaths.push(root.path);
    expect(root.created).toBe(true);
    expect(root.path.startsWith(resolve(tmpdir()))).toBe(true);
    expect(existsSync(join(root.path, DATA_ROOT_MARKER))).toBe(true);

    expect(disposeDataRoot(root)).toMatchObject({ removed: true });
    expect(existsSync(root.path)).toBe(false);
  });

  it("refuses an existing path and a path inside a forbidden root", () => {
    const parent = scratchDir();
    const occupied = join(parent, "already-here");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "evidence.json"), "{}");

    expect(() => createDataRoot(occupied)).toThrow(/refusing to reuse the existing path/u);
    expect(existsSync(join(occupied, "evidence.json"))).toBe(true);

    expect(() => createDataRoot(join(parent, "inside"), [parent])).toThrow(
      /refusing to place a throwaway daemon data root inside/u,
    );
    expect(existsSync(join(parent, "inside"))).toBe(false);
  });

  it("never removes a directory it did not create", () => {
    const foreign = scratchDir();
    writeFileSync(join(foreign, "evidence.json"), "{}");

    expect(disposeDataRoot({ path: foreign, created: false })).toMatchObject({ removed: false });
    expect(existsSync(join(foreign, "evidence.json"))).toBe(true);

    expect(disposeDataRoot({ path: foreign, created: true })).toMatchObject({ removed: false });
    expect(existsSync(join(foreign, "evidence.json"))).toBe(true);
  });
});
