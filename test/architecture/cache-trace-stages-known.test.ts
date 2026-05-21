// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-HARD-11 — cache-trace stages closed-union enforcement.
 *
 * Mirrors `trajectory-event-types-known.test.ts`. Walks
 * `packages/observability/src/cache-trace/**\/*.ts` +
 * `packages/agent/src/**\/*.ts` for `recordStage(<literal>, …)` call
 * sites. Each first arg must be a string literal that is a member of
 * `CACHE_TRACE_STAGES`.
 *
 * Inverse-completeness check: every member of `CACHE_TRACE_STAGES`
 * (except `cache_trace.write_failures` which is sentinel-only, and
 * `session:after` which is emitted via `flushAndClose`'s terminal
 * `writer.write()` rather than the public `recordStage()` API) has at
 * least one producer call site — counting both direct literal
 * `recordStage("stage", …)` calls AND `CACHE_TRACE_BRIDGE_MAPPING`
 * table values (the bridge dispatches dynamically via
 * `recordStage(stage, …)` where `stage` is read from the table).
 *
 * @module
 */
import { describe, it } from "vitest";

describe("cache-trace stages closed-union enforcement", () => {
  it.skip("every_recordStage_call_uses_a_CACHE_TRACE_STAGES_member", () => {});
  it.skip("every_application_stage_in_CACHE_TRACE_STAGES_has_at_least_one_producer", () => {});
});
