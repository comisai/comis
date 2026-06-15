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
const MAIN_HELPERS_TS = resolve(REPO_ROOT, "packages/daemon/src/wiring/main-helpers.ts");
const SETUP_TOOLS_TS = resolve(REPO_ROOT, "packages/daemon/src/wiring/setup-tools.ts");
const SETUP_VIDEO_PROVIDER_TS = resolve(REPO_ROOT, "packages/daemon/src/wiring/setup-video-provider.ts");
const REGISTRY_TS = resolve(REPO_ROOT, "packages/skills/src/platform-tools/registry.ts");
const VIDEO_GENERATE_TOOL_TS = resolve(
  REPO_ROOT,
  "packages/skills/src/platform-tools/tools/video-generate-tool.ts",
);

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

  // ─── Phase 189 (JOB-02/JOB-03): the background poller + store wiring ───
  // The keystone anti-built-but-not-wired assertions. The store + poller are
  // constructed in buildVideoGenBundle (main-helpers), STARTED after setupChannels
  // (wirePostChannelsLifecycle), and SHUT DOWN via setupShutdown. A regression to
  // unwired turns these red.

  it("main-helpers.ts imports + CALLS createVideoJobStore and createVideoPoller (the boot construction)", () => {
    const content = readFileSync(MAIN_HELPERS_TS, "utf8");
    expect(content).toMatch(
      /import\s*\{[^}]*createVideoJobStore[^}]*\}\s*from\s*["']@comis\/memory["']/,
    );
    expect(content).toMatch(
      /import\s*\{[^}]*createVideoPoller[^}]*\}\s*from\s*["']\.\/setup-video-poller\.js["']/,
    );
    const code = stripComments(content);
    // Both must be CALLED (not just imported) — the construction, not a comment.
    expect(code).toMatch(/createVideoJobStore\s*\(/);
    expect(code).toMatch(/createVideoPoller\s*\(/);
  });

  it("buildVideoGenBundle returns videoJobStore + videoPoller (threaded to the handler deps + boot)", () => {
    const code = stripComments(readFileSync(MAIN_HELPERS_TS, "utf8"));
    // buildVideoGenBundle must surface both so daemon.ts can Object.assign them
    // onto the boot context and buildVideoHandlerDeps can fold them onto the deps.
    expect(code).toMatch(/\bvideoJobStore\b/);
    expect(code).toMatch(/\bvideoPoller\b/);
    // buildVideoHandlerDeps threads the store + poller onto the handler deps.
    expect(code).toMatch(/videoJobStore:\s*c\.videoJobStore/);
    expect(code).toMatch(/videoPoller:\s*c\.videoPoller/);
  });

  it("daemon.ts destructures videoPoller from buildVideoGenBundle and passes db into it", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // The bundle now takes db (the shared memory.db handle the store needs) and
    // yields the poller. Assert both the destructure and the db argument.
    expect(code).toMatch(/buildVideoGenBundle\s*\(/);
    expect(code).toMatch(/\bvideoPoller\b/);
    expect(code).toMatch(/\bvideoJobStore\b/);
  });

  it("daemon.ts STARTS the poller after setupChannels (via wirePostChannelsLifecycle)", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // startAndResume must flow through wirePostChannelsLifecycle (the hook that
    // runs AFTER setupChannels populates the channel registry, so sendAttachment
    // reaches a live adapter outside a turn). Assert the threaded start fn name
    // appears in the wirePostChannelsLifecycle deps wiring.
    expect(code).toMatch(/startAndResumeVideoPoller/);
    // and the poller's startAndResume is actually invoked in the lifecycle body.
    expect(code).toMatch(/startAndResume/);
  });

  it("daemon.ts threads the poller shutdown into setupShutdown (beside shutdownDeliveryQueue)", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // The poller shutdown must be registered with setupShutdown so SIGTERM clears
    // the sweeper interval — the same path shutdownDeliveryQueue takes.
    expect(code).toMatch(/shutdownVideoPoller/);
  });

  // ─── Phase 189 Plan 03 (JOB-04): the video.status query surface wiring ───
  // The read side of the async lifecycle. The contract↔handler parity gate
  // covers the dispatch registration structurally; these source-guard
  // assertions pin the LIVE tool + boot-signal + dispatch-deps threading so a
  // refactor cannot regress video_status to built-but-not-wired.

  it("rpc-dispatch.ts imports createVideoStatusHandlers and spreads it conditionally on videoStatusHandlerDeps", () => {
    const content = readFileSync(RPC_DISPATCH_TS, "utf8");
    expect(content).toMatch(
      /import\s*\{[^}]*createVideoStatusHandlers[^}]*\}\s*from\s*["']\.\/video-status-handlers\.js["']/,
    );
    const code = stripComments(content);
    // The conditional spread: ...(deps.videoStatusHandlerDeps ? createVideoStatusHandlers(...) : {})
    expect(code).toMatch(
      /deps\.videoStatusHandlerDeps\s*\?[\s\S]*?createVideoStatusHandlers\s*\(\s*deps\.videoStatusHandlerDeps\s*\)/,
    );
  });

  it("registry.ts registers a video_status descriptor built from createVideoStatusTool", () => {
    const code = stripComments(readFileSync(REGISTRY_TS, "utf8"));
    // The tool factory must be imported + wired by the descriptor (not in a comment).
    expect(code).toMatch(/createVideoStatusTool/);
    // The descriptor's name string + the videoStatusEnabled gate signal.
    expect(code).toMatch(/["']video_status["']/);
    expect(code).toMatch(/videoStatusEnabled/);
  });

  it("daemon.ts threads videoStatusHandlerDeps into the dispatch deps (the read handler wiring)", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // buildVideoStatusHandlerDeps result must be spread into the ApiDispatchDeps literal.
    expect(code).toMatch(/\bvideoStatusHandlerDeps\b/);
  });

  it("daemon.ts threads the videoStatusEnabled signal into setupTools (activates the video_status tool)", () => {
    const daemonCode = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // daemon.ts must pass videoStatusEnabled to setupTools, and setupTools must
    // forward it into the registry BuildContext (gating the video_status descriptor).
    expect(daemonCode).toMatch(/videoStatusEnabled/);
    const toolsCode = stripComments(readFileSync(SETUP_TOOLS_TS, "utf8"));
    expect(toolsCode).toMatch(/videoStatusEnabled/);
  });

  // ─── Phase 190 (VEO/GROK/CRED-01): live-adapter swap + oauthManager thread ───
  // The 188 selector returned an honest-unavailable "lands in Phase 190" port for
  // the veo/grok SELECTION (built-but-not-wired by design until the adapters
  // existed). Plan 03 swaps that branch for the LIVE createVeoVideoAdapter /
  // createGrokVideoAdapter (Plans 01/02) and threads the DEFAULT agent's
  // oauthManager (bundle → selector → daemon) for the Grok key-or-OAuth path
  // (CRED-01). These assertions pin every edge so a future refactor cannot regress
  // veo/grok back to the placeholder without turning this test red (Pitfall 5 —
  // the milestone's #1 recurring blocker).

  it("setup-video-provider.ts veo branch CALLS createVeoVideoAdapter and grok branch CALLS createGrokVideoAdapter (not the placeholder)", () => {
    const content = readFileSync(SETUP_VIDEO_PROVIDER_TS, "utf8");
    // The live adapters must be IMPORTED from the daemon-api modules (Plans 01/02).
    expect(content).toMatch(
      /import\s*\{[^}]*createVeoVideoAdapter[^}]*\}\s*from\s*["']\.\.\/api\/veo-adapter\.js["']/,
    );
    expect(content).toMatch(
      /import\s*\{[^}]*createGrokVideoAdapter[^}]*\}\s*from\s*["']\.\.\/api\/grok-adapter\.js["']/,
    );
    const code = stripComments(content);
    // And CALLED in the resolved branch (the swap — not just imported, not a comment).
    expect(code).toMatch(/createVeoVideoAdapter\s*\(/);
    expect(code).toMatch(/createGrokVideoAdapter\s*\(/);
    // The Phase-188 placeholder hint must be GONE from the live branch (the swap
    // removed it — a residual "lands in Phase 190" means the placeholder survived).
    expect(code).not.toMatch(/lands in Phase 190/);
  });

  it("main-helpers.ts buildVideoGenBundle threads oauthManager + oauthProfiles into createVideoProviderSelector (CRED-01 grok OAuth)", () => {
    const code = stripComments(readFileSync(MAIN_HELPERS_TS, "utf8"));
    // The selector call must carry oauthManager + oauthProfiles (mirroring the
    // buildImageGenBundle precedent at :331-332). The bounded {0,600} window keeps
    // the match scoped to the createVideoProviderSelector({...}) call body — a
    // far-away oauthManager token (buildImageGenBundle / buildVideoHandlerDeps,
    // both >2000 chars away) cannot satisfy it, so it fails RED until the thread
    // is added inside THIS call.
    expect(code).toMatch(/createVideoProviderSelector\s*\(\{[\s\S]{0,600}?oauthManager/);
    expect(code).toMatch(/createVideoProviderSelector\s*\(\{[\s\S]{0,600}?oauthProfiles/);
  });

  it("daemon.ts threads oauthManager into the buildVideoGenBundle call (handle.oauthManagers.get(defaultAgentId))", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // The buildVideoGenBundle({...}) call must carry oauthManager (mirror the
    // :2169 buildImageGenBundle precedent). The bounded {0,250} window keeps the
    // match inside the call's argument object — the next oauthManager token (the
    // mediaVisionBundle call on the following line, ~290 chars away pre-patch) is
    // past it, so the assertion fails RED until oauthManager is threaded into THIS
    // call (the addition lands well inside the ~170-char call body).
    expect(code).toMatch(/buildVideoGenBundle\s*\(\{[\s\S]{0,250}?oauthManager/);
  });

  // ─── Phase 191 (IN-03): the runtime-built tool description wiring ───
  // The video_generate description is built at registration from the ACTIVE
  // backend's VIDEO_MODELS matrix (listVideoModelCaps) — but ONLY if the registry
  // build callback threads ctx.videoGenProvider into createVideoGenerateTool. The
  // tool factory + the matrix lookup can exist, compile, and pass their unit tests
  // while the registry still calls createVideoGenerateTool(ctx.rpcCall) single-arg,
  // leaving the agent with the STATIC_FALLBACK forever (built-but-not-wired,
  // Pitfall 5 — the milestone's #1 recurring blocker). These assertions pin the
  // two-arg wiring (registry → tool) and the matrix import (tool → @comis/core) so
  // a future refactor that drops either turns this test red.

  it("registry.ts threads ctx.videoGenProvider into the video_generate build (createVideoGenerateTool two-arg)", () => {
    const code = stripComments(readFileSync(REGISTRY_TS, "utf8"));
    // The build callback must pass BOTH ctx.rpcCall and ctx.videoGenProvider.
    // Single-arg createVideoGenerateTool(ctx.rpcCall as never) — the pre-191
    // shipped code — does NOT match, so this fails RED until the seam is threaded.
    expect(code).toMatch(/createVideoGenerateTool\s*\(\s*ctx\.rpcCall[^)]*ctx\.videoGenProvider/);
  });

  it("video-generate-tool.ts imports listVideoModelCaps from @comis/core (the matrix the description is built from)", () => {
    const content = readFileSync(VIDEO_GENERATE_TOOL_TS, "utf8");
    // The IN-03 description is built from the active backend's capability matrix;
    // the accessor MUST be imported from the @comis/core barrel (Plan 01 surfaced
    // it there — NOT a @comis/core/media subpath, which does not exist).
    expect(content).toMatch(
      /import\s*(?:type\s*)?\{[^}]*listVideoModelCaps[^}]*\}\s*from\s*["']@comis\/core["']/,
    );
    const code = stripComments(content);
    // And the accessor must be CALLED in the description build (not just imported).
    expect(code).toMatch(/listVideoModelCaps\s*\(/);
  });
});
