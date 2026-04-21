// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createToolRetryBreaker, extractErrorTag } from "./tool-retry-breaker.js";
import type { ToolRetryBreaker } from "./tool-retry-breaker.js";

describe("tool retry breaker", () => {
  const defaultConfig = {
    maxConsecutiveFailures: 3,
    maxToolFailures: 5,
    suggestAlternatives: true,
    // High value so existing signature/tool-level tests aren't affected by error-pattern blocking
    maxConsecutiveErrorPatterns: 100,
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
    // Envelope unwrapping — regression for session 678314278 lines 40-51
    // where two "spawn sandbox-exec ENOENT" failures + an unrelated
    // python3 --version probe all collapsed under the same generic tag
    // because the breaker only saw the outer {"content":[{text:...}]}
    // envelope.
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

    it("falls through unchanged on malformed/non-envelope input", () => {
      expect(extractErrorTag("{invalid json")).toBe("invalid_json");
      expect(extractErrorTag("plain error message")).toBe("plain_error_message");
    });

    it("regression: session 678314278 — structurally-identical envelopes with different stderrs do NOT share an error-pattern bucket", () => {
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
  // Parameter-validation tags are NOT counted as tool failures
  // Regression: Cloudflare Pages deploy attempt (session 678314278) where
  // 5 consecutive [invalid_value] parameter rejections triggered the
  // tool-total block and collapsed exec entirely.
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
});
