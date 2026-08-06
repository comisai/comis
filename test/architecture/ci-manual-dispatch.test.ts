// SPDX-License-Identifier: Apache-2.0
/**
 * Every webhook-driven gate workflow must also be manually dispatchable.
 *
 * `push` and `pull_request` runs exist only once GitHub delivers the webhook.
 * When GitHub sheds load it throttles those deliveries: an event may arrive
 * tens of minutes late, or never, and nothing observable distinguishes the two.
 * That failure is silent in the worst way — an absent run looks like a run that
 * has not started yet, and `mergeStateStatus` reports the PR as merely behind.
 *
 * The consequences are asymmetric per branch:
 *   - on a PR, `ci-success` is the required check, so a branch whose event was
 *     lost can never merge;
 *   - on `main`, the commit stays ungated for as long as the delivery is
 *     outstanding, with no way to bound the wait.
 *
 * Re-pushing the same SHA is a no-op, so without `workflow_dispatch` the only
 * recovery is an empty commit on the trunk. With it, one REST call is enough:
 *
 *   gh workflow run ci.yml --ref <branch>
 *
 * This is safe to add precisely because no job in these workflows branches on
 * `github.event_name` — a dispatched run does the same work as the webhook one.
 * That second half is what this test pins: adding an `event_name` condition
 * later would silently make a recovery run diverge from the run it stands in
 * for, which defeats the point.
 *
 * Static and cross-platform: parses YAML, runs no runner, hits no network.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Gate workflows whose runs are the record that a commit was checked. */
const GATE_WORKFLOWS = ["ci.yml", "codeql.yml"] as const;

interface Workflow {
  readonly on?: Record<string, unknown>;
  readonly jobs?: Record<string, unknown>;
}

function readWorkflow(file: string): { text: string; parsed: Workflow } {
  const text = readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8");
  return { text, parsed: parse(text) as Workflow };
}

describe("gate workflows are recoverable when a webhook is dropped", () => {
  it.each(GATE_WORKFLOWS)("%s declares workflow_dispatch", (file) => {
    const { parsed } = readWorkflow(file);

    // `on:` parses to an object here; a bare `on: push` shorthand would not
    // support manual dispatch at all, so demand the mapping form explicitly.
    expect(
      typeof parsed.on === "object" && parsed.on !== null,
      `${file}: expected an \`on:\` mapping so triggers can be enumerated`,
    ).toBe(true);

    expect(
      Object.keys(parsed.on ?? {}),
      `${file} has no \`workflow_dispatch\` trigger. A dropped push/pull_request ` +
        `webhook is never replayed, so the commit gets no run and there is no way ` +
        `to create one without an empty commit. Add \`workflow_dispatch:\` to \`on:\`.`,
    ).toContain("workflow_dispatch");
  });

  it.each(GATE_WORKFLOWS)("%s runs the same work however it was triggered", (file) => {
    const { text } = readWorkflow(file);

    // A dispatched run only substitutes for the dropped one if it does the same
    // work. Any `github.event_name` branch breaks that equivalence.
    const eventNameRefs = text
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes("github.event_name") && !line.startsWith("#"));

    expect(
      eventNameRefs.map(({ line, n }) => `${file}:${n}  ${line}`),
      `${file} branches on \`github.event_name\`. A \`workflow_dispatch\` run would ` +
        `then not be equivalent to the push/pull_request run it is recovering. Drive ` +
        `the difference off inputs or job conditions that hold for every trigger.`,
    ).toEqual([]);
  });
});
