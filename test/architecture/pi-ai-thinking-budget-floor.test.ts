// SPDX-License-Identifier: Apache-2.0
/**
 * The provider hard-rejects `thinking.enabled.budget_tokens < 1024`. pi-ai's
 * simple-stream helpers clamp maxTokens to the remaining context and then fund
 * the thinking budget from `maxTokens - 1024` — so on a nearly-full context the
 * computed budget drops below the provider minimum and the request can only
 * fail. That is precisely the state the overflow-recovery summarizer runs in,
 * so the failure deadlocks recovery: the conversation can never compact back
 * under the window (live: every first call of a turn on a 200k-window model
 * rejected, and 'Context overflow recovery failed: Summarization failed').
 *
 * The repository patches pi-ai (patches/@earendil-works__pi-ai@*.patch) to
 * drop thinking from the call instead of sending a below-minimum budget. This
 * guard pins the patched behavior in the INSTALLED package so a pi-ai upgrade
 * that regenerates the patch without the guard fails loudly here instead of
 * silently re-arming the live incident.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function installedSource(subpath: string): string {
  return readFileSync(
    resolve(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai", subpath),
    "utf8",
  );
}

describe("pi-ai thinking-budget floor patch", () => {
  it("bedrock simple-stream drops thinking instead of sending a below-minimum budget", () => {
    const src = installedSource("dist/api/bedrock-converse-stream.js");
    expect(src).toContain("MIN_PROVIDER_THINKING_BUDGET");
  });

  it("anthropic simple-stream drops thinking instead of sending a below-minimum budget", () => {
    const src = installedSource("dist/api/anthropic-messages.js");
    expect(src).toContain("MIN_PROVIDER_THINKING_BUDGET");
  });
});

describe("pi-coding-agent script-aware compaction estimator patch", () => {
  it("compaction token estimation carries the non-Latin divisor", () => {
    // chars/4 undercounts non-Latin scripts (Hebrew, Arabic, CJK) roughly 2x,
    // so the compaction summarizer builds a prompt the provider rejects as over
    // the context window — deadlocking compaction exactly when the window is
    // full. The patch samples the message text and applies a denser divisor.
    const src = readFileSync(
      resolve(
        REPO_ROOT,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist/core/compaction/compaction.js",
      ),
      "utf8",
    );
    expect(src).toContain("NON_LATIN_DENSE_DIVISOR");
  });
});
