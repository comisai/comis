// SPDX-License-Identifier: Apache-2.0
/**
 * Anti-dormancy wiring guard for the durable-resume + deterministic-replay seams.
 *
 * The durable/resume/replay logic is fully unit-tested against injected seams, but
 * a feature that is never THREADED at the composition root ships DEAD (the recurring
 * "seam populated in a helper but never called in daemon.ts" failure). Plans 03/04/06
 * deliberately left three seams dormant; this suite pins that the composition root
 * now populates all three, so a future refactor that drops a thread fails HERE (on
 * the macOS floor) rather than silently reverting the feature to dormant:
 *
 *   1. the orchestrate runner's `durableRuns` seam is threaded (setup-tools.ts →
 *      buildAutonomyToolWiring), gated on `orchestrateResume`;
 *   2. the M2 boot-sweep's orchestrate-kind arm + orphan reclaim cluster is populated
 *      (daemon.ts → buildOrchestrateResumeWiring → buildDurableResume.orchestrateResume);
 *   3. the `orchestrate.replay` RPC's re-spawn seam is assembled (daemon.ts →
 *      createOrchestrateReplayRespawn → OrchestratorApiDeps.orchestrateReplay);
 *   4. the content-free replay RECORDER is built + injected into the capability
 *      endpoint at the boot layer (setup-capability-endpoint-boot.ts →
 *      createReplayRecorder → createCapabilityEndpoint({ …, replayRecorder })).
 *      Without this the ONLY writer of `results/replay.jsonl` has no production
 *      caller, so `recordReplay` short-circuits and a replay of any real run
 *      diverges on its first cap call (the recorder ships dormant).
 *
 * These are SOURCE assertions (mirrors the daemon.ts line-cap + api-dir arch tests):
 * the real end-to-end jailed round-trip is the VPS/`.linux` tier, but the WIRING
 * being present is provable on macOS.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const DAEMON_TS = readFileSync(resolve(SRC_ROOT, "daemon.ts"), "utf8");
const SETUP_TOOLS = readFileSync(resolve(SRC_ROOT, "wiring", "setup-tools.ts"), "utf8");
const SETUP_TOOLS_AUTONOMY = readFileSync(resolve(SRC_ROOT, "wiring", "setup-tools-autonomy.ts"), "utf8");
const SETUP_CAP_BOOT = readFileSync(resolve(SRC_ROOT, "wiring", "setup-capability-endpoint-boot.ts"), "utf8");

describe("orchestrate durable-resume + replay composition-root wiring (anti-dormancy)", () => {
  describe("seam 1 — durableRuns → the orchestrate runner (RESUME-02)", () => {
    it("setup-tools.ts threads the durable-run store into buildAutonomyToolWiring", () => {
      // Without this thread the runner never receives the store → a resume-enabled
      // agent's timed-out run writes NO resumable row (the feature ships dormant).
      expect(SETUP_TOOLS).toContain("buildAutonomyToolWiring({");
      expect(
        /durableRuns:\s*deps\.durableRuns/.test(SETUP_TOOLS),
        "setup-tools.ts must pass `durableRuns: deps.durableRuns` into buildAutonomyToolWiring — else the orchestrate runner is never resumable.",
      ).toBe(true);
    });

    it("buildAutonomyToolWiring forwards durableRuns ONLY under the orchestrateResume surface gate", () => {
      // The gate (deny-by-absence) keeps a default-off agent byte-identical.
      expect(
        /orchestrateResume/.test(SETUP_TOOLS_AUTONOMY),
        "setup-tools-autonomy.ts must gate the durableRuns forward on autonomy.durability.orchestrateResume.",
      ).toBe(true);
      expect(
        /durableRuns:\s*input\.durableRuns/.test(SETUP_TOOLS_AUTONOMY),
        "setup-tools-autonomy.ts must forward input.durableRuns into createOrchestrateTool.",
      ).toBe(true);
    });
  });

  describe("seam 2 — the orchestrateResume boot-sweep + reclaim cluster (RESUME-03/04)", () => {
    it("daemon.ts populates buildDurableResume.orchestrateResume via buildOrchestrateResumeWiring", () => {
      // Without the cluster a resumable orchestrate row degrades to a flat re-anchor
      // on boot — no pinned-artifact verification, no honest orphan, no reclaim.
      expect(
        DAEMON_TS.includes("buildOrchestrateResumeWiring("),
        "daemon.ts must call buildOrchestrateResumeWiring to build the boot-sweep + reclaim cluster.",
      ).toBe(true);
      expect(
        /orchestrateResume:\s*buildOrchestrateResumeWiring\(/.test(DAEMON_TS),
        "daemon.ts must pass the cluster as buildDurableResume's `orchestrateResume` field.",
      ).toBe(true);
    });
  });

  describe("seam 3 — the orchestrate.replay re-spawn seam (REPLAY-02)", () => {
    it("daemon.ts assembles OrchestratorApiDeps.orchestrateReplay via createOrchestrateReplayRespawn", () => {
      // Without this the orchestrate.replay RPC is never registered (rpc-dispatch
      // gates the handler on the cluster) → `comis orchestrate replay` is dead.
      expect(
        DAEMON_TS.includes("createOrchestrateReplayRespawn("),
        "daemon.ts must assemble the sandbox-backed pinned-byte re-spawn seam.",
      ).toBe(true);
      expect(
        /orchestrateReplay:\s*\{/.test(DAEMON_TS),
        "daemon.ts must set OrchestratorApiDeps.orchestrateReplay so rpc-dispatch registers orchestrate.replay.",
      ).toBe(true);
    });
  });

  describe("seam 4 — the content-free replay recorder → the capability endpoint (REPLAY-01)", () => {
    it("setup-capability-endpoint-boot.ts builds the recorder via createReplayRecorder", () => {
      // createReplayRecorder is the SOLE writer of results/replay.jsonl. Without a
      // production caller, recordReplay short-circuits on every dispatch → replay
      // diverges on the first cap call of any real run (the recorder ships dormant).
      expect(
        SETUP_CAP_BOOT.includes("createReplayRecorder("),
        "setup-capability-endpoint-boot.ts must build the recorder via createReplayRecorder — else results/replay.jsonl is never written.",
      ).toBe(true);
    });

    it("injects the recorder into the endpoint as createCapabilityEndpoint({ …, replayRecorder })", () => {
      // The endpoint's recordReplay is a no-op unless the `replayRecorder` dep is
      // passed at construction — pin the injection so a refactor cannot drop it.
      expect(
        /replayRecorder/.test(SETUP_CAP_BOOT),
        "setup-capability-endpoint-boot.ts must pass replayRecorder into createCapabilityEndpoint — else the recorder is built but never observed.",
      ).toBe(true);
    });
  });
});
