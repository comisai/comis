// SPDX-License-Identifier: Apache-2.0
/**
 * Source-grep regression tests for executor-prompt-runner.ts.
 *
 * Why source-grep: building runner-level behavioral test infrastructure
 * (mocking AgentSession, PromptRunnerBridge, runWithModelRetry, the full
 * deps surface) is significant scope; this file pins structural invariants
 * for the rate_limited short-circuit branch added by 260501-cur and the
 * pre-existing client_request branch added by 260420-fqw. Behavioral tests
 * should be added alongside any future refactor that introduces the
 * required mocking infrastructure.
 *
 * Precedent: packages/skills/src/builtin/platform/agents-manage-tool.test.ts
 * (260428-rrr / 260501-1zs / 260501-2pz) — same readFileSync + import.meta.url
 * pattern.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "executor-prompt-runner.ts");
const source = readFileSync(sourcePath, "utf-8");

describe("executor-prompt-runner.ts — rate_limited branch (260501-cur)", () => {
  it("contains an `else if (earlyClassification.category === \"rate_limited\")` branch", () => {
    expect(source).toMatch(/else if \(earlyClassification\.category === "rate_limited"\)/);
  });

  it("rate_limited branch precedes the existing client_request branch", () => {
    const rateIdx = source.indexOf('earlyClassification.category === "rate_limited"');
    const clientIdx = source.indexOf('earlyClassification.category === "client_request"');
    expect(rateIdx).toBeGreaterThanOrEqual(0);
    expect(clientIdx).toBeGreaterThanOrEqual(0);
    expect(rateIdx).toBeLessThan(clientIdx);
  });

  it("rate_limited branch sets silentRetryAttempted to true (closes the retry gate)", () => {
    // Extract the rate_limited branch body (between the branch start and the next `} else if` or `} else {`)
    const startIdx = source.indexOf('earlyClassification.category === "rate_limited"');
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.search(/\}\s*else\s*(if\s*\(|\{)/);
    expect(branchEnd).toBeGreaterThan(0);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).toMatch(/silentRetryAttempted = true/);
  });

  it("rate_limited branch builds a `Rate limit exceeded:` error message including provider detail", () => {
    const startIdx = source.indexOf('earlyClassification.category === "rate_limited"');
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.search(/\}\s*else\s*(if\s*\(|\{)/);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).toMatch(/Rate limit exceeded:/);
    expect(branchBody).toMatch(/llmDetail/); // verifies the message embeds the provider error
  });

  it("rate_limited branch does NOT call runWithModelRetry (would re-amplify)", () => {
    const startIdx = source.indexOf('earlyClassification.category === "rate_limited"');
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.search(/\}\s*else\s*(if\s*\(|\{)/);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).not.toMatch(/runWithModelRetry\s*\(/);
  });

  it("rate_limited branch logs a structured WARN naming the rate-limit cause", () => {
    const startIdx = source.indexOf('earlyClassification.category === "rate_limited"');
    const afterStart = source.slice(startIdx);
    const branchEnd = afterStart.search(/\}\s*else\s*(if\s*\(|\{)/);
    const branchBody = afterStart.slice(0, branchEnd);
    expect(branchBody).toMatch(/deps\.logger\.warn/);
    expect(branchBody).toMatch(/Rate-limit error/);
  });

  // Plan-checker fix #2 (MINOR): pin the existing client_request branch wording so a future
  // refactor that inadvertently edits it while doing rate_limited work would be caught.
  // Truth #7 ("client_request branch byte-identical") becomes enforceable.
  it("client_request branch wording remains untouched (byte-identical pin from 260420-fqw)", () => {
    expect(source).toMatch(/Anthropic returned a client-side validation error/);
    expect(source).toMatch(/Client request rejected by provider:/);
    expect(source).toMatch(/Client-request error — skipping silent-retry and declaring terminal failure/);
  });
});

describe("executor-prompt-runner.ts — capability-index threading (Phase 20 CAPINDEX-RENDER-03 + -18)", () => {
  it("CAPINDEX-RENDER-03: dynamic preamble uses array-concat [dynamicPreamble, capabilityIndexContext, deferredContext].filter(Boolean)", () => {
    // Source-grep: structural lock on the design §5 array-concat shape.
    // Behavioral verification of the rendered output lives in the renderer
    // unit test (capability-index-context.test.ts) and Phase 24 integration tests.
    expect(source).toMatch(
      /\[\s*dynamicPreamble\s*,\s*capabilityIndexContext\s*,\s*deferredContext\s*\]\s*\.\s*filter\s*\(\s*Boolean\s*\)/,
    );
  });

  it("CAPINDEX-RENDER-18 / OBS-CAP-01: Pino debug log emits the seven canonical fields with submodule label and message", () => {
    // Each canonical field appears literally in the log object.
    expect(source).toMatch(/capabilityIndexTokens/);
    expect(source).toMatch(/deferredContextTokens/);
    expect(source).toMatch(/fullPreambleTokens/);
    expect(source).toMatch(/clusterCount/);
    expect(source).toMatch(/activeToolCount/);
    expect(source).toMatch(/deferredToolCount/);
    expect(source).toMatch(/promptSkillCount/);
    // Message text matches design §5 Placement verbatim.
    expect(source).toMatch(/"Dynamic preamble assembled"/);
  });

  it("CAPINDEX-RENDER-18: submodule binding label is exactly 'executor.capability-index'", () => {
    // AGENTS.md §2.7: submodule binding via deps.logger.child({ submodule: "..." }).
    expect(source).toMatch(/submodule\s*:\s*["']executor\.capability-index["']/);
  });
});
