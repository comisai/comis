// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { wrapExternalContent } from "@comis/core";
import { createToolRetryBreaker, extractErrorTag, buildBlockReason } from "./tool-retry-breaker.js";
import type { ToolRetryBreaker } from "./tool-retry-breaker.js";

describe("tool retry breaker", () => {
  const defaultConfig = {
    maxConsecutiveFailures: 3,
    maxToolFailures: 5,
    suggestAlternatives: true,
    // High value so existing signature/tool-level tests aren't affected by error-pattern blocking
    maxConsecutiveErrorPatterns: 100,
    // Operator-supplied alternatives map. The production
    // ToolRetryBreakerConfig.toolAlternatives defaults to {} — no hardcoded
    // server names. Tests populate this fixture to simulate an operator who
    // has configured yfinance alternatives, so existing alternative-suggestion
    // assertions in this file (lines 103-118 etc.) continue to verify
    // behavior at the breaker level.
    toolAlternatives: {
      "mcp__yfinance": ["web_search", "mcp__tavily--tavily-search", "web_fetch"],
    },
  };

  function createBreaker(): ToolRetryBreaker {
    return createToolRetryBreaker(defaultConfig);
  }

  describe("beforeToolCall", () => {
    it("allows first call to any tool", () => {
      const breaker = createBreaker();
      const verdict = breaker.beforeToolCall("mcp__yfinance--get_recs", { symbol: "NVDA" });
      expect(verdict.block).toBe(false);
    });

    it("allows calls after successful results", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, true);

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(false);
    });

    it("blocks after 3 consecutive failures with same signature", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("mcp__yfinance--get_recs");
    });

    it("resets counter on success between failures", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      // 2 failures
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      // 1 success resets consecutive counter
      breaker.recordResult(tool, args, true);
      // 2 more failures -- consecutive count is 2, not 4
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(false);
    });

    it("blocks entire tool after 5 total failures regardless of args", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";

      // 5 failures with different args each time
      breaker.recordResult(tool, { symbol: "NVDA" }, false, "error");
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");
      breaker.recordResult(tool, { symbol: "GOOG" }, false, "error");
      breaker.recordResult(tool, { symbol: "MSFT" }, false, "error");
      breaker.recordResult(tool, { symbol: "TSLA" }, false, "error");

      // New args never seen before -- still blocked because tool-level threshold hit
      const verdict = breaker.beforeToolCall(tool, { symbol: "AMZN" });
      expect(verdict.block).toBe(true);
    });

    it("includes tool name and error pattern in block reason", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("mcp__yfinance--get_recs");
      expect(verdict.reason).toContain("failed");
      expect(verdict.reason).toContain("connection timeout");
    });

    it("suggests alternative tools when available", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("web_search");
      expect(verdict.reason).toContain("mcp__tavily--tavily-search");
      expect(verdict.alternatives).toContain("web_search");
      expect(verdict.alternatives).toContain("mcp__tavily--tavily-search");
    });

    it("no alternatives for unknown tools", () => {
      const breaker = createBreaker();
      const tool = "some_random_tool";
      const args = { x: 1 };

      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("alternative approaches");
      expect(verdict.alternatives).toEqual([]);
    });
  });

  describe("fingerprinting", () => {
    it("treats same args in different order as identical", () => {
      const breaker = createBreaker();
      const tool = "some_tool";

      // Record failures with {a:1, b:2}
      breaker.recordResult(tool, { a: 1, b: 2 }, false, "error");
      breaker.recordResult(tool, { a: 1, b: 2 }, false, "error");
      // Record one more failure with {b:2, a:1} -- same fingerprint, should be 3rd consecutive
      breaker.recordResult(tool, { b: 2, a: 1 }, false, "error");

      const verdict = breaker.beforeToolCall(tool, { a: 1, b: 2 });
      expect(verdict.block).toBe(true);
    });

    it("treats different args as different signatures", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";

      // 2 failures for NVDA
      breaker.recordResult(tool, { symbol: "NVDA" }, false, "error");
      breaker.recordResult(tool, { symbol: "NVDA" }, false, "error");
      // 2 failures for AAPL
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");

      // Neither should be blocked yet (only 2 consecutive each)
      expect(breaker.beforeToolCall(tool, { symbol: "NVDA" }).block).toBe(false);
      expect(breaker.beforeToolCall(tool, { symbol: "AAPL" }).block).toBe(false);
    });
  });

  describe("error-pattern tracking", () => {
    const errorPatternConfig = {
      maxConsecutiveFailures: 3,
      maxToolFailures: 5,
      maxConsecutiveErrorPatterns: 2,
      suggestAlternatives: true,
    };

    function createErrorPatternBreaker(): ToolRetryBreaker {
      return createToolRetryBreaker(errorPatternConfig);
    }

    it("blocks after 2 same-error failures with different args (known fingerprint)", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "edit";

      // Two failures with same error tag "[not_read]" but different args
      breaker.recordResult(tool, { file: "file_a.ts" }, false, "File [not_read] error");
      breaker.recordResult(tool, { file: "file_b.ts" }, false, "File [not_read] error");

      // Re-calling with a known-failing fingerprint IS blocked
      const verdict = breaker.beforeToolCall(tool, { file: "file_a.ts" });
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("not_read");
    });

    it("resets ALL error-pattern counters for that tool on success", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "edit";

      // One failure with "[not_read]"
      breaker.recordResult(tool, { file: "file_a.ts" }, false, "File [not_read] error");
      // Success resets all error patterns for this tool
      breaker.recordResult(tool, { file: "file_b.ts" }, true);
      // Another failure with "[not_read]" — counter should be back to 1
      breaker.recordResult(tool, { file: "file_c.ts" }, false, "File [not_read] error");

      const verdict = breaker.beforeToolCall(tool, { file: "file_d.ts" });
      expect(verdict.block).toBe(false);
    });

    it("works alongside existing signature tracking (both can block independently)", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "some_tool";
      const args = { x: 1 };

      // Trigger signature-level block (3 consecutive with same args)
      breaker.recordResult(tool, args, false, "error A");
      breaker.recordResult(tool, args, false, "error A");
      breaker.recordResult(tool, args, false, "error A");

      // Signature block should fire
      expect(breaker.beforeToolCall(tool, args).block).toBe(true);

      // Error-pattern block should also fire for known-failing fingerprints
      const breaker2 = createErrorPatternBreaker();
      breaker2.recordResult(tool, { y: 1 }, false, "error [tag_x]");
      breaker2.recordResult(tool, { y: 2 }, false, "error [tag_x]");

      // Known-failing fingerprint → blocked
      expect(breaker2.beforeToolCall(tool, { y: 1 }).block).toBe(true);
      // Novel fingerprint → allowed (probe)
      expect(breaker2.beforeToolCall(tool, { y: 3 }).block).toBe(false);
    });

    it("allows probe with novel args when error-pattern threshold is met", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "exec";

      // Two EPERM failures with different commands → error-pattern threshold hit
      breaker.recordResult(tool, { command: "cd projects && bash deploy.sh" }, false, "[permission_denied] EPERM");
      breaker.recordResult(tool, { command: "npx wrangler pages deploy ." }, false, "[permission_denied] EPERM");

      // Completely different command should NOT be blocked (it's a probe)
      const verdict = breaker.beforeToolCall(tool, { command: "echo test" });
      expect(verdict.block).toBe(false);
    });

    it("blocks known-failing fingerprint after error-pattern threshold", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "exec";
      const failingArgs = { command: "cd projects && bash deploy.sh" };

      breaker.recordResult(tool, failingArgs, false, "[permission_denied] EPERM");
      breaker.recordResult(tool, { command: "npx wrangler pages deploy ." }, false, "[permission_denied] EPERM");

      // Re-calling with one of the original failing commands IS blocked
      const verdict = breaker.beforeToolCall(tool, failingArgs);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("permission_denied");
    });

    it("probe failure adds fingerprint to blocked set", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "exec";

      // Trigger error-pattern threshold
      breaker.recordResult(tool, { command: "a" }, false, "[permission_denied] EPERM");
      breaker.recordResult(tool, { command: "b" }, false, "[permission_denied] EPERM");

      // Probe with novel args — allowed
      const probeArgs = { command: "c" };
      expect(breaker.beforeToolCall(tool, probeArgs).block).toBe(false);

      // Probe fails with same error → fingerprint added to blocked set
      breaker.recordResult(tool, probeArgs, false, "[permission_denied] EPERM");

      // Same probe args now blocked
      expect(breaker.beforeToolCall(tool, probeArgs).block).toBe(true);
    });

    it("tool-total backstop still blocks after multiple failed probes", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "exec";

      // Trigger error-pattern threshold (2 failures)
      breaker.recordResult(tool, { command: "a" }, false, "[permission_denied] EPERM");
      breaker.recordResult(tool, { command: "b" }, false, "[permission_denied] EPERM");

      // 3 more probe failures with novel args → tool-total hits 5
      breaker.recordResult(tool, { command: "c" }, false, "[permission_denied] EPERM");
      breaker.recordResult(tool, { command: "d" }, false, "[permission_denied] EPERM");
      breaker.recordResult(tool, { command: "e" }, false, "[permission_denied] EPERM");

      // Tool-level block kicks in — even completely novel args are blocked
      const verdict = breaker.beforeToolCall(tool, { command: "brand-new" });
      expect(verdict.block).toBe(true);
    });

    it("error-pattern check runs BEFORE signature check in beforeToolCall", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "edit";
      // Use an arg that's ALSO in the error-pattern's failing set
      const args = { file: "a.ts" };

      // Set up error-pattern block (2 same-error, different args)
      breaker.recordResult(tool, args, false, "[stuck]");
      breaker.recordResult(tool, { file: "b.ts" }, false, "[stuck]");

      // Also set up signature-level failures on a different arg (but not enough to block — only 2)
      breaker.recordResult(tool, { file: "c.ts" }, false, "different error");
      breaker.recordResult(tool, { file: "c.ts" }, false, "different error");

      // Error-pattern block should catch this (args is a known-failing fingerprint for [stuck])
      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("stuck");
    });
  });

  describe("extractErrorTag", () => {
    it("extracts bracketed tags like [not_read]", () => {
      expect(extractErrorTag("File [not_read] error")).toBe("not_read");
    });

    it("extracts Validation failed prefix", () => {
      expect(extractErrorTag("Validation failed: missing field")).toBe("validation_failed");
    });

    it("extracts validation from the real external-content envelope", () => {
      const wrapped = wrapExternalContent('Validation failed for tool "lookup": missing required property', {
        source: "mcp_tool",
      });
      expect(extractErrorTag(wrapped)).toBe("validation_failed");
      const invalidParams = wrapExternalContent('MCP error -32602: Input validation error: "too_big"', {
        source: "mcp_tool",
      });
      expect(extractErrorTag(invalidParams)).toBe("validation_failed");
    });

    it("fallback normalizes first 80 chars", () => {
      const tag = extractErrorTag("Something weird happened here!");
      expect(tag).toBe("something_weird_happened_here");
    });

    it("collapses consecutive underscores in fallback", () => {
      const tag = extractErrorTag("error: --- multiple --- separators");
      expect(tag).toBe("error_multiple_separators");
    });

    it("trims leading/trailing underscores in fallback", () => {
      const tag = extractErrorTag("!!!error!!!");
      expect(tag).toBe("error");
    });

    // --------------------------------------------------------------------
    // Envelope unwrapping — without it, two "spawn sandbox-exec ENOENT"
    // failures and an unrelated python3 --version probe all collapse
    // under the same generic tag because the breaker only sees the outer
    // {"content":[{text:...}]} envelope.
    // --------------------------------------------------------------------

    it("unwraps a serialized tool-result envelope and extracts the inner bracketed tag", () => {
      const envelope = JSON.stringify({
        content: [
          { type: "text", text: "[invalid_value] Shell command substitution $(...) detected" },
        ],
        details: {},
      });
      expect(extractErrorTag(envelope)).toBe("invalid_value");
    });

    it("produces DIFFERENT tags for different stderr signatures inside identical envelopes", () => {
      const enoentErr = JSON.stringify({
        content: [{
          type: "text",
          text: JSON.stringify({ exitCode: 1, stdout: "", stderr: "spawn sandbox-exec ENOENT" }),
        }],
        details: {},
      });
      const permErr = JSON.stringify({
        content: [{
          type: "text",
          text: JSON.stringify({ exitCode: 1, stdout: "", stderr: "permission denied: /etc/hosts" }),
        }],
        details: {},
      });

      const enoentTag = extractErrorTag(enoentErr);
      const permTag = extractErrorTag(permErr);
      expect(enoentTag).not.toBe(permTag);
      // Sanity: both tags mention the recognizable stderr signature,
      // not the generic envelope wrapper.
      expect(enoentTag).toContain("enoent");
      expect(permTag).toContain("permission");
    });

    it("unwraps TWO envelope layers (breaker-block message wrapping another envelope)", () => {
      // The breaker emits a block message like
      //   `Tool "exec" has failed 2 consecutive times with the same error:
      //    "{\"content\":[{\"type\":\"text\",\"text\":\"{…spawn sandbox-exec ENOENT…}\"}]}".
      //    This tool appears to be unavailable. …`
      // When this block message is fed back to the breaker on the next
      // failure, we must peel both layers before tagging.
      const innerEnvelope = JSON.stringify({
        content: [{
          type: "text",
          text: "[permission_denied] EPERM: operation not permitted",
        }],
        details: {},
      });
      const blockMsg =
        `Tool "exec" has failed 2 consecutive times with the same error: ` +
        `"${innerEnvelope.replace(/"/g, '\\"')}". This tool appears to be unavailable. ` +
        `DO NOT retry this tool.`;

      expect(extractErrorTag(blockMsg)).toBe("permission_denied");
    });

    it("unwraps an envelope followed by a line break", () => {
      const innerEnvelope = JSON.stringify({
        content: [{ type: "text", text: "[permission_denied] access denied" }],
        details: {},
      });
      const blockMsg =
        `Tool "exec" has failed 2 consecutive times with the same error: ` +
        `"${innerEnvelope.replace(/"/g, '\\"')}".\n` +
        "This tool appears to be unavailable.";

      expect(extractErrorTag(blockMsg)).toBe("permission_denied");
    });

    it("falls through unchanged on malformed/non-envelope input", () => {
      expect(extractErrorTag("{invalid json")).toBe("invalid_json");
      expect(extractErrorTag("plain error message")).toBe("plain_error_message");
    });

    it("structurally-identical envelopes with different stderrs do NOT share an error-pattern bucket", () => {
      // Before the unwrap fix, EVERY exec failure normalized to the same
      // tag `content_type_text_text_n_exitcode_1_n_stdout_n` because the
      // extractor only saw the outer JSON envelope. Two unrelated failures
      // (spawn ENOENT + command-not-found) would reach
      // maxConsecutiveErrorPatterns=2 together and shut exec down for both.
      // After the fix, they live in separate buckets, so 1 of each =
      // neither bucket maxes out = exec stays open.
      const breaker = createToolRetryBreaker({
        maxConsecutiveFailures: 3,
        maxToolFailures: 5,
        suggestAlternatives: true,
        maxConsecutiveErrorPatterns: 2,
      });

      const enoentEnvelope = JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ exitCode: 1, stdout: "", stderr: "spawn sandbox-exec ENOENT" }) }],
        details: {},
      });
      const cmdNotFoundEnvelope = JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ exitCode: 1, stdout: "", stderr: "python: command not found" }) }],
        details: {},
      });

      // One failure of each kind — each bucket is at 1, below the
      // threshold of 2.
      breaker.recordResult("exec", { command: "a", cwd: "x" }, false, enoentEnvelope);
      breaker.recordResult("exec", { command: "python3" }, false, cmdNotFoundEnvelope);

      // Neither error-pattern bucket has maxed out; exec stays open.
      const verdict = breaker.beforeToolCall("exec", { command: "ls" });
      expect(verdict.block).toBe(false);

      // Confirm tags are actually distinct (otherwise the assertion above
      // would be meaningless).
      expect(extractErrorTag(enoentEnvelope)).not.toBe(
        extractErrorTag(cmdNotFoundEnvelope),
      );
    });
  });

  describe("reset", () => {
    it("clears all state on reset", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      // Trigger both signature-level (3 consecutive) and tool-level (5 total) blocks
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");
      breaker.recordResult(tool, { symbol: "GOOG" }, false, "error");
      expect(breaker.beforeToolCall(tool, args).block).toBe(true);
      expect(breaker.getBlockedTools().length).toBeGreaterThan(0);

      // Reset clears everything
      breaker.reset();

      expect(breaker.beforeToolCall(tool, args).block).toBe(false);
      expect(breaker.getBlockedTools()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Sandbox-violation redirect: when the macOS sandbox-exec profile denies
  // writes to protected paths, the breaker's block reason should name
  // `skills_manage` / `discover_tools` / `scope: "local"` instead of the
  // generic "This tool appears to be unavailable" message.
  // -------------------------------------------------------------------------
  describe("sandbox-violation redirect", () => {
    const tool = "exec";
    const args = { command: "cp -r ./agent-runtime ~/.comis/skills/agent-runtime" };

    function tripToolLevelBlock(errorText: string): ToolRetryBreaker {
      const breaker = createBreaker();
      // maxToolFailures default = 5. Use 5 distinct args so the tool-level
      // counter hits the threshold regardless of signature-level counters.
      breaker.recordResult(tool, { a: 1 }, false, errorText);
      breaker.recordResult(tool, { a: 2 }, false, errorText);
      breaker.recordResult(tool, { a: 3 }, false, errorText);
      breaker.recordResult(tool, { a: 4 }, false, errorText);
      breaker.recordResult(tool, { a: 5 }, false, errorText);
      return breaker;
    }

    it("(a) node_modules EPERM produces redirect to discover_tools + skills_manage", () => {
      const errorText =
        "EPERM: operation not permitted, open '/Users/x/.nvm/versions/node/v22.14.0/lib/node_modules/foo'";
      const breaker = tripToolLevelBlock(errorText);

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason).toContain("discover_tools");
      expect(verdict.reason).toContain("skills_manage");
      expect(verdict.reason).toContain('scope: "local"');
      expect(verdict.reason).not.toContain("This tool appears to be unavailable");
      expect(verdict.reason).toContain("node_modules");
    });

    it("(b) .comis/skills EPERM produces redirect; skills signature wins over node_modules when both match", () => {
      // Include BOTH .comis/skills and node_modules in the same error text to
      // verify that the more-specific skills signature is chosen.
      const errorText =
        "operation not permitted, open '/Users/x/.comis/skills/foo' while resolving from /Users/x/.nvm/lib/node_modules";
      const breaker = tripToolLevelBlock(errorText);

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason).toContain("discover_tools");
      expect(verdict.reason).toContain("skills_manage");
      // Specificity: .comis/skills wins — message should reference skills path, not node_modules path label.
      expect(verdict.reason).toContain(".comis/skills");
    });

    it("(c) non-matching EPERM preserves generic 'This tool appears to be unavailable' message", () => {
      const errorText = "EPERM: operation not permitted, open '/tmp/random-file'";
      const breaker = tripToolLevelBlock(errorText);

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason).toContain("This tool appears to be unavailable");
      expect(verdict.reason).not.toContain("discover_tools");
      expect(verdict.reason).not.toContain("skills_manage");
    });

    it("(d) retries still blocked after redirect — block semantics preserved", () => {
      const errorText =
        "EPERM: operation not permitted, open '/Users/x/.nvm/versions/node/v22.14.0/lib/node_modules/foo'";
      const breaker = tripToolLevelBlock(errorText);

      const first = breaker.beforeToolCall(tool, args);
      expect(first.block).toBe(true);
      expect(first.reason).toContain("discover_tools");

      // Second call with the same args: still blocked.
      const second = breaker.beforeToolCall(tool, args);
      expect(second.block).toBe(true);
      expect(second.reason).toContain("discover_tools");
    });

    it("(e) gitconfig signature produces redirect with gitconfig path hint", () => {
      const errorText =
        "EPERM: operation not permitted, open '/Users/x/.gitconfig'";
      const breaker = tripToolLevelBlock(errorText);

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason).toContain("discover_tools");
      expect(verdict.reason).toContain("skills_manage");
      expect(verdict.reason).toContain("gitconfig");
    });

    it("(f) var/folders signature produces redirect", () => {
      const errorText =
        "operation not permitted, open '/private/var/folders/xy/abc/T/scratch.tmp'";
      const breaker = tripToolLevelBlock(errorText);

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason).toContain("discover_tools");
      expect(verdict.reason).toContain("skills_manage");
      expect(verdict.reason).toContain("var/folders");
    });
  });

  // ----------------------------------------------------------------------
  // Parameter-validation tags are NOT counted as tool failures.
  // Counting them lets a run of consecutive [invalid_value] parameter
  // rejections (an agent iterating on command shapes) trigger the
  // tool-total block and collapse exec entirely.
  // ----------------------------------------------------------------------

  describe("parameter-validation tags do not count as failures", () => {
    const cfg = {
      maxConsecutiveFailures: 3,
      maxToolFailures: 5,
      suggestAlternatives: true,
      maxConsecutiveErrorPatterns: 2,
    };

    it("does not block after N [invalid_value] rejections (tool-total would trigger at 5)", () => {
      const breaker = createToolRetryBreaker(cfg);

      // Simulate the deploy-attempt sequence: different commands, each
      // rejected by exec-security with [invalid_value].
      for (let i = 0; i < 8; i++) {
        breaker.recordResult(
          "exec",
          { command: `attempt ${i} with $(...)` },
          false,
          "[invalid_value] Shell command substitution $(...) detected",
        );
      }

      // Tool-total counter would have blocked at 5 if these counted.
      expect(breaker.getBlockedTools()).toEqual([]);
      const verdict = breaker.beforeToolCall("exec", {
        command: "python3 deploy.py",
      });
      expect(verdict.block).toBe(false);
    });

    it("does not trigger error-pattern block for [invalid_value] across different args", () => {
      const breaker = createToolRetryBreaker(cfg);

      // Threshold is 2 — two different-args same-error failures would
      // normally trigger error-pattern block.
      breaker.recordResult(
        "exec",
        { command: "a $()" },
        false,
        "[invalid_value] Shell command substitution $(...) detected",
      );
      breaker.recordResult(
        "exec",
        { command: "b $()" },
        false,
        "[invalid_value] Shell command substitution $(...) detected",
      );
      breaker.recordResult(
        "exec",
        { command: "c $()" },
        false,
        "[invalid_value] Shell command substitution $(...) detected",
      );

      const verdict = breaker.beforeToolCall("exec", { command: "d" });
      expect(verdict.block).toBe(false);
    });

    it("ignores [missing_param] and validation_failed equally", () => {
      const breaker = createToolRetryBreaker(cfg);

      for (let i = 0; i < 6; i++) {
        breaker.recordResult(
          "exec",
          { command: `x${i}` },
          false,
          "[missing_param] Missing required parameter: command",
        );
      }
      for (let i = 0; i < 6; i++) {
        breaker.recordResult(
          "exec",
          { command: `y${i}` },
          false,
          "Validation failed: invalid schema",
        );
      }

      expect(breaker.getBlockedTools()).toEqual([]);
    });

    it("does not open for externally wrapped MCP validation failures", () => {
      const breaker = createToolRetryBreaker(cfg);
      const missing = wrapExternalContent('Validation failed for tool "lookup": missing required property', {
        source: "mcp_tool",
      });
      const tooLarge = wrapExternalContent('MCP error -32602: Input validation error: "too_big"', {
        source: "mcp_tool",
      });

      breaker.recordResult("mcp__example--lookup", { query: "first" }, false, missing);
      const transition = breaker.recordResult("mcp__example--lookup", { query: "second" }, false, tooLarge);

      expect(transition).toBeUndefined();
      expect(breaker.getBlockedTools()).toEqual([]);
      expect(breaker.beforeToolCall("mcp__example--lookup", { query: "third" }).block).toBe(false);
    });

    it("still counts genuine tool failures (permission_denied, not_found)", () => {
      const breaker = createToolRetryBreaker(cfg);

      // Five different-args permission_denied errors → tool-total threshold.
      for (let i = 0; i < 5; i++) {
        breaker.recordResult(
          "exec",
          { command: `failing cmd ${i}` },
          false,
          "[permission_denied] EPERM: operation not permitted",
        );
      }

      expect(breaker.getBlockedTools()).toContain("exec");
    });

    it("still triggers signature-level block on repeated identical permission_denied", () => {
      const breaker = createToolRetryBreaker(cfg);
      const args = { command: "touch /etc/hosts" };

      for (let i = 0; i < 3; i++) {
        breaker.recordResult("exec", args, false, "[permission_denied] EPERM");
      }

      const verdict = breaker.beforeToolCall("exec", args);
      expect(verdict.block).toBe(true);
    });

    it("parameter-validation failure does not reset a prior genuine-failure counter", () => {
      const breaker = createToolRetryBreaker(cfg);

      // Genuine failures accumulate.
      for (let i = 0; i < 4; i++) {
        breaker.recordResult(
          "exec",
          { command: `a${i}` },
          false,
          "[permission_denied] EPERM",
        );
      }
      // An intervening parameter-rejection should be a no-op on counters.
      breaker.recordResult(
        "exec",
        { command: "bad $()" },
        false,
        "[invalid_value] Shell command substitution",
      );
      // One more genuine failure → tool-total threshold (5) reached.
      breaker.recordResult(
        "exec",
        { command: "a5" },
        false,
        "[permission_denied] EPERM",
      );

      expect(breaker.getBlockedTools()).toContain("exec");
    });
  });

  // ---------------------------------------------------------------------------
  // Non-zero COMMAND exits are corrective feedback, not tool unavailability.
  //
  // The failure mode being guarded: an agent runs `npm run build` on a
  // TypeScript project it is actively editing and `tsc` exits 2 (legit compile
  // errors). pi-event-bridge.ts:593-602 flips toolSuccess=false for ANY result
  // whose `details.exitCode` is a non-zero number, and pi-event-bridge.ts:719
  // then feeds that "failure" to recordResult(). The exec wrapper's serialized
  // envelope tags as the fallback `exitcode_2_stdout_...` (NOT a
  // PARAMETER_VALIDATION_TAG), so after two same-tag exits the breaker declares
  // exec "unavailable. DO NOT retry this tool" — killing the edit→build→fix
  // loop mid-task and forcing the agent to bluff a completion it cannot
  // verify (endReason: completed_with_tool_errors).
  //
  // A command that RAN TO COMPLETION and exited non-zero (tsc errors, failing
  // tests, `grep`/`diff` exit 1) is the normal signal of a coding loop, not
  // evidence that the tool is broken. It MUST NOT count toward any breaker
  // threshold — exactly like PARAMETER_VALIDATION_TAGS above. The discriminator
  // is the presence of a numeric exitCode in the envelope: process ran (exempt)
  // vs. process never ran / infra fault (spawn ENOENT, EPERM — still blocks).
  describe("non-zero command exits do not count as failures", () => {
    const cfg = {
      // Real production defaults (core/schema-agent-model.ts): 3 / 5 / 2.
      maxConsecutiveFailures: 3,
      maxToolFailures: 5,
      suggestAlternatives: true,
      maxConsecutiveErrorPatterns: 2,
    };

    // Faithful reproduction of the errorText the breaker receives. The bridge
    // hands it extractErrorText(result) (bridge-event-handlers.ts:63), which
    // JSON.stringify's the full exec envelope — the same payload the daemon
    // logs at WARN on an exec failure. The inner `text` is the pretty-printed
    // command result; `details.exitCode` carries the numeric exit code.
    function execExitEnvelope(exitCode: number, stdout: string, stderr = ""): string {
      const inner = JSON.stringify({ exitCode, stdout, stderr }, null, 2);
      return JSON.stringify({
        content: [{ type: "text", text: inner }],
        details: { exitCode, stdout, stderr },
      });
    }

    const TSC_BUILD_FAIL = execExitEnvelope(
      2,
      "\n> typescript-snake@1.0.0 build\n> tsc\n\n" +
        "src/main.ts(55,3): error TS18047: 'ctx' is possibly 'null'.\n",
    );

    it("does not block on repeated identical non-zero exits (the build-fix loop)", () => {
      const breaker = createToolRetryBreaker(cfg);
      const args = { command: "npm run build", cwd: "projects/snake-game" };

      // Same command, same exit-2 result, four times — exceeds BOTH the
      // signature threshold (3) and the error-pattern threshold (2).
      for (let i = 0; i < 4; i++) {
        breaker.recordResult("exec", args, false, TSC_BUILD_FAIL);
      }

      // The agent fixed the code and wants to re-run the build. It must be
      // allowed to: a non-zero exit is not tool unavailability.
      expect(breaker.beforeToolCall("exec", args).block).toBe(false);
      expect(breaker.getBlockedTools()).toEqual([]);
    });

    it("does not trip the tool-total backstop across different non-zero-exit commands", () => {
      const breaker = createToolRetryBreaker(cfg);

      // Six distinct commands that each ran and exited non-zero (failing
      // tests, type errors in different files). maxToolFailures (5) would
      // block the whole tool if these counted.
      breaker.recordResult("exec", { command: "npm test" }, false, execExitEnvelope(1, "2 failing"));
      breaker.recordResult("exec", { command: "npm run build" }, false, TSC_BUILD_FAIL);
      breaker.recordResult("exec", { command: "tsc -p a" }, false, execExitEnvelope(2, "a.ts(1,1): error"));
      breaker.recordResult("exec", { command: "tsc -p b" }, false, execExitEnvelope(2, "b.ts(1,1): error"));
      breaker.recordResult("exec", { command: "eslint ." }, false, execExitEnvelope(1, "3 problems"));
      breaker.recordResult("exec", { command: "grep TODO src" }, false, execExitEnvelope(1, ""));

      expect(breaker.getBlockedTools()).toEqual([]);
      expect(breaker.beforeToolCall("exec", { command: "npm run build" }).block).toBe(false);
    });

    it("still blocks genuine tool-infrastructure faults with no exit code (spawn ENOENT)", () => {
      // Boundary guard: when the process NEVER RAN (sandbox failed to spawn),
      // there is no exitCode and it IS a real tool failure — the breaker's
      // original purpose. The exemption must not swallow this.
      const breaker = createToolRetryBreaker(cfg);
      const args = { command: "python3 analyze.py" };
      const spawnFault = JSON.stringify({
        content: [{ type: "text", text: "spawn sandbox-exec ENOENT" }],
        details: {},
      });

      for (let i = 0; i < 3; i++) {
        breaker.recordResult("exec", args, false, spawnFault);
      }

      expect(breaker.beforeToolCall("exec", args).block).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Config-driven toolAlternatives
  // ---------------------------------------------------------------------------

  describe("config-driven toolAlternatives", () => {
    it("returns empty alternatives when toolAlternatives is undefined (default)", () => {
      const breaker = createToolRetryBreaker({
        maxConsecutiveFailures: 3,
        maxToolFailures: 5,
        suggestAlternatives: true,
        // toolAlternatives intentionally omitted — empty map default
      });
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.alternatives).toEqual([]);
      // Generic fallback wording in buildBlockReason.
      expect(verdict.reason).toContain("alternative approaches");
      // Critically: no hardcoded suggestion appears when the operator hasn't
      // populated the alternatives map. The production config ships
      // toolAlternatives omitted.
      expect(verdict.reason).not.toContain("web_search");
      expect(verdict.reason).not.toContain("mcp__tavily--tavily-search");
    });

    it("returns operator-supplied alternatives when toolAlternatives is populated", () => {
      const breaker = createToolRetryBreaker({
        maxConsecutiveFailures: 3,
        maxToolFailures: 5,
        suggestAlternatives: true,
        toolAlternatives: {
          "mcp__custom-server": ["custom_alt_1", "custom_alt_2"],
        },
      });
      const tool = "mcp__custom-server--some_op";
      const args = { x: 1 };
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.alternatives).toEqual(["custom_alt_1", "custom_alt_2"]);
      expect(verdict.reason).toContain("custom_alt_1");
      expect(verdict.reason).toContain("custom_alt_2");
    });

    it("returns empty alternatives when no prefix matches", () => {
      const breaker = createToolRetryBreaker({
        maxConsecutiveFailures: 3,
        maxToolFailures: 5,
        suggestAlternatives: true,
        toolAlternatives: {
          "mcp__server-A": ["alt_a"],
        },
      });
      const tool = "completely_unrelated_tool";
      const args = { x: 1 };
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.alternatives).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // buildBlockReason must produce a repair-not-abandon message for
  // parameter-validation tags (exported direct call — the recordResult
  // accumulation path is unreachable for validation tags, which early-return).
  // -------------------------------------------------------------------------
  describe("buildBlockReason (validation-tag repair-not-abandon)", () => {
    it("produces 'Fix the arguments' and NOT 'appears to be unavailable' for a parameter-validation tag", () => {
      const reason = buildBlockReason(
        "mcp_manage",
        2,
        "[invalid_value] headers must be an object",
        [],
        "invalid_value",
        false,
      );
      expect(reason).not.toMatch(/appears to be unavailable/i);
      expect(reason).toMatch(/[Ff]ix the arguments/);
    });

    it("still says 'appears to be unavailable' for a non-validation error (non-regression)", () => {
      const reason = buildBlockReason(
        "mcp_manage",
        5,
        "[network_error] timeout",
        [],
        "network_error",
        true,
      );
      expect(reason).toMatch(/appears to be unavailable/i);
    });
  });

  // -------------------------------------------------------------------------
  // Second-order failure mode: the breaker's RENDERED block message must not
  // recursively nest. When a prior block message is fed back
  // as the next errorText, peelEnvelope already collapses it for TAG
  // extraction — but the human-readable errorClause embedded the RAW lastError
  // verbatim, so the model saw Russian-doll nesting:
  //   `failed 7 total times with the same error:
  //    "…failed 6 total times with the same error: \"…\""`.
  // The rendered clause must show the INNERMOST real error instead.
  // -------------------------------------------------------------------------
  describe("buildBlockReason (re-fed block message must not nest)", () => {
    it("collapses a prior block message to its innermost error — no nested 'has failed … same error' clause", () => {
      // A realistic prior block message (the breaker's own output), itself
      // wrapping a serialized tool-result envelope as its lastError.
      const innerEnvelope = JSON.stringify({
        content: [{ type: "text", text: "[unavailable] upstream 503 from provider" }],
        details: {},
      });
      const priorBlockMessage =
        `Tool "web_fetch" has failed 6 total times with the same error: ` +
        `"${innerEnvelope.replace(/"/g, '\\"')}". This tool appears to be unavailable. ` +
        `DO NOT retry this tool. Instead:\n- Use alternative approaches to complete your task`;

      // The next turn feeds that whole prior message back as lastError.
      const reason = buildBlockReason(
        "web_fetch",
        7,
        priorBlockMessage,
        [],
        "unavailable",
        true,
      );

      // The OUTER message still announces the failure exactly once.
      expect((reason.match(/has failed/g) ?? []).length).toBe(1);
      // It must NOT embed the prior block's prose (no nested failure clause,
      // no nested "appears to be unavailable").
      expect(reason).not.toMatch(/same error:.*has failed/s);
      expect((reason.match(/appears to be unavailable/g) ?? []).length).toBe(1);
      // The rendered clause shows the INNERMOST real error.
      expect(reason).toContain("upstream 503 from provider");
    });

    it("collapses a raw serialized envelope lastError to its inner text", () => {
      const envelope = JSON.stringify({
        content: [{ type: "text", text: "[permission_denied] EPERM: operation not permitted" }],
        details: {},
      });
      const reason = buildBlockReason("exec", 3, envelope, [], "permission_denied", false);
      // Inner real error is shown; the JSON envelope wrapper is not embedded raw.
      expect(reason).toContain("EPERM: operation not permitted");
      expect(reason).not.toContain('"content"');
    });

    it("leaves a plain (non-envelope, non-block) error unchanged in the clause", () => {
      const reason = buildBlockReason("exec", 3, "connection timeout", [], "connection_timeout", false);
      expect(reason).toContain("connection timeout");
      expect(reason).toContain("has failed");
    });
  });

  // -------------------------------------------------------------------------
  // recordResult returns a transition verdict at the counter-crossing
  // edges so the bridge can emit tool:breaker_opened / tool:breaker_reset
  // EXACTLY at the threshold edge (once per open), keeping the breaker itself
  // eventBus-free. The transition uses EXACT equality (=== threshold), not the
  // idempotent >= the Set.add block uses — a >= verdict would re-fire `opened`
  // on every subsequent failure and inflate the incident report's
  // breakerTimeline.
  // -------------------------------------------------------------------------
  describe("recordResult returns a transition verdict at threshold edges", () => {
    it("returns transition opened with reason tool_failure_threshold EXACTLY at the tool-level crossing; undefined after", () => {
      const breaker = createBreaker(); // maxToolFailures: 5
      const tool = "exec";

      // First four distinct-args failures cross neither edge → undefined.
      for (let i = 0; i < 4; i++) {
        const verdict = breaker.recordResult(tool, { a: i }, false, "[permission_denied] EPERM");
        expect(verdict).toBeUndefined();
      }

      // The 5th distinct-args failure (toolState.count === maxToolFailures) opens.
      const opened = breaker.recordResult(tool, { a: 4 }, false, "[permission_denied] EPERM");
      expect(opened).toBeDefined();
      expect(opened?.transition).toBe("opened");
      expect(opened?.reason).toBe("tool_failure_threshold");
      expect(opened?.toolName).toBe(tool);
      // errorTag is the already-normalized extractErrorTag output, never raw text.
      expect(opened?.errorTag).toBe("permission_denied");

      // The 6th (and any later) failure must NOT re-fire opened (=== guard, not >=).
      const sixth = breaker.recordResult(tool, { a: 5 }, false, "[permission_denied] EPERM");
      expect(sixth).toBeUndefined();
    });

    it("emits opened exactly once across repeated failures past the threshold", () => {
      const breaker = createBreaker(); // maxToolFailures: 5
      const tool = "exec";

      let openCount = 0;
      for (let i = 0; i < 8; i++) {
        const verdict = breaker.recordResult(tool, { a: i }, false, "[network_error] timeout");
        if (verdict?.transition === "opened") openCount++;
      }
      expect(openCount).toBe(1);
    });

    it("returns transition opened with reason error_pattern EXACTLY at the error-pattern crossing", () => {
      const breaker = createToolRetryBreaker({
        maxConsecutiveFailures: 3,
        maxToolFailures: 5,
        suggestAlternatives: true,
        maxConsecutiveErrorPatterns: 2,
      });
      const tool = "edit";

      // First same-error / different-args failure: pattern count 1, below the
      // threshold of 2 → undefined.
      const first = breaker.recordResult(tool, { file: "a.ts" }, false, "File [not_read] error");
      expect(first).toBeUndefined();

      // Second same-error / different-args failure crosses the error-pattern
      // threshold (=== maxErrorPatterns) → opened with reason error_pattern.
      const opened = breaker.recordResult(tool, { file: "b.ts" }, false, "File [not_read] error");
      expect(opened?.transition).toBe("opened");
      expect(opened?.reason).toBe("error_pattern");
      expect(opened?.toolName).toBe(tool);
      expect(opened?.errorTag).toBe("not_read");
    });

    it("reports the tool-WIDE total as consecutiveFailures on a tool_failure_threshold open (not the per-signature 1)", () => {
      // The canonical tool-level trip is N failures across N DISTINCT
      // args. Each signature's own consecutiveFailures is 1, but the open was
      // caused by the tool-wide total crossing maxToolFailures. The event field
      // named `consecutiveFailures` must report the counter that actually crossed
      // (toolState.count === 5), so the incident report's breakerTimeline renders
      // "opened after 5 failures", not a misleading "opened after 1".
      const breaker = createBreaker(); // maxToolFailures: 5
      const tool = "exec";
      for (let i = 0; i < 4; i++) {
        expect(breaker.recordResult(tool, { a: i }, false, "[permission_denied] EPERM")).toBeUndefined();
      }
      const opened = breaker.recordResult(tool, { a: 4 }, false, "[permission_denied] EPERM");
      expect(opened?.reason).toBe("tool_failure_threshold");
      expect(opened?.consecutiveFailures).toBe(5);
    });

    it("reports the error-pattern consecutive count as consecutiveFailures on an error_pattern open", () => {
      // An error-pattern open crosses the per-pattern consecutive
      // counter (patternState.consecutiveFailures === maxConsecutiveErrorPatterns).
      // The event must report THAT counter, not the calling signature's count.
      const breaker = createToolRetryBreaker({
        maxConsecutiveFailures: 3,
        maxToolFailures: 5,
        suggestAlternatives: true,
        maxConsecutiveErrorPatterns: 2,
      });
      const tool = "edit";
      expect(breaker.recordResult(tool, { file: "a.ts" }, false, "File [not_read] error")).toBeUndefined();
      const opened = breaker.recordResult(tool, { file: "b.ts" }, false, "File [not_read] error");
      expect(opened?.reason).toBe("error_pattern");
      // Distinct-args same-error: each signature consecutiveFailures is 1, but the
      // error-pattern counter that crossed is 2.
      expect(opened?.consecutiveFailures).toBe(2);
    });

    it("returns transition reset with reason success when a success clears a non-zero failure counter", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      expect(breaker.recordResult(tool, args, false, "connection timeout")).toBeUndefined();
      const reset = breaker.recordResult(tool, args, true);
      expect(reset?.transition).toBe("reset");
      expect(reset?.reason).toBe("success");
      expect(reset?.toolName).toBe(tool);
      expect(reset?.consecutiveFailures).toBe(0);
      expect(reset?.errorTag).toBe("");
    });

    it("does NOT emit reset when the tool is still hard-blocked at tool level (event must reflect availability)", () => {
      // A success clears the signature counter but NEVER clears
      // blockedTools or the tool-level total. If the tool already crossed
      // maxToolFailures, a success on a still-failing signature must NOT emit
      // tool:breaker_reset — beforeToolCall would STILL block, so the trajectory
      // would show "reset" while the breaker is, in fact, open. Reset must
      // reflect tool-availability, not just the per-signature counter.
      const breaker = createBreaker(); // maxConsecutiveFailures: 3, maxToolFailures: 5
      const tool = "exec";
      const args = { cmd: "broken" };

      // Five failures on the SAME signature crosses BOTH the signature-level (3)
      // and the tool-level total (5) thresholds → tool hard-blocked.
      for (let i = 0; i < 5; i++) {
        breaker.recordResult(tool, args, false, "[permission_denied] EPERM");
      }
      expect(breaker.getBlockedTools()).toContain(tool);
      expect(breaker.beforeToolCall(tool, args).block).toBe(true);

      // Success on that signature: counter is non-zero, but the tool stays
      // blocked. No reset transition may be reported.
      const out = breaker.recordResult(tool, args, true);
      expect(out).toBeUndefined();
      // Tool is still blocked after the "success" — the reset would have lied.
      expect(breaker.beforeToolCall(tool, args).block).toBe(true);
    });

    it("DOES emit reset when the success restores a tool that was never tool-level blocked", () => {
      // The complementary case: a signature that crossed only the signature-level
      // counter (not the tool-wide total) is genuinely recovered by a success —
      // the tool is usable again, so reset is truthful and must still fire.
      const breaker = createBreaker(); // maxConsecutiveFailures: 3, maxToolFailures: 5
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      // Three failures crosses the signature-level threshold (3) but NOT the
      // tool-level total (5) → tool is NOT in blockedTools.
      for (let i = 0; i < 3; i++) {
        breaker.recordResult(tool, args, false, "connection timeout");
      }
      expect(breaker.getBlockedTools()).not.toContain(tool);

      const reset = breaker.recordResult(tool, args, true);
      expect(reset?.transition).toBe("reset");
      expect(reset?.reason).toBe("success");
      expect(reset?.consecutiveFailures).toBe(0);
    });

    it("returns undefined for a success with NO prior failure", () => {
      const breaker = createBreaker();
      const reset = breaker.recordResult("bash", { cmd: "ls" }, true);
      expect(reset).toBeUndefined();
    });

    it("returns undefined (no transition) on the lifecycle reset() full-clear", () => {
      const breaker = createBreaker();
      breaker.recordResult("exec", { a: 1 }, false, "error");
      // reset() is between-execution lifecycle teardown — it returns void and
      // yields no observable in-session transition.
      const out = breaker.reset();
      expect(out).toBeUndefined();
    });

    it("parameter-validation and completed-command-exit failures yield NO transition", () => {
      const breaker = createBreaker();
      const tool = "exec";
      // [invalid_value] is a PARAMETER_VALIDATION_TAG → no counter change, no transition.
      for (let i = 0; i < 6; i++) {
        const v = breaker.recordResult(tool, { command: `bad ${i} $()` }, false, "[invalid_value] substitution");
        expect(v).toBeUndefined();
      }
      // A completed-command non-zero exit (carries details.exitCode) → exempt, no transition.
      const tsc = JSON.stringify({ content: [{ type: "text", text: "tsc error" }], details: { exitCode: 2 } });
      expect(breaker.recordResult(tool, { command: "tsc" }, false, tsc)).toBeUndefined();
    });
  });
});
