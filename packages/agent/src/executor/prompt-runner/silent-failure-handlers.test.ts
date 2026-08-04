// SPDX-License-Identifier: Apache-2.0
/**
 * Source-level contract tests for silent-failure-handlers.ts.
 *
 * Why source-grep: building runner-level behavioral test infrastructure
 * (mocking AgentSession, PromptRunnerBridge, runWithModelRetry, the full
 * deps surface) is significant scope; this file pins structural invariants
 * for the rate_limited short-circuit branch and the client_request branch.
 * Behavioral tests belong here once the module exposes a smaller dependency
 * seam.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  handleClientRequest,
  handleRateLimited,
  handleSignedReplay,
  type BridgeSnapshot,
  type RetryState,
} from "./silent-failure-handlers.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "silent-failure-handlers.ts");
const source = readFileSync(sourcePath, "utf-8");

function makePrivacyParams(warn: ReturnType<typeof vi.fn>): RunPromptParams {
  return {
    deps: { logger: { warn } },
  } as unknown as RunPromptParams;
}

function makeRetryState(): RetryState {
  return { promptSucceeded: true, promptError: undefined };
}

describe("silent-failure provider diagnostics", () => {
  it.each([
    ["rate limited", handleRateLimited],
    ["client request", handleClientRequest],
  ])("does not log the raw provider body for %s failures", (_name, handler) => {
    const warn = vi.fn();
    const providerBody = "Authorization: Bearer PRIVATE_SILENT_PROVIDER_SENTINEL";

    handler(
      makePrivacyParams(warn),
      { llmCalls: 1, finishReason: "error", lastLlmErrorMessage: providerBody },
      makeRetryState(),
    );

    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "PRIVATE_SILENT_PROVIDER_SENTINEL",
    );
  });
});

describe("handleSignedReplay — no-op scrub short-circuit", () => {
  /**
   * Build a params surface whose session carries NO signed thinking state, so
   * `scrubSignedReplayStateInPlace` reports 0 blocks / 0 signatures.
   */
  function makeParams(messages: unknown[]) {
    const warn = vi.fn();
    const info = vi.fn();
    const params = {
      session: { messages, getLastAssistantText: () => "" },
      sessionKey: { tenantId: "default", agentId: "default", channel: "telegram", peer: "p" },
      agentId: "default",
      bridge: { getResult: () => ({ llmCalls: 1, textEmitted: false, finishReason: "stop" }) },
      deps: {
        logger: { warn, info, debug: vi.fn(), error: vi.fn() },
        timers: { setTimeout: (fn: () => void) => setTimeout(fn, 0) },
        clock: { now: () => new Date("2026-01-01T00:00:00Z") },
        eventBus: { emit: vi.fn() },
      },
    } as unknown as RunPromptParams;
    return { params, warn, info };
  }

  const snapshot = (providerError: string): BridgeSnapshot =>
    ({ llmCalls: 1, finishReason: "stop", lastLlmErrorMessage: providerError }) as BridgeSnapshot;

  // The self-heal exists to remove stale signed state. When it removed
  // nothing, the retry replays a byte-identical request and is guaranteed to
  // reproduce the same provider error — observed in production as a third
  // wasted LLM call on a deterministic capability rejection.
  it("does NOT re-enter the retry pipeline when nothing was scrubbed", async () => {
    const { params } = makeParams([]);
    const invokeRetry = vi.fn(async () => ({ succeeded: true, error: undefined }));
    const retryState: RetryState = { promptSucceeded: true, promptError: undefined };

    await handleSignedReplay(
      params,
      "hello",
      undefined,
      snapshot('400 invalid_request_error: "thinking.type.enabled" is not supported'),
      retryState,
      invokeRetry as never,
    );

    expect(invokeRetry).not.toHaveBeenCalled();
  });

  it("declares terminal failure when nothing was scrubbed", async () => {
    const { params } = makeParams([]);
    const invokeRetry = vi.fn(async () => ({ succeeded: true, error: undefined }));
    const retryState: RetryState = { promptSucceeded: true, promptError: undefined };

    await handleSignedReplay(
      params,
      "hello",
      undefined,
      snapshot("400 invalid_request_error: some provider detail"),
      retryState,
      invokeRetry as never,
    );

    expect(retryState.promptSucceeded).toBe(false);
    expect(retryState.promptError).toBeInstanceOf(Error);
  });

  it("does not leak the raw provider body into the short-circuit WARN", async () => {
    const { params, warn } = makeParams([]);
    const retryState: RetryState = { promptSucceeded: true, promptError: undefined };

    await handleSignedReplay(
      params,
      "hello",
      undefined,
      snapshot("Authorization: Bearer PRIVATE_REPLAY_SENTINEL"),
      retryState,
      vi.fn(async () => ({ succeeded: true, error: undefined })) as never,
    );

    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_REPLAY_SENTINEL");
  });

  it("still retries when signed state WAS scrubbed", async () => {
    // One signed thinking block → scrubber reports a non-zero removal, so the
    // self-heal must proceed exactly as before.
    const { params } = makeParams([
      { role: "assistant", content: [{ type: "thinking", thinking: "x", thinkingSignature: "sig" }] },
    ]);
    const invokeRetry = vi.fn(async () => ({ succeeded: true, error: undefined }));
    const retryState: RetryState = { promptSucceeded: true, promptError: undefined };

    await handleSignedReplay(
      params,
      "hello",
      undefined,
      snapshot("400 thinking blocks cannot be modified"),
      retryState,
      invokeRetry as never,
    );

    expect(invokeRetry).toHaveBeenCalledTimes(1);
  });
});

describe("silent-failure-handlers.ts — rate_limited branch", () => {
  it("exports a `handleRateLimited` function", () => {
    expect(source).toMatch(/export function handleRateLimited/);
  });

  it("rate_limited handler appears before the client_request handler in the source", () => {
    const rateIdx = source.indexOf("export function handleRateLimited");
    const clientIdx = source.indexOf("export function handleClientRequest");
    expect(rateIdx).toBeGreaterThanOrEqual(0);
    expect(clientIdx).toBeGreaterThanOrEqual(0);
    expect(rateIdx).toBeLessThan(clientIdx);
  });

  it("rate_limited handler sets retryState.promptSucceeded = false (closes the retry path)", () => {
    // Extract the rate_limited handler body (between the function start and the next `export function`)
    const startIdx = source.indexOf("export function handleRateLimited");
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.indexOf("\nexport function ", 1);
    expect(branchEnd).toBeGreaterThan(0);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).toMatch(/retryState\.promptSucceeded = false/);
  });

  it("rate_limited handler builds a `Rate limit exceeded:` error message including provider detail", () => {
    const startIdx = source.indexOf("export function handleRateLimited");
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.indexOf("\nexport function ", 1);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).toMatch(/Rate limit exceeded:/);
    expect(branchBody).toMatch(/llmDetail/); // verifies the message embeds the provider error
  });

  it("rate_limited handler does NOT call runWithModelRetry (would re-amplify)", () => {
    const startIdx = source.indexOf("export function handleRateLimited");
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.indexOf("\nexport function ", 1);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).not.toMatch(/runWithModelRetry\s*\(/);
    expect(branchBody).not.toMatch(/invokeRetry\s*\(/);
  });

  it("rate_limited handler logs a structured WARN naming the rate-limit cause", () => {
    const startIdx = source.indexOf("export function handleRateLimited");
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.indexOf("\nexport function ", 1);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).toMatch(/deps\.logger\.warn/);
    expect(branchBody).toMatch(/Rate-limit error/);
  });

  // Pin the client_request branch wording so classification stays generic and
  // does not expose provider bodies.
  it("keeps the client_request branch user-facing wording generic", () => {
    expect(source).toMatch(/Anthropic returned a client-side validation error/);
    expect(source).toMatch(/Client request rejected by provider:/);
    expect(source).toMatch(/Client-request error — skipping silent-retry and declaring terminal failure/);
  });
});

describe("silent-failure-handlers.ts — tool_schema_unsupported facade re-export", () => {
  // Dynamic imports so a missing re-export fails these tests INDIVIDUALLY
  // without crashing the structural suites in this file. The handler
  // body lives in tool-schema-unsupported-handler.ts (the prompt-runner
  // directory has a 500-line file cap) and is re-exported here so the
  // dispatch in retry-loop.ts imports the whole silent-failure cascade from
  // one module. Behavioral coverage: tool-schema-unsupported-handler.test.ts.

  it("re-exports handleToolSchemaUnsupported and resetToolSchemaStripGateForTest for the retry-loop dispatch", async () => {
    const facade = (await import("./silent-failure-handlers.js")) as Record<string, unknown>;
    expect(typeof facade.handleToolSchemaUnsupported).toBe("function");
    expect(typeof facade.resetToolSchemaStripGateForTest).toBe("function");
  });

  it("facade and handler module expose the SAME handleToolSchemaUnsupported function identity (no divergent copies)", async () => {
    const facade = (await import("./silent-failure-handlers.js")) as Record<string, unknown>;
    const handlerModule = (await import("./tool-schema-unsupported-handler.js")) as Record<string, unknown>;
    expect(facade.handleToolSchemaUnsupported).toBe(handlerModule.handleToolSchemaUnsupported);
  });
});
