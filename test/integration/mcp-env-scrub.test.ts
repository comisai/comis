// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 63 SAFETY-01/02 — env-scrub integration test.
 *
 * Verifies that the scrubbed env produced by `scrubStdioEnv` is actually
 * carried into a real subprocess. The mid-test child spawn uses
 * `/usr/bin/printenv`, whose stdout is the literal `KEY=VALUE` listing of
 * the env it received. Asserting on that output proves the scrub result is
 * the env the child observes — not just the dictionary we built up in
 * memory.
 *
 * The unit-level behavior (allowlist membership, prefix matching,
 * Shellshock skip) is exhaustively covered in the co-located unit test at
 * `packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.test.ts`.
 * This file is the boundary check: real Node `child_process.spawnSync` →
 * real `/usr/bin/printenv` → real stdout.
 *
 * Per CLAUDE.md: integration tests import from `dist/`; this file relies
 * on `pnpm build` having run for `@comis/skills` before vitest executes.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { scrubStdioEnv } from "@comis/skills";

describe("MCP env scrub — daemon env does NOT bleed into stdio child", () => {
  it("daemon env dangerous keys do not appear in scrubStdioEnv result with no allowlist extension", () => {
    const scrubbed = scrubStdioEnv(undefined, undefined);
    expect(Object.keys(scrubbed)).not.toContain("OPENAI_API_KEY");
    expect(Object.keys(scrubbed)).not.toContain("GITHUB_TOKEN");
    expect(Object.keys(scrubbed)).not.toContain("STRIPE_SECRET_KEY");
    expect(Object.keys(scrubbed)).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(Object.keys(scrubbed)).not.toContain("DISCORD_TOKEN");
    expect(Object.keys(scrubbed)).not.toContain("AWS_ACCESS_KEY_ID");
    expect(Object.keys(scrubbed)).not.toContain("COMIS_GATEWAY_TOKEN");
    expect(Object.keys(scrubbed)).not.toContain("SECRETS_MASTER_KEY");
  });

  it("config.env explicit values pass through scrubStdioEnv unchanged when child is spawned", () => {
    const scrubbed = scrubStdioEnv(
      { MY_API_KEY: "explicit-value", USER_NAMED: "foo" },
      undefined,
    );
    const result = spawnSync("/usr/bin/printenv", [], {
      env: scrubbed,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MY_API_KEY=explicit-value");
    expect(result.stdout).toContain("USER_NAMED=foo");
  });

  it("operator extension via safetyAllowedEnvKeys passes through additional daemon env keys", () => {
    // Save / restore the one daemon-env key this assertion plants so the
    // test harness does not leak state into sibling integration tests.
    const previous = process.env.CUSTOM_X;
    process.env.CUSTOM_X = "test-value";
    try {
      const scrubbed = scrubStdioEnv(undefined, ["CUSTOM_X"]);
      expect(scrubbed.CUSTOM_X).toBe("test-value");
    } finally {
      if (previous === undefined) {
        delete process.env.CUSTOM_X;
      } else {
        process.env.CUSTOM_X = previous;
      }
    }
  });
});
