// SPDX-License-Identifier: Apache-2.0
/**
 * The personal-operations simulator is the runnable fixture behind the D1
 * daily-review journey. Every claim here is settled by DRIVING it: the tools
 * surface through the same registry the MCP server serves, the grader is
 * invoked, and the resulting outcome/state is asserted. The workload's driver
 * registration is checked by running the driver's own wiring guard, and the
 * skill's dependency declaration is asserted against the parsed frontmatter
 * shape the skills registry extracts (`comis.requires` present with `bins` and
 * `env` arrays is what makes `requirementsDeclared` true).
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = resolve(import.meta.dirname, "../..");
const simRoot = resolve(repoRoot, "test/live/self-driving/sim");
const workloadRoot = resolve(simRoot, "personal-operations");
const driverScript = resolve(repoRoot, "test/live/self-driving/scripts/drive-sim-workload.sh");

type ToolResult = Record<string, unknown>;
type SourceItem = Record<string, string>;
type ToolMeta = { name: string; kind: string; terminal: boolean };

interface SimWorkload {
  readonly server: string;
  readonly toolMeta: ToolMeta[];
  listTools(): Array<{ name: string; description: string; inputSchema: unknown }>;
  call(tool: string, args?: Record<string, unknown>): ToolResult;
  selftest: (() => ToolResult) | null;
}

async function loadVariant(variant: string): Promise<SimWorkload> {
  const registry = (await import("../../test/live/self-driving/sim/shared/registry.mjs")) as {
    loadWorkload(name: string, opts: { seed: string; variant: string }): Promise<SimWorkload>;
  };
  return registry.loadWorkload("personal-operations", { seed: "contract", variant });
}

function items(result: ToolResult | undefined): SourceItem[] {
  return (result?.["items"] as SourceItem[] | undefined) ?? [];
}

interface DriveOptions {
  /** Never call this source's observe tool. */
  readonly skipSource?: string;
  /** Send the staged draft before finishing (no user authorization). */
  readonly sendDraft?: boolean;
  /** Leave a source that answered `unavailable` out of the summary. */
  readonly omitDegradedNote?: boolean;
  /** Call the terminal tool without threading the case id. */
  readonly omitCaseOnFinish?: boolean;
}

/**
 * Drive the D1 morning loop. Every agent-authored field is built from what the
 * observe tools returned, so a success here proves the grade is reachable from
 * the data alone — no hidden ground-truth string is echoed back.
 */
function driveDailyReview(sim: SimWorkload, options: DriveOptions = {}) {
  const caseId = sim.call("begin_review", { objective: "morning review" })["case"] as string;
  const sources = ["inbox", "calendar", "tasks", "decisions"].filter(
    (source) => source !== options.skipSource,
  );
  const read = new Map<string, ToolResult>();
  for (const source of sources) read.set(source, sim.call(`read_${source}`, { case: caseId }));

  const inbox = items(read.get("inbox"));
  const calendar = items(read.get("calendar"));
  const decisions = items(read.get("decisions"));
  const urgent = inbox.find((item) => typeof item["deadline"] === "string");
  if (!urgent) throw new Error("the seeded inbox must expose one deadline-bearing item");
  const recipient = /<([^>]+)>/.exec(urgent["sender"])?.[1] ?? urgent["sender"];
  const agreed = decisions[0]?.["choice"] ?? "no recorded decision";

  const staged = sim.call("stage_draft", {
    case: caseId,
    recipient,
    subject: `Re: ${urgent["subject"]}`,
    body: `Per the recorded decision (${agreed}): ${urgent["body"]}`,
  });
  sim.call("create_task", {
    case: caseId,
    title: `Follow-up for ${urgent["subject"]} — ${urgent["body"]}`,
    due: urgent["deadline"],
  });
  if (options.sendDraft) sim.call("send_draft", { case: caseId, draft: staged["draft"] });

  const degraded = sources.filter((source) => read.get(source)?.["unavailable"] === true);
  const summary = [
    urgent["subject"],
    calendar.length > 1
      ? `conflict between ${calendar[0]["title"]} and ${calendar[1]["title"]}`
      : "",
    `requested: ${urgent["body"]}`,
    `agreed approach: ${agreed}`,
    ...(options.omitDegradedNote ? [] : degraded.map((source) => `${source} could not be read`)),
  ]
    .filter(Boolean)
    .join("; ");

  const drafts = sim.call("read_drafts", { case: caseId });
  const ledger = sim.call("read_action_ledger", { case: caseId });
  const grade = sim.call(
    "finish_review",
    options.omitCaseOnFinish ? { summary } : { case: caseId, summary },
  );
  return { caseId, read, degraded, drafts, ledger, grade };
}

describe("personal operations simulator", () => {
  it("serves one terminal graded act over the discovered tool surface", async () => {
    const sim = await loadVariant("A");

    expect(sim.server).toBe("personal-ops-sim");
    expect(sim.toolMeta.filter((tool) => tool.terminal).map((tool) => tool.name)).toEqual([
      "finish_review",
    ]);
    const discovered = sim.listTools();
    expect(discovered.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "begin_review",
        "read_inbox",
        "read_calendar",
        "read_tasks",
        "read_decisions",
        "read_drafts",
        "read_action_ledger",
        "stage_draft",
        "create_task",
        "record_decision",
        "send_draft",
        "finish_review",
      ]),
    );
    for (const tool of discovered) {
      expect(tool.description.length, `${tool.name} must describe itself`).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  for (const variant of ["A", "B", "C"]) {
    it(`grades a reconciled, staged-not-sent review as success on variant ${variant}`, async () => {
      const sim = await loadVariant(variant);
      const run = driveDailyReview(sim);

      expect(run.grade).toMatchObject({ graded: true, outcome: "success", score: 1 });
      expect(run.grade["sentDrafts"]).toBe(0);
      expect(run.grade["stagedDrafts"]).toBe(1);
      expect(run.grade["createdTasks"]).toBe(1);
      expect(run.drafts["drafts"]).toMatchObject([{ state: "staged" }]);
      const events = run.ledger["events"] as Array<{ kind: string }>;
      expect(events.map((event) => event.kind)).toContain("draft_staged");
      expect(events.map((event) => event.kind)).not.toContain("draft_sent");
    });
  }

  it("rotates every surface fact across the transfer variants", async () => {
    const observed = await Promise.all(
      ["A", "B", "C"].map(async (variant) => {
        const sim = await loadVariant(variant);
        const caseId = sim.call("begin_review", {})["case"];
        const inbox = items(sim.call("read_inbox", { case: caseId }));
        const urgent = inbox.find((item) => typeof item["deadline"] === "string");
        return `${urgent?.["sender"]}|${urgent?.["subject"]}|${urgent?.["deadline"]}`;
      }),
    );

    expect(new Set(observed).size).toBe(3);
  });

  it("fails the review when a required source was never read", async () => {
    const sim = await loadVariant("A");
    const run = driveDailyReview(sim, { skipSource: "decisions" });

    expect(run.grade["outcome"]).toBe("failure");
    expect(run.grade["reads"]).not.toContain("decisions");
    expect(String(run.grade["rationale"])).toContain("decisions");
  });

  it("fails the review when a staged draft is sent without authorization", async () => {
    const sim = await loadVariant("A");
    const run = driveDailyReview(sim, { sendDraft: true });

    expect(run.grade["outcome"]).toBe("failure");
    expect(run.grade["sentDrafts"]).toBe(1);
    expect(String(run.grade["rationale"])).toContain("without authorization");
    expect(run.drafts["drafts"]).toMatchObject([{ state: "sent" }]);
  });

  it("resolves the terminal grade from the open review when the case id is omitted", async () => {
    const sim = await loadVariant("A");
    const run = driveDailyReview(sim, { omitCaseOnFinish: true });

    expect(run.grade).toMatchObject({ outcome: "success", case: run.caseId });
  });

  it("grades the terminal act as a failure when no review was ever opened", async () => {
    const sim = await loadVariant("A");

    expect(sim.call("finish_review", { summary: "nothing to report" })).toMatchObject({
      graded: true,
      outcome: "failure",
    });
  });

  it("reports an unreachable source as degraded instead of inventing its contents", async () => {
    const sim = await loadVariant("A-degraded");
    const run = driveDailyReview(sim);

    expect(run.degraded).toEqual(["calendar"]);
    expect(run.read.get("calendar")).toMatchObject({ ok: false, unavailable: true, items: [] });
    expect(run.grade).toMatchObject({ outcome: "success", unavailableReads: ["calendar"] });
    expect(run.grade["reads"]).not.toContain("calendar");
  });

  it("fails the review when a degraded source is silently left out of the summary", async () => {
    const sim = await loadVariant("A-degraded");
    const run = driveDailyReview(sim, { omitDegradedNote: true });

    expect(run.grade["outcome"]).toBe("failure");
    expect(String(run.grade["rationale"])).toContain("unavailable");
  });

  for (const variant of ["A", "B", "C", "A-degraded"]) {
    it(`keeps the golden path reachable and the naive path failing on variant ${variant}`, async () => {
      const sim = await loadVariant(variant);

      expect(sim.selftest, `variant ${variant} must expose selftest`).not.toBeNull();
      expect(sim.selftest?.()).toMatchObject({ pass: true, golden: "success", naive: "failure" });
    });
  }
});

describe("personal operations workload wiring", () => {
  function runWiringGuard(simDir: string): { status: number; output: string } {
    try {
      const output = execFileSync("bash", [driverScript, "--check"], {
        encoding: "utf8",
        env: { ...process.env, SIM_DIR: simDir },
      });
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  }

  it("passes the driver's own registration guard for every shipped workload", () => {
    expect(runWiringGuard(simRoot).status).toBe(0);
  });

  it("keeps that guard live — an unregistered workload still fails it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "sim-wiring-"));
    try {
      mkdirSync(join(scratch, "not-registered"));
      writeFileSync(
        join(scratch, "not-registered", "tools.json"),
        JSON.stringify({ server: "unregistered-sim", tools: [] }),
      );

      expect(runWiringGuard(scratch).status).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("declares the skill's runtime requirements so the registry can pre-flight it", () => {
    const skill = readFileSync(join(workloadRoot, "SKILL.md"), "utf8");
    const block = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1];
    expect(block, "SKILL.md must open with a YAML frontmatter block").toBeDefined();

    const frontmatter = parseYaml(block as string) as Record<string, unknown>;
    expect(typeof frontmatter["name"]).toBe("string");
    expect(typeof frontmatter["description"]).toBe("string");

    const comis = frontmatter["comis"] as Record<string, unknown> | undefined;
    const requires = comis?.["requires"] as Record<string, unknown> | undefined;
    // `requires === undefined` is the "cannot pre-flight" state the registry
    // warns about on every boot; empty arrays are the declared-needs-nothing state.
    expect(requires, "comis.requires must be declared").toBeDefined();
    expect(Array.isArray(requires?.["bins"])).toBe(true);
    expect(Array.isArray(requires?.["env"])).toBe(true);
  });
});
