// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn span emission carries the Comis traceId as the
 * `comis.trace_id` ATTRIBUTE (not the OTel trace id) + content-free
 * GenAI attributes; the 3 content attrs (input/output messages, system
 * instructions) are ABSENT with `captureContent:false`, and stay absent even
 * with `genaiSemconv:true`.
 *
 * Asserted via an `InMemorySpanExporter` (collector-free).
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeSpanFixture, type SpanFixture } from "./test-harness.js";
import { emitTurnSpan } from "./traces.js";

describe("emitTurnSpan (content-free spans with the comis.trace_id attribute)", () => {
  let fx: SpanFixture | undefined;
  afterEach(async () => {
    if (fx) await fx.shutdown();
    fx = undefined;
  });

  it("carries comis.trace_id === the Comis UUID (an ATTRIBUTE, not the OTel trace id)", () => {
    fx = makeSpanFixture();
    const tracer = fx.provider.getTracer("comis");
    const comisTraceId = "11111111-2222-3333-4444-555555555555";

    emitTurnSpan(tracer, {
      comisTraceId,
      provider: "anthropic",
      model: "claude-opus",
      operation: "chat",
      tokens: { prompt: 100, completion: 50, total: 150 },
      durationMs: 1200,
    });

    const spans = fx.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    // The Comis UUID rides as an attribute…
    expect(span.attributes["comis.trace_id"]).toBe(comisTraceId);
    // …NOT as the OTel trace id (which is a 32-hex SDK-generated id, not the UUID).
    expect(span.spanContext().traceId).not.toBe(comisTraceId);
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("carries content-free GenAI attrs (provider/operation/model/token counts) but NOT the 3 content attrs (captureContent:false default)", () => {
    fx = makeSpanFixture();
    const tracer = fx.provider.getTracer("comis");

    emitTurnSpan(tracer, {
      comisTraceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      provider: "anthropic",
      model: "claude-opus",
      operation: "chat",
      tokens: { prompt: 100, completion: 50, total: 150 },
      durationMs: 1200,
      // Even if a caller passes message bodies, captureContent:false omits them.
      inputMessages: [{ role: "user", content: "SECRET-PROMPT-BODY" }],
      outputMessages: [{ role: "assistant", content: "SECRET-COMPLETION-BODY" }],
      systemInstructions: "SECRET-SYSTEM-PROMPT",
    });

    const span = fx.exporter.getFinishedSpans()[0]!;
    // Content-free metadata present.
    expect(span.attributes["gen_ai.provider.name"] ?? span.attributes["gen_ai.system"]).toBeTruthy();
    // The 3 content attrs are OMITTED.
    expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(span.attributes["gen_ai.output.messages"]).toBeUndefined();
    expect(span.attributes["gen_ai.system_instructions"]).toBeUndefined();
    // And no message body leaks into ANY attribute.
    const json = JSON.stringify(span.attributes);
    expect(json).not.toContain("SECRET-PROMPT-BODY");
    expect(json).not.toContain("SECRET-COMPLETION-BODY");
    expect(json).not.toContain("SECRET-SYSTEM-PROMPT");
  });

  it("with genaiSemconv:true AND captureContent:true, content is re-redacted — no body in any attribute", () => {
    fx = makeSpanFixture();
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
      inputMessages: [{ role: "user", content: "sk-PLANTEDSECRET", password: "PLANTED2" }],
      systemInstructions: "api_key=PLANTED3",
    });

    const span = fx.exporter.getFinishedSpans()[0]!;
    const json = JSON.stringify(span.attributes);
    for (const leak of ["sk-PLANTEDSECRET", "PLANTED2", "PLANTED3"]) {
      expect(json, `planted secret '${leak}' must be re-redacted even with content capture on`).not.toContain(leak);
    }
  });
});
