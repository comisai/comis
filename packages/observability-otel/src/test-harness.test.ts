// SPDX-License-Identifier: Apache-2.0
/**
 * Self-tests for the in-memory exporter fixtures. The harness is the
 * collector-free assertion path the exporter tests rely on; these confirm each
 * fixture factory builds a usable provider + sink and that `sumCounter` filters
 * data points correctly.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { makeSpanFixture, makeMetricFixture, makeLogFixture, sumCounter } from "./test-harness.js";

describe("test-harness fixtures", () => {
  it("makeSpanFixture: a started+ended span lands in the in-memory exporter", async () => {
    const fx = makeSpanFixture();
    const span = fx.provider.getTracer("t").startSpan("s");
    span.end();
    expect(fx.exporter.getFinishedSpans()).toHaveLength(1);
    await fx.shutdown();
  });

  it("makeMetricFixture: a counter add is collected; sumCounter filters by attributes", async () => {
    const fx = makeMetricFixture();
    const counter = fx.provider.getMeter("m").createCounter("comis.cost.usd");
    counter.add(0.05, { provider: "anthropic" });
    counter.add(0.10, { provider: "openai" });
    const metrics = await fx.collect();
    expect(sumCounter(metrics, "comis.cost.usd")).toBeCloseTo(0.15, 6);
    // The filter narrows to a single provider's data points.
    expect(sumCounter(metrics, "comis.cost.usd", (a) => a["provider"] === "anthropic")).toBeCloseTo(0.05, 6);
    // An unknown instrument name sums to 0.
    expect(sumCounter(metrics, "comis.nonexistent")).toBe(0);
    await fx.shutdown();
  });

  it("makeLogFixture: a logger provider + in-memory log sink build and shut down", async () => {
    const fx = makeLogFixture();
    expect(fx.provider).toBeDefined();
    expect(fx.exporter).toBeDefined();
    // The sink starts empty (no records emitted) and shutdown resolves.
    expect(fx.exporter.getFinishedLogRecords()).toHaveLength(0);
    await fx.shutdown();
  });
});
