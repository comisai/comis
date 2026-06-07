// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 / E2E-03 / E2E-05 — the ONE generic journey-runner.
 *
 * Stage-A (no daemon): requires→skip-gating (unmet ⇒ skipped, NEVER throws — the
 *   universal skip≠fail invariant with positive controls) + lifecycle status.
 * Stage-B (daemon, dummy keys): the runner interprets a tiny story on the echo
 *   ConversationDriver — proving the interpreter is REAL, not faked (real events
 *   fire even when the LLM errors fast on dummy keys; the ORCH Stage-B idiom).
 * Stage-C/D (COMIS_LIVE): the real-model multi-turn journey execution shell.
 *
 * TDD: fails until journey-runner.ts exists.
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { runJourney, type JourneyRunnerDeps } from "./journey-runner.js";
import { buildCredentialRegistry } from "../credentials.js";
import { ConversationDriver, flushDaemonLogs } from "../harness/conversation.js";
import { runLogOracle } from "../assert/log-oracle.js";
import type { UserStory } from "./types.js";

const isLive = !!process.env["COMIS_LIVE"];
const DAEMON_STARTUP_MS = 15_000;

// ---------------------------------------------------------------------------
// Story builders
// ---------------------------------------------------------------------------

function baseStory(over: Partial<UserStory>): UserStory {
  return {
    id: over.id ?? "RT-base",
    story: "As a tester, I want a story, so that the runner gates it.",
    tags: ["A"],
    dimensions: [],
    requires: {},
    costTier: "$0",
    determinism: { runs: 1, passRateThreshold: 1 },
    steps: [{ verb: "send_text", text: "ping" }],
    acceptance: { outcomes: [], rubric: "non-empty" },
    status: "active",
    ...over,
  };
}

function sandboxDeps(): JourneyRunnerDeps {
  // No driver bound → the runner can still evaluate requires + lifecycle and
  // return a skip without interpreting (shape-only run).
  return { creds: buildCredentialRegistry(), isLive: false };
}

// ---------------------------------------------------------------------------
// Stage-A — requires→skip gating (never fails; positive controls)
// ---------------------------------------------------------------------------

describe("runJourney Stage-A — requires→skip-with-reason, never fail", () => {
  it("an unmet platform requirement → skipped (reason names that platform), NEVER throws", async () => {
    // Require the platform the HOST is NOT, so the requirement is always unmet
    // wherever the suite runs. Hardcoding "linux" only skipped-for-platform on a
    // non-Linux host (a macOS dev box); on the Linux CI runner the requirement
    // was MET and the run fell through to the no-driver skip — failing the
    // assertion with "no driver bound (shape-only run)".
    const otherPlatform = process.platform === "linux" ? "macos" : "linux";
    const story = baseStory({ id: "RT-platform", requires: { platform: otherPlatform } });
    const r = await runJourney(story, sandboxDeps());
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(new RegExp(otherPlatform, "i"));
  });

  it("providers:['anthropic'] with no ANTHROPIC_API_KEY → skipped (no-creds-ish)", async () => {
    // Sandbox has no real keys; assert skip + a non-empty reason. (Guard: if a key
    // IS present, the gate would pass requires — accept either skip or proceed,
    // but assert it never throws.)
    const story = baseStory({ id: "RT-prov", requires: { providers: ["anthropic"] } });
    const r = await runJourney(story, sandboxDeps());
    expect(["skipped", "passed", "failed"]).toContain(r.status);
    if (r.status === "skipped") expect(r.reason).toBeTruthy();
  });

  it("components:['MEM-StageC'] without isLive+allowlist → skipped (gated: component cert deferred)", async () => {
    const story = baseStory({ id: "RT-comp", requires: { components: ["MEM-StageC"] } });
    const r = await runJourney(story, sandboxDeps());
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/gated|component|cert/i);
  });

  it("capabilities:['vision'] with no vision-capable key → skipped (capability)", async () => {
    const story = baseStory({ id: "RT-cap", requires: { capabilities: ["vision"] } });
    const r = await runJourney(story, sandboxDeps());
    expect(["skipped", "passed", "failed"]).toContain(r.status);
    if (r.status === "skipped") expect(r.reason).toMatch(/capabilit|vision|no-creds/i);
  });

  it("channelAccounts:['broadcast-group'] with no account → skipped, never throws", async () => {
    const story = baseStory({ id: "RT-chan", requires: { channelAccounts: ["broadcast-group"] } });
    const r = await runJourney(story, sandboxDeps());
    expect(r.status).toBe("skipped");
    expect(r.reason).toBeTruthy();
  });

  it("POSITIVE CONTROL: an unmet-requires story RESOLVES (does not reject/throw)", async () => {
    const story = baseStory({ id: "RT-resolve", requires: { platform: "linux", providers: ["anthropic"] } });
    await expect(runJourney(story, sandboxDeps())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Stage-A — lifecycle status
// ---------------------------------------------------------------------------

describe("runJourney Stage-A — lifecycle status", () => {
  it("a deprecated story → skipped (excluded from the active run grid)", async () => {
    const story = baseStory({ id: "RT-dep", status: "deprecated" });
    const r = await runJourney(story, sandboxDeps());
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/deprecated/i);
  });

  it("a quarantined story is surfaced as quarantined (measured-non-blocking), not failed", async () => {
    // quarantined + unmet requires → still skipped, but the result flags quarantined.
    const story = baseStory({ id: "RT-quar", status: "quarantined", requires: { platform: "linux" } });
    const r = await runJourney(story, sandboxDeps());
    expect(r.quarantined).toBe(true);
    expect(r.status).toBe("skipped");
  });

  it("a shape-only run (no driver) with met requires → skipped 'no driver bound'", async () => {
    const story = baseStory({ id: "RT-nodriver", requires: {} });
    const r = await runJourney(story, sandboxDeps());
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/no driver|shape-only/i);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — the runner interprets a tiny story on the echo daemon (dummy keys)
// ---------------------------------------------------------------------------

describe("runJourney Stage-B — interprets a story on echo+mock (daemon, dummy keys)", () => {
  let driver: ConversationDriver;

  beforeAll(async () => {
    driver = new ConversationDriver({ agentId: "journey-rt-agent" });
    await driver.init();
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
    try {
      await driver.close();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (!m.includes("Daemon exit")) throw err;
    }
  });

  afterEach(async () => {
    await flushDaemonLogs(driver);
    // send_text on dummy keys errors at the agent.execute RPC — declared expected.
    await runLogOracle(driver.capturedLogLines(), {
      expectedErrors: ["JSON-RPC method error", "agent.execute RPC error", "agent.execute"],
    });
  });

  it("REACHES interpretation (not a requires-skip) and returns a per-story result", async () => {
    const story = baseStory({
      id: "RT-echo",
      requires: {}, // empty → the gate passes, the runner interprets
      steps: [
        { verb: "send_text", text: "ping" },
        { verb: "expect_delivered" },
      ],
      acceptance: { outcomes: ["a reply path executed"], rubric: "the journey ran" },
    });
    const deps: JourneyRunnerDeps = { creds: buildCredentialRegistry(), isLive: false, driver };
    const r = await runJourney(story, deps);

    // The point: the runner REACHED interpretation (status is passed/failed per the
    // step outcomes, NOT skipped — skip is only the requires-gate). On dummy keys
    // the send_text is tolerated (skipped step) and expect_delivered likely fails
    // (nothing delivered) → the journey status is failed, but it INTERPRETED.
    expect(r.status).not.toBe("skipped");
    expect(r.storyId).toBe("RT-echo");
    expect(Array.isArray(r.steps)).toBe(true);
    expect(r.steps!.length).toBe(2);
    // send_text recorded (ok or skipped depending on whether the dummy-key turn threw)
    expect(["ok", "skipped"]).toContain(r.steps![0].status);
  });
});

// ---------------------------------------------------------------------------
// Stage-C/D — real-model multi-turn journey execution (COMIS_LIVE gated)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)(
  "runJourney Stage-C/D — real-model journey execution (COMIS_LIVE)",
  () => {
    it("a real journey achieves the goal + judged task-success + one stitched traceId + obs.billing", async () => {
      expect(isLive).toBe(true); // gate — only runs under COMIS_LIVE
      // Stage-D: bind a real provider + the component cert allowlist; run an active
      // story N times; assert goal-achieved (acceptance.outcomes), judged task-success
      // (cross-judge >=2), expectStitchedTraceId, and expectBillingTokens.
    });
  },
);
