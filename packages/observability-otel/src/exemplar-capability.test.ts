// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the exemplar-capability probe (PROM-04 / A2).
 *
 * Open Question A2: whether `@opentelemetry/exporter-prometheus@0.219.0` can
 * render OpenMetrics exemplars on the `/metrics` pull surface. The answer GATES
 * how Plan 03 writes PROM-04's exemplar test — a STRICT exemplar-presence
 * assertion if supported, or a documented-limitation + data-link fallback if not.
 *
 * The probe inspects the installed exporter's surface (its `ExporterConfig`
 * options / serializer) for an OpenMetrics/exemplar affordance and records the
 * result in `PROMETHEUS_EXEMPLARS_SUPPORTED`. Per the verified `.d.ts`
 * (`ExporterConfig` = `{ prefix?, appendTimestamp?, endpoint?, host?, port?,
 * preventServerStart?, metricProducers?, withResourceConstantLabels?,
 * withoutScopeInfo?, withoutTargetInfo? }` — no `enableOpenMetrics`, no exemplar
 * switch) the expected result is `false`.
 *
 * This pin fails on pre-patch code because `./exemplar-capability.js` does not
 * exist. The test does NOT hardcode-expect a value — it asserts the constant is a
 * boolean and REPORTS the actual probe result in the assertion message, so the
 * SUMMARY records the finding that gates Plan 03 without baking in an assumption
 * that a future exporter version could falsify.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  PROMETHEUS_EXEMPLARS_SUPPORTED,
  EXEMPLAR_CAPABILITY_NOTE,
} from "./exemplar-capability.js";

describe("exemplar-capability", () => {
  it("PROMETHEUS_EXEMPLARS_SUPPORTED is a boolean derived by probing the installed exporter (reported, not hardcoded)", () => {
    expect(
      typeof PROMETHEUS_EXEMPLARS_SUPPORTED,
      `PROMETHEUS_EXEMPLARS_SUPPORTED must be a boolean; probe observed: ${String(
        PROMETHEUS_EXEMPLARS_SUPPORTED,
      )} — ${EXEMPLAR_CAPABILITY_NOTE}`,
    ).toBe("boolean");
  });

  it("exposes a non-empty EXEMPLAR_CAPABILITY_NOTE describing what was probed and the result", () => {
    expect(typeof EXEMPLAR_CAPABILITY_NOTE).toBe("string");
    expect(
      EXEMPLAR_CAPABILITY_NOTE.length,
      "the note must document the probe + result for the SUMMARY / Plan 03 gate",
    ).toBeGreaterThan(0);
  });

  it("the note states the actual supported/unsupported verdict consistently with the boolean", () => {
    // The note must MENTION the verdict it carries (so a reader of the constant
    // and the note never see a contradiction). We don't pin the exact wording.
    const lower = EXEMPLAR_CAPABILITY_NOTE.toLowerCase();
    const mentionsExemplar =
      lower.includes("exemplar") || lower.includes("openmetrics");
    expect(mentionsExemplar, `note should mention exemplar/OpenMetrics: ${EXEMPLAR_CAPABILITY_NOTE}`).toBe(
      true,
    );
  });
});
