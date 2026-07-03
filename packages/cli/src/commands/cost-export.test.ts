// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis cost export` CLI command.
 *
 * `cost export` reads the LOCAL ~/.comis observability store (the telemetry lives
 * on disk; an export must not require a live gateway) and emits the corrected-cost
 * quarter-hour (or hourly) buckets as CSV or JSON, each row carrying the four cost
 * rollups + cacheSaved/costCorrection + the pricing-coverage pair
 * (pricingState/missingPricingCount). The agent/provider/model/since filters are
 * threaded as TYPED params bound into the aggregate's prepared statement.
 *
 * The offline read helper is mocked so the command is driven without a real data
 * dir; the captured filter args assert the filters reach the store, and the
 * console output asserts the CSV header + JSON shape + content-free projection.
 *
 * Per the cli-uses-typed-rpc arch invariant: this command contacts NO daemon RPC
 * (it is offline-by-design over the operator-owned local store) — so it contains
 * no `client.call` at all, trivially satisfying the gate.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock the offline read helper so the command runs without a ~/.comis store.
vi.mock("../util/offline-obs.js", () => ({
  readCostExportOffline: vi.fn(),
  resolveOfflineDataDir: vi.fn(() => "/fake/.comis"),
}));

// Mock withSpinner to pass-through (no ora spinner in tests).
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

const { registerCostExportCommand } = await import("./cost-export.js");
const { readCostExportOffline } = await import("../util/offline-obs.js");

/** Two fixture quarter-hour buckets — the shape the offline helper returns. */
const FIXTURE_BUCKETS = [
  {
    bucket: 4 * 3_600_000,
    totalCost: 0.5,
    totalTokens: 1500,
    callCount: 3,
    totalCacheSaved: 0.05,
    totalCostCorrection: 0.01,
    pricingState: "priced" as const,
    missingPricingCount: 1,
  },
  {
    bucket: 4 * 3_600_000 + 900_000,
    totalCost: 0.2,
    totalTokens: 600,
    callCount: 1,
    totalCacheSaved: 0.0,
    totalCostCorrection: 0.0,
    pricingState: "free" as const,
    missingPricingCount: 0,
  },
];

describe("comis cost export", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(readCostExportOffline).mockReset();
    vi.mocked(readCostExportOffline).mockResolvedValue(FIXTURE_BUCKETS);
  });

  afterEach(() => {
    consoleSpy?.restore();
    exitSpy?.restore();
    vi.clearAllMocks();
  });

  async function run(args: string[]): Promise<void> {
    const program = createTestProgram();
    registerCostExportCommand(program);
    await program.parseAsync(["node", "comis", "cost", "export", ...args]);
  }

  it("emits CSV with the 4-bucket + pricing-coverage header row by default", async () => {
    consoleSpy = createConsoleSpy();
    await run([]);
    const out = getSpyOutput(consoleSpy.log);
    const header = out.split("\n").find((l) => l.startsWith("bucket"));
    expect(header).toBeDefined();
    // The export columns: the time bucket, the cost rollups, cacheSaved,
    // costCorrection, and the pricing-coverage pair.
    for (const col of [
      "bucket",
      "totalCost",
      "totalTokens",
      "callCount",
      "totalCacheSaved",
      "totalCostCorrection",
      "pricingState",
      "missingPricingCount",
    ]) {
      expect(header).toContain(col);
    }
    // The fixture rows render (the dominant pricing state + the coverage count).
    expect(out).toContain("priced");
    expect(out).toContain("free");
  });

  it("threads the --agent / --provider / --model / --since filters to the offline read as typed params", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--agent", "agent-a", "--provider", "openai", "--model", "gpt-x", "--since", "3600000"]);
    expect(readCostExportOffline).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(readCostExportOffline).mock.calls[0]!;
    expect(opts.agent).toBe("agent-a");
    expect(opts.provider).toBe("openai");
    expect(opts.model).toBe("gpt-x");
    expect(opts.sinceMs).toBe(3_600_000);
  });

  it("emits the same rows as JSON under --format json", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--format", "json"]);
    const out = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.totalCost).toBe(0.5);
    expect(parsed[0]!.pricingState).toBe("priced");
    expect(parsed[0]!.missingPricingCount).toBe(1);
  });

  it("defaults to hourly buckets but switches to quarter-hour granularity via --quarter-hour", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--quarter-hour"]);
    const [, opts] = vi.mocked(readCostExportOffline).mock.calls[0]!;
    expect(opts.granularity).toBe("quarter-hour");
  });

  it("does NOT leak a non-allowlisted source field into the CSV (content-free)", async () => {
    consoleSpy = createConsoleSpy();
    // Plant a body/secret marker on a fixture row — it is NOT one of the export columns.
    vi.mocked(readCostExportOffline).mockResolvedValueOnce([
      { ...FIXTURE_BUCKETS[0]!, messageBody: "SECRET-BODY-MARKER", apiKey: "sk-LEAK" } as never,
    ]);
    await run([]);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).not.toContain("SECRET-BODY-MARKER");
    expect(out).not.toContain("messageBody");
    expect(out).not.toContain("sk-LEAK");
  });
});
