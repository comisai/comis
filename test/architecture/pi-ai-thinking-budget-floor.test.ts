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

// Read through the consumer package's node_modules symlink so the PATCHED copy
// is asserted — pnpm keys patched installs by hash under .pnpm, and a stale
// unpatched copy can shadow the repo-root node_modules path. The packages'
// exports maps block require.resolve for non-exported subpaths, so the link is
// followed by path, not by the resolver.
function installedSource(pkg: string, subpath: string): string {
  return readFileSync(
    resolve(REPO_ROOT, "packages", "agent", "node_modules", pkg, subpath),
    "utf8",
  );
}

describe("pi-ai thinking-budget floor patch", () => {
  it("bedrock simple-stream drops thinking instead of sending a below-minimum budget", () => {
    const src = installedSource("@earendil-works/pi-ai", "dist/api/bedrock-converse-stream.js");
    expect(src).toContain("MIN_PROVIDER_THINKING_BUDGET");
  });

  it("anthropic simple-stream drops thinking instead of sending a below-minimum budget", () => {
    const src = installedSource("@earendil-works/pi-ai", "dist/api/anthropic-messages.js");
    expect(src).toContain("MIN_PROVIDER_THINKING_BUDGET");
  });
});

describe("pi-ai provider-error body normalization", () => {
  it("only a plain object counts as an HTTP error body", () => {
    // A class instance in `$response.body` (AWS SDK v3 puts an HTTP stream
    // wrapper there) used to be stringified as `{"_events":...}` and then
    // REPLACED `error.message` in the composed display string — discarding the
    // one useful line ("Input is too long...") for noise. The repository
    // carried a patch for this; upstream now ships the prototype check itself,
    // so the patch hunk was retired. This guard keeps the behavior pinned to
    // the INSTALLED package: a pi-ai upgrade that drops the check fails here
    // rather than silently restoring garbage error text.
    const src = installedSource("@earendil-works/pi-ai", "dist/utils/error-body.js");
    expect(src).toContain("isPlainNonEmptyObject");
    expect(src).toContain("Object.getPrototypeOf");
  });
});

describe("pi-coding-agent script-aware compaction estimator patch", () => {
  it("compaction token estimation carries the non-Latin divisor", () => {
    // chars/4 undercounts non-Latin scripts (Hebrew, Arabic, CJK) roughly 2x,
    // so the compaction summarizer builds a prompt the provider rejects as over
    // the context window — deadlocking compaction exactly when the window is
    // full. The patch samples the message text and applies a denser divisor.
    const src = installedSource(
      "@earendil-works/pi-coding-agent",
      "dist/core/compaction/compaction.js",
    );
    expect(src).toContain("NON_LATIN_DENSE_DIVISOR");
  });

  it("the summarizer bounds its serialized conversation to the model window", () => {
    // generateSummaryWithUsage serialized the ENTIRE conversation into one
    // prompt with no input bound, so summarizing an over-window conversation
    // was itself over-window — rejected by the provider on every attempt.
    const src = installedSource(
      "@earendil-works/pi-coding-agent",
      "dist/core/compaction/compaction.js",
    );
    expect(src).toContain("truncated for summarization");
  });
});
