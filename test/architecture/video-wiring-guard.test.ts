// SPDX-License-Identifier: Apache-2.0
/**
 * Built-but-not-wired SOURCE GUARD for the video-generation stack (Phase 188 /
 * Plan 04). Mirrors the image wiring + the `startup-invariants.test.ts`
 * precedent: a shrink-only daemon.ts source-grep with NO allowlist.
 *
 * "Built but not wired" has been THIS milestone's #1 recurring blocker (caught by
 * code review every prior phase): a port/handler can exist, compile, and pass its
 * own unit tests while the LIVE daemon never wires it, so the agent's
 * `video_generate` call silently no-ops. These assertions pin the live wiring so
 * a future refactor cannot regress the path to unwired without turning this test
 * red. The only way to comply is to keep the wiring in daemon.ts +
 * rpc-dispatch.ts.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DAEMON_TS = resolve(REPO_ROOT, "packages/daemon/src/daemon.ts");
const RPC_DISPATCH_TS = resolve(REPO_ROOT, "packages/daemon/src/api/rpc-dispatch.ts");

/** Strip line + block comments so a token inside a comment cannot satisfy a
 *  wiring assertion (a comment naming buildVideoGenBundle is NOT the wiring). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

describe("video-generation built-but-not-wired source guard", () => {
  it("daemon.ts imports the video bundle builders from wiring/main-helpers.js", () => {
    const content = readFileSync(DAEMON_TS, "utf8");
    expect(content).toMatch(
      /import\s*\{[^}]*buildVideoGenBundle[^}]*\}\s*from\s*["']\.\/wiring\/main-helpers\.js["']/,
    );
    expect(content).toMatch(
      /import\s*\{[^}]*buildVideoHandlerDeps[^}]*\}\s*from\s*["']\.\/wiring\/main-helpers\.js["']/,
    );
  });

  it("daemon.ts CALLS buildVideoGenBundle and destructures its outputs (the boot probe)", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    expect(code).toMatch(/buildVideoGenBundle\s*\(/);
    // The bundle outputs must be destructured (so they flow into the boot context).
    expect(code).toMatch(/videoGenProvider/);
    expect(code).toMatch(/videoGenRateLimiter/);
    expect(code).toMatch(/persistVideo/);
    expect(code).toMatch(/videoGenCostLimiter/);
  });

  it("daemon.ts CALLS buildVideoHandlerDeps and threads videoHandlerDeps into the dispatch deps", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    expect(code).toMatch(/buildVideoHandlerDeps\s*\(/);
    // The handler deps must be spread into the ApiDispatchDeps object literal.
    expect(code).toMatch(/\bvideoHandlerDeps\b/);
  });

  it("daemon.ts threads videoGenProvider into setupTools (activates the video_generate tool)", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // The video_generate registry descriptor is gated on the videoGenProvider
    // context signal; daemon.ts must pass it to setupTools.
    expect(code).toMatch(/videoGenProvider/);
  });

  it("rpc-dispatch.ts imports createVideoHandlers and spreads it conditionally on videoHandlerDeps", () => {
    const content = readFileSync(RPC_DISPATCH_TS, "utf8");
    expect(content).toMatch(
      /import\s*\{[^}]*createVideoHandlers[^}]*\}\s*from\s*["']\.\/video-handlers\.js["']/,
    );
    const code = stripComments(content);
    // The conditional spread: ...(deps.videoHandlerDeps ? createVideoHandlers(...) : {})
    expect(code).toMatch(/deps\.videoHandlerDeps\s*\?[\s\S]*?createVideoHandlers\s*\(\s*deps\.videoHandlerDeps\s*\)/);
  });
});
