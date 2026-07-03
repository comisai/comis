// SPDX-License-Identifier: Apache-2.0
/**
 * Source-grep regression tests for silent-failure-handlers.ts.
 *
 * Why source-grep: building runner-level behavioral test infrastructure
 * (mocking AgentSession, PromptRunnerBridge, runWithModelRetry, the full
 * deps surface) is significant scope; this file pins structural invariants
 * for the rate_limited short-circuit branch and the pre-existing
 * client_request branch. Behavioral tests should be added alongside any
 * future refactor that introduces the required mocking infrastructure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "silent-failure-handlers.ts");
const source = readFileSync(sourcePath, "utf-8");

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

  // Pin the existing client_request branch wording so a future refactor that
  // inadvertently edits it while doing rate_limited work would be caught.
  it("client_request branch wording remains untouched (byte-identical pin)", () => {
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
