// SPDX-License-Identifier: Apache-2.0
/**
 * Built-but-not-wired SOURCE GUARD for skill-synthesis clustering embeddings
 * (RC-1 / SYNTH-EMBED-DEAD, live incident 2026-06-25). Mirrors
 * `audio-wiring-guard.test.ts` — a shrink-only source-grep, no allowlist.
 *
 * THE BUG THIS PINS: `runSkillSynthesis` clusters successful trajectories by cosine
 * similarity of their `embedding`; a trajectory with NO embedding is a singleton, so
 * `maxClusterCardinality` is always 1 and NOTHING is ever admitted. The clustering
 * logic + its unit tests were green (the tests inject embeddings in fixtures), but the
 * daemon's `buildSourceTrajectories` never attached one — so skill synthesis was DEAD
 * in production for months, mis-diagnosed three times as "needs more corroboration."
 *
 * The embedder (`cachedPort`) is deliberately kept OFF `AppContainer` (the
 * agent-accessible path — daemon-types.ts isolation boundary), so it is THREADED
 * explicitly: daemon.ts (`embeddingPort: cachedPort`) → setup-channels-registry.ts
 * (forward into the cron deps) → setup-channels-skill-synthesis-deps.ts (consume in
 * buildSourceTrajectories). These assertions pin every hop so a future refactor cannot
 * silently drop the thread without turning this test RED.
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
const REGISTRY_TS = resolve(REPO_ROOT, "packages/daemon/src/wiring/setup-channels/setup-channels-registry.ts");
const SYNTH_DEPS_TS = resolve(REPO_ROOT, "packages/daemon/src/wiring/setup-channels/setup-channels-skill-synthesis-deps.ts");

/** Strip comments so a token inside a comment cannot satisfy a wiring assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

describe("skill-synthesis clustering-embedding built-but-not-wired source guard (RC-1)", () => {
  it("daemon.ts threads the embedder (cachedPort) into the channel/cron deps as embeddingPort", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // The boot source: cachedPort must be destructured AND forwarded as embeddingPort
    // into the channel-manager deps that become the cron deps. Without this the synthesis
    // source builder receives undefined → singletons → admit:0 forever.
    expect(code).toMatch(/embeddingPort:\s*cachedPort/);
  });

  it("setup-channels-registry.ts forwards embeddingPort into the cron-listener deps (the relay hop)", () => {
    const code = stripComments(readFileSync(REGISTRY_TS, "utf8"));
    expect(code).toMatch(/embeddingPort:\s*deps\.embeddingPort/);
  });

  it("buildSourceTrajectories CONSUMES the threaded embedder to attach clustering embeddings", () => {
    const code = stripComments(readFileSync(SYNTH_DEPS_TS, "utf8"));
    // The builder must CALL the embedding-attach with the threaded port (not just declare
    // the field). The attach must run on the built trajectories (out) before they are
    // returned, passing the threaded `deps.embeddingPort` (the middle arg is the RC-2 signatures).
    expect(code).toMatch(/attachClusteringEmbeddings\s*\(\s*out\s*,[^)]*deps\.embeddingPort\s*\)/);
    // …and the attach helper must actually embed (embedBatch) + set the embedding field —
    // a no-op helper would re-introduce the dead path.
    expect(code).toMatch(/\.embedBatch\s*\(/);
    expect(code).toMatch(/\.embedding\s*=/);
  });
});
