// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-03 / E3 — the content-free invariant for the OTLP/Prometheus exporter.
 *
 * The exporter is a NEW secret-egress surface: a careless (or hostile) attribute
 * addition, or the `captureContent`/`genaiSemconv` content path, could smuggle a
 * secret VALUE or a message BODY into a span attribute, a metric label, or a log
 * record body. This test pins that the exporter is content-free BY CONSTRUCTION:
 * `sanitizeForPersistence` is re-applied at the boundary (`redactAttributes`),
 * independent of upstream scrubbing, so a planted secret appears in NO emitted
 * attribute — EVEN with `genaiSemconv:true` + `captureContent:true`.
 *
 * It is an ARCHITECTURE-tier test (a cross-cutting content-free invariant) placed
 * in test/architecture/ so the full-workspace gate catches it — per-package runs
 * hide cross-cutting gates (Pitfall 8 / feedback_full_workspace_gates_per_phase).
 *
 * The system-under-test boundary is the REAL compiled extension dist
 * (`redactAttributes` + `emitTurnSpan` from `packages/observability-otel/dist`),
 * driven through the SDK's in-memory exporters (collector-free) — not a copy.
 *
 * LOAD-BEARING: if `redactAttributes` drops its `sanitizeForPersistence` call,
 * the planted secret leaks and this test FAILS — proving the assertion is not a
 * tautology. The "still useful" companion asserts a benign provider/model label
 * survives.
 *
 * @module
 */
import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

// Drive the ACTUAL compiled extension dist (file-URL form is cross-platform).
const redactUrl = pathToFileURL(
  resolve(REPO_ROOT, "packages/observability-otel/dist/redact-attributes.js"),
).href;
const tracesUrl = pathToFileURL(
  resolve(REPO_ROOT, "packages/observability-otel/dist/traces.js"),
).href;
const harnessUrl = pathToFileURL(
  resolve(REPO_ROOT, "packages/observability-otel/dist/test-harness.js"),
).href;

type RedactAttributes = (attrs: Record<string, unknown>) => Record<string, unknown>;
type EmitTurnSpan = (tracer: unknown, args: Record<string, unknown>) => void;
interface SpanFixture {
  provider: { getTracer(name: string): unknown };
  exporter: { getFinishedSpans(): Array<{ attributes: Record<string, unknown> }> };
  shutdown(): Promise<void>;
}
type MakeSpanFixture = () => SpanFixture;

const PLANTED = ["sk-PLANTEDSECRET", "PLANTED2", "PLANTED3", "SECRET-PROMPT-BODY"];

describe("OTEL-03 / E3 — the exporter emits no secret/content even with genaiSemconv:true", () => {
  let redactAttributes: RedactAttributes;
  let emitTurnSpan: EmitTurnSpan;
  let makeSpanFixture: MakeSpanFixture;

  beforeAll(async () => {
    redactAttributes = ((await import(redactUrl)) as { redactAttributes: RedactAttributes }).redactAttributes;
    emitTurnSpan = ((await import(tracesUrl)) as { emitTurnSpan: EmitTurnSpan }).emitTurnSpan;
    makeSpanFixture = ((await import(harnessUrl)) as { makeSpanFixture: MakeSpanFixture }).makeSpanFixture;
  });

  it("Test 1: a planted secret at >=2 nesting levels never survives redactAttributes (the metric-label boundary)", () => {
    const planted = {
      apiKey: "sk-PLANTEDSECRET",
      provider: "anthropic",
      nested: { password: "PLANTED2", deeper: { token: "PLANTED3" } },
    };
    const out = redactAttributes(planted);
    const json = JSON.stringify(out);
    for (const leak of ["sk-PLANTEDSECRET", "PLANTED2", "PLANTED3"]) {
      expect(json, `planted '${leak}' must not survive the exporter re-redaction`).not.toContain(leak);
    }
    // Still useful: the benign provider label survives.
    expect(out["provider"]).toBe("anthropic");
  });

  it("Test 2: with genaiSemconv:true + captureContent:true, NO message body / secret reaches a span attribute", async () => {
    const fx = makeSpanFixture();
    try {
      const tracer = fx.provider.getTracer("comis");
      emitTurnSpan(tracer, {
        comisTraceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        provider: "anthropic",
        model: "claude-opus",
        operation: "chat",
        tokens: { prompt: 100, completion: 50, total: 150 },
        durationMs: 1200,
        genaiSemconv: true,
        captureContent: true,
        inputMessages: [{ role: "user", content: "SECRET-PROMPT-BODY", apiKey: "sk-PLANTEDSECRET" }],
        outputMessages: [{ role: "assistant", content: "reply", password: "PLANTED2" }],
        systemInstructions: "token=PLANTED3",
      });

      const spans = fx.exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const json = JSON.stringify(spans[0]!.attributes);
      for (const leak of PLANTED) {
        expect(json, `planted '${leak}' must not reach any span attribute (genaiSemconv:true)`).not.toContain(leak);
      }
      // Still useful: a content-free GenAI attribute survives.
      const hasProvider =
        spans[0]!.attributes["gen_ai.provider.name"] !== undefined ||
        spans[0]!.attributes["gen_ai.system"] !== undefined;
      expect(hasProvider, "a content-free GenAI attribute must survive (not an empty husk)").toBe(true);
    } finally {
      await fx.shutdown();
    }
  });
});
