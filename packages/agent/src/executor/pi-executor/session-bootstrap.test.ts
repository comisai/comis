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
});
