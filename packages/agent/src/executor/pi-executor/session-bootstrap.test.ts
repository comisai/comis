// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for bootstrapSession + decodeExecutionOverrides — pre-lock
 * setup helpers.
 *
 * Closure-extracted helpers (state-first): tests cover
 * (a) bootstrap result shape (ExecutionResult init + sep flag + plan ref),
 * (b) override decode writes to MutableRefs not via closure capture.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { SessionKey, PerAgentConfig } from "@comis/core";
import type { CacheRetention } from "@earendil-works/pi-ai";

import {
  bootstrapSession,
  decodeExecutionOverrides,
  type MutableRef,
} from "./session-bootstrap.js";
import type { PiExecutorDeps } from "./pi-executor.js";
import type { AdaptiveCacheRetention } from "../adaptive-cache-retention.js";
import type { ExecutionOverrides } from "../types.js";
import type { ExecutionPlan } from "../../planner/types.js";
import type { ExecutionPlanHolder } from "./execution-plan-holder.js";

/** Fake holder capturing the published ref so the test can assert identity. */
function makeFakeHolder(): ExecutionPlanHolder & {
  published: Array<{ current: ExecutionPlan | undefined }>;
} {
  const published: Array<{ current: ExecutionPlan | undefined }> = [];
  let active: { current: ExecutionPlan | undefined } | undefined;
  return {
    published,
    getCurrentPlan: () => active?.current,
    publish: (ref) => {
      active = ref;
      published.push(ref);
    },
    clear: () => {
      active = undefined;
    },
  };
}

function makeNoopLogger() {
  const logger: { [k: string]: unknown } = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, trace: () => {},
  };
  logger.child = () => logger;
  return logger;
}

function makeRef<T>(initial: T): MutableRef<T> & { history: T[] } {
  let val = initial;
  const history: T[] = [];
  return {
    get: () => val,
    set: (v: T) => {
      val = v;
      history.push(v);
    },
    history,
  };
}

const sessionKey = { tenantId: "t", channelId: "c", userId: "u" } as SessionKey;
const baseConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4",
  cacheRetention: "long",
  promptTimeout: { promptTimeoutMs: 60_000, retryPromptTimeoutMs: 30_000 },
  sep: { enabled: true },
} as unknown as PerAgentConfig;

describe("bootstrapSession", () => {
  it("returns initialized ExecutionResult + sep flag + executionPlanRef", async () => {
    const resolveProviderApiKey = vi.fn().mockResolvedValue("api-key");
    const deps = {
      logger: makeNoopLogger(),
      clock: { now: () => 1234, nowDate: () => new Date(1234) },
      authStorage: { getApiKey: resolveProviderApiKey, getModelOverride: () => undefined } as unknown as PiExecutorDeps["authStorage"],
    } as unknown as PiExecutorDeps;

    const result = await bootstrapSession({}, deps, { config: baseConfig, sessionKey, overrides: undefined });

    expect(result.executionStartMs).toBe(1234);
    expect(result.result.response).toBe("");
    expect(result.result.tokensUsed).toEqual({ input: 0, output: 0, total: 0 });
    expect(result.result.finishReason).toBe("stop");
    expect(result.sepEnabled).toBe(true);
    expect(result.executionPlanRef).toEqual({ current: undefined });
  });

  it("respects sep.enabled=false via override.skipSep=true", async () => {
    const deps = {
      logger: makeNoopLogger(),
      clock: { now: () => 0, nowDate: () => new Date(0) },
      authStorage: { getApiKey: () => "k", getModelOverride: () => undefined } as unknown as PiExecutorDeps["authStorage"],
    } as unknown as PiExecutorDeps;
    const overrides = { skipSep: true } as ExecutionOverrides;

    const result = await bootstrapSession({}, deps, { config: baseConfig, sessionKey, overrides });

    expect(result.sepEnabled).toBe(false);
  });

  it("publishes the per-turn executionPlanRef into the holder when SEP is enabled", async () => {
    const deps = {
      logger: makeNoopLogger(),
      clock: { now: () => 1, nowDate: () => new Date(1) },
      authStorage: { getApiKey: () => "k", getModelOverride: () => undefined } as unknown as PiExecutorDeps["authStorage"],
    } as unknown as PiExecutorDeps;
    const holder = makeFakeHolder();

    const result = await bootstrapSession({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides: undefined,
      executionPlanHolder: holder,
    });

    // The SAME ref object is published (live read, not a copy), and it is the
    // ref the bootstrap returns — so holder.getCurrentPlan() tracks this turn.
    expect(holder.published).toHaveLength(1);
    expect(holder.published[0]).toBe(result.executionPlanRef);
    expect(holder.getCurrentPlan()).toBeUndefined(); // ref.current starts undefined
  });

  it("does NOT publish into the holder when SEP is disabled (skipSep)", async () => {
    const deps = {
      logger: makeNoopLogger(),
      clock: { now: () => 1, nowDate: () => new Date(1) },
      authStorage: { getApiKey: () => "k", getModelOverride: () => undefined } as unknown as PiExecutorDeps["authStorage"],
    } as unknown as PiExecutorDeps;
    const holder = makeFakeHolder();
    const overrides = { skipSep: true } as ExecutionOverrides;

    await bootstrapSession({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides,
      executionPlanHolder: holder,
    });

    expect(holder.published).toHaveLength(0);
  });

  it("clears the holder on a SEP-off turn so a prior SEP-on turn's plan does not leak", async () => {
    // Stale-plan leak: a SEP-on turn publishes ref A into the holder
    // (and SEP populates it). A LATER SEP-off turn on the SAME holder must
    // de-publish — otherwise getCurrentPlan() still projects turn A's plan
    // during the SEP-off turn. Pre-fix bootstrapSession only guards publish()
    // and never clears, so the SEP-off branch is inert and ref A stays live.
    const deps = {
      logger: makeNoopLogger(),
      clock: { now: () => 1, nowDate: () => new Date(1) },
      authStorage: { getApiKey: () => "k", getModelOverride: () => undefined } as unknown as PiExecutorDeps["authStorage"],
    } as unknown as PiExecutorDeps;
    const holder = makeFakeHolder();

    // Turn N: SEP enabled — publish ref A and let SEP populate it live.
    const turnN = await bootstrapSession({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides: undefined,
      executionPlanHolder: holder,
    });
    turnN.executionPlanRef.current = {
      active: true,
      request: "turn N plan",
      completedCount: 0,
      createdAtMs: 1,
      steps: [{ index: 1, description: "step", status: "in_progress" }],
    };
    expect(holder.getCurrentPlan()?.request).toBe("turn N plan");

    // Turn N+1: SEP disabled (skipSep) on the SAME holder.
    await bootstrapSession({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides: { skipSep: true } as ExecutionOverrides,
      executionPlanHolder: holder,
    });

    // The SEP-off turn must have de-published turn N's ref — no stale leak.
    expect(holder.getCurrentPlan()).toBeUndefined();
  });

  it("holder reflects SEP mutations on the returned ref after publish", async () => {
    const deps = {
      logger: makeNoopLogger(),
      clock: { now: () => 1, nowDate: () => new Date(1) },
      authStorage: { getApiKey: () => "k", getModelOverride: () => undefined } as unknown as PiExecutorDeps["authStorage"],
    } as unknown as PiExecutorDeps;
    const holder = makeFakeHolder();

    const result = await bootstrapSession({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides: undefined,
      executionPlanHolder: holder,
    });

    // SEP later populates the live ref this turn.
    result.executionPlanRef.current = {
      active: true,
      request: "r",
      completedCount: 0,
      createdAtMs: 1,
      steps: [{ index: 1, description: "s", status: "in_progress" }],
    };
    expect(holder.getCurrentPlan()?.steps[0].status).toBe("in_progress");
  });
});

describe("decodeExecutionOverrides", () => {
  it("writes cacheRetention to the MutableRef from overrides", () => {
    const cacheRetentionRef = makeRef<CacheRetention | undefined>(undefined);
    const adaptiveRetentionRef = makeRef<AdaptiveCacheRetention | undefined>(undefined);
    const minTokensOverrideRef = makeRef<number | undefined>(undefined);
    const deps = {
      logger: makeNoopLogger(),
      clock: { now: () => 0, nowDate: () => new Date(0) },
    } as unknown as PiExecutorDeps;
    const overrides = { cacheRetention: "short" } as ExecutionOverrides;

    const out = decodeExecutionOverrides({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides,
      operationDefaults: {},
      cacheRetentionRef,
      adaptiveRetentionRef,
      minTokensOverrideRef,
    });

    expect(cacheRetentionRef.get()).toBe("short");
    expect(adaptiveRetentionRef.get()).toBeDefined();
    expect(out.effectiveTimeout.promptTimeoutMs).toBe(60_000);
    expect(out.effectiveTimeout.retryPromptTimeoutMs).toBe(30_000);
  });

  it("writes minTokensOverride=512 for sub-agent (spawnPacket present)", () => {
    const cacheRetentionRef = makeRef<CacheRetention | undefined>(undefined);
    const adaptiveRetentionRef = makeRef<AdaptiveCacheRetention | undefined>(undefined);
    const minTokensOverrideRef = makeRef<number | undefined>(undefined);
    const deps = { logger: makeNoopLogger(), clock: { now: () => 0, nowDate: () => new Date(0) } } as unknown as PiExecutorDeps;
    const overrides = { spawnPacket: {} } as unknown as ExecutionOverrides;

    decodeExecutionOverrides({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides,
      operationDefaults: {},
      cacheRetentionRef,
      adaptiveRetentionRef,
      minTokensOverrideRef,
    });

    expect(minTokensOverrideRef.get()).toBe(512);
  });

  it("writes minTokensOverride=1024 for parent agent (no spawnPacket)", () => {
    const cacheRetentionRef = makeRef<CacheRetention | undefined>(undefined);
    const adaptiveRetentionRef = makeRef<AdaptiveCacheRetention | undefined>(undefined);
    const minTokensOverrideRef = makeRef<number | undefined>(undefined);
    const deps = { logger: makeNoopLogger(), clock: { now: () => 0, nowDate: () => new Date(0) } } as unknown as PiExecutorDeps;

    decodeExecutionOverrides({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides: undefined,
      operationDefaults: {},
      cacheRetentionRef,
      adaptiveRetentionRef,
      minTokensOverrideRef,
    });

    expect(minTokensOverrideRef.get()).toBe(1024);
  });

  it("explicit override.promptTimeout wins over operation defaults and agent config", () => {
    const cacheRetentionRef = makeRef<CacheRetention | undefined>(undefined);
    const adaptiveRetentionRef = makeRef<AdaptiveCacheRetention | undefined>(undefined);
    const minTokensOverrideRef = makeRef<number | undefined>(undefined);
    const deps = { logger: makeNoopLogger(), clock: { now: () => 0, nowDate: () => new Date(0) } } as unknown as PiExecutorDeps;
    const overrides = {
      promptTimeout: { promptTimeoutMs: 5_000, retryPromptTimeoutMs: 2_000 },
    } as ExecutionOverrides;

    const out = decodeExecutionOverrides({}, deps, {
      config: baseConfig,
      sessionKey,
      overrides,
      operationDefaults: { default: 10_000 },
      cacheRetentionRef,
      adaptiveRetentionRef,
      minTokensOverrideRef,
    });

    expect(out.effectiveTimeout.promptTimeoutMs).toBe(5_000);
    expect(out.effectiveTimeout.retryPromptTimeoutMs).toBe(2_000);
  });

  // -------------------------------------------------------------------------
  // LAT-01: effectiveTimeout binding provenance. The decode computes the FINAL
  // binding: a present override CARRIES the source its producer labeled (the
  // cron producer materializes promptTimeout unconditionally — re-deriving
  // here would call every cron timeout "explicit"; 177-RESEARCH Critical
  // Finding 1 / Pitfall 4); the operation default and agent config label
  // themselves where they bind.
  // -------------------------------------------------------------------------
  describe("LAT-01 effectiveTimeout binding provenance (source + operationType)", () => {
    function decodeWith(
      overrides: ExecutionOverrides | undefined,
      operationDefaults: Record<string, number | undefined> = {},
    ) {
      const cacheRetentionRef = makeRef<CacheRetention | undefined>(undefined);
      const adaptiveRetentionRef = makeRef<AdaptiveCacheRetention | undefined>(undefined);
      const minTokensOverrideRef = makeRef<number | undefined>(undefined);
      const deps = {
        logger: makeNoopLogger(),
        clock: { now: () => 0, nowDate: () => new Date(0) },
      } as unknown as PiExecutorDeps;
      return decodeExecutionOverrides({}, deps, {
        config: baseConfig,
        sessionKey,
        overrides,
        operationDefaults,
        cacheRetentionRef,
        adaptiveRetentionRef,
        minTokensOverrideRef,
      });
    }

    it("LAT-01-10: a producer-labeled cron override CARRIES source operation_default — never relabeled operation_explicit just because the override object exists (the collapse pin)", () => {
      const overrides = {
        operationType: "cron",
        promptTimeout: { promptTimeoutMs: 150_000, source: "operation_default" },
      } as ExecutionOverrides;

      const out = decodeWith(overrides, { cron: 150_000 });

      expect(out.effectiveTimeout.promptTimeoutMs).toBe(150_000);
      expect(out.effectiveTimeout.source).toBe("operation_default");
      expect(out.effectiveTimeout.operationType).toBe("cron");
    });

    it("LAT-01-11: an override present WITHOUT a source label (legacy producer shape) is conservatively operation_explicit — explicit by the caller", () => {
      const overrides = {
        promptTimeout: { promptTimeoutMs: 5_000 },
      } as ExecutionOverrides;

      const out = decodeWith(overrides);

      expect(out.effectiveTimeout.promptTimeoutMs).toBe(5_000);
      expect(out.effectiveTimeout.source).toBe("operation_explicit");
    });

    it("LAT-01-12: no override + operationType cron — the operation default binds and source says operation_default", () => {
      const overrides = { operationType: "cron" } as ExecutionOverrides;

      const out = decodeWith(overrides, { cron: 150_000 });

      expect(out.effectiveTimeout.promptTimeoutMs).toBe(150_000);
      expect(out.effectiveTimeout.source).toBe("operation_default");
      expect(out.effectiveTimeout.operationType).toBe("cron");
    });

    it("LAT-01-13: no override + no operationType — the agent config binds with source agent_config and operationType undefined", () => {
      const out = decodeWith(undefined);

      expect(out.effectiveTimeout.promptTimeoutMs).toBe(60_000);
      expect(out.effectiveTimeout.source).toBe("agent_config");
      expect(out.effectiveTimeout.operationType).toBeUndefined();
    });
  });
});
