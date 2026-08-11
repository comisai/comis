import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readIncidentGraphRun } from "./obs-explain-graph.js";

const cleanupPaths: string[] = [];

async function createGraphMetadata(
  overrides: Record<string, unknown> = {},
): Promise<{ dataDir: string; graphId: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "comis-explain-graph-"));
  cleanupPaths.push(dataDir);
  const graphId = "11111111-1111-4111-8111-111111111111";
  const graphDir = join(dataDir, "graph-runs", graphId);
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    join(graphDir, "_run-metadata.json"),
    JSON.stringify({
      graphId,
      graphName: "private graph label",
      status: "completed",
      traceId: "trace_graph_test",
      sessionKey: "default:agent:default:user_a:telegram:peer:user_a",
      announcementDelivery: "unavailable",
      startedAt: "2026-07-30T06:20:44.795Z",
      completedAt: "2026-07-30T06:20:45.795Z",
      durationMs: 1_000,
      nodesTotal: 1,
      nodesSucceeded: 1,
      nodesFailed: 0,
      nodesSkipped: 0,
      nodesRetried: 0,
      totalCostUsd: 0.02,
      totalTokens: 123,
      nodes: {
        "node-a": {
          status: "completed",
          output: "private node output",
          durationMs: 1_000,
          subAgentRunId: "run-node-a",
          attemptsUsed: 1,
        },
      },
      ...overrides,
    }),
    "utf8",
  );
  return { dataDir, graphId };
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readIncidentGraphRun", () => {
  it("projects persisted graph metadata without private labels or outputs", async () => {
    const { dataDir, graphId } = await createGraphMetadata();

    const result = await readIncidentGraphRun(dataDir, graphId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      graphId,
      status: "completed",
      nodesTotal: 1,
      nodesSucceeded: 1,
      sessionKey: "default:agent:default:user_a:telegram:peer:user_a",
      announcementDelivery: "unavailable",
    });
    expect(JSON.stringify(result.value)).not.toContain("private graph label");
    expect(JSON.stringify(result.value)).not.toContain("private node output");
  });

  it("normalizes historical manual completion metadata to cancelled", async () => {
    const { dataDir, graphId } = await createGraphMetadata({
      status: "completed",
      cancelReason: "manual",
    });

    const result = await readIncidentGraphRun(dataDir, graphId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("cancelled");
    expect(result.value.cancelReason).toBe("manual");
  });

  // A run persisted before the runtime recorded outward disposition is still a
  // valid terminal record. Rejecting it hid the whole graph section behind a
  // graph_not_found verdict naming metadata that is present and readable.
  it("reads a record persisted without an announcement disposition as unknown", async () => {
    const { dataDir, graphId } = await createGraphMetadata({
      announcementDelivery: undefined,
    });

    const result = await readIncidentGraphRun(dataDir, graphId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.announcementDelivery).toBe("unknown");
    expect(result.value.nodesSucceeded).toBe(1);
  });

  it("rejects metadata whose announcement disposition is not a known value", async () => {
    const { dataDir, graphId } = await createGraphMetadata({
      announcementDelivery: "maybe-delivered",
    });

    const result = await readIncidentGraphRun(dataDir, graphId);

    expect(result.ok).toBe(false);
  });

  it("rejects metadata whose graph identifier does not match its path", async () => {
    const { dataDir, graphId } = await createGraphMetadata({
      graphId: "22222222-2222-4222-8222-222222222222",
    });

    const result = await readIncidentGraphRun(dataDir, graphId);

    expect(result.ok).toBe(false);
  });
});
