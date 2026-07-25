// SPDX-License-Identifier: Apache-2.0
/**
 * Render-branch tests for IcSubAgentsView.
 *
 * Targets the render() decision tree (loading/error/empty/populated) +
 * the per-run card branches (completedAt/result/error/canKill) + the
 * pure helpers (_truncate, _statusColor, _formatDuration).
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import type { IcSubagentsView } from "./subagents.js";
import "./subagents.js";

type IcSubAgentsView = IcSubagentsView;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(el: IcSubagentsView): any {
  return el as unknown as Record<string, unknown>;
}

describe("IcSubAgentsView pure helpers", () => {
  let el: IcSubagentsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("_truncate returns the original string unchanged when shorter than the max length", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    expect(priv(el)._truncate("hello", 10)).toBe("hello");
  });

  it("_truncate appends the horizontal ellipsis character when string exceeds the max length", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    const out = priv(el)._truncate("hello-world", 5);
    expect(out).toBe("hello…");
  });

  it("_statusColor returns 'blue' for the running status branch", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    expect(priv(el)._statusColor("running")).toBe("blue");
  });

  it("_statusColor returns 'green' for the completed status branch", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    expect(priv(el)._statusColor("completed")).toBe("green");
  });

  it("_statusColor returns 'red' for the failed status branch", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    expect(priv(el)._statusColor("failed")).toBe("red");
  });

  it("_statusColor returns 'yellow' for the queued status branch", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    expect(priv(el)._statusColor("queued")).toBe("yellow");
  });

  it("_statusColor returns 'default' for any unknown status value falling to the default branch", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    expect(priv(el)._statusColor("unrecognized-state")).toBe("default");
  });

  it("_formatDuration returns ms format when delta is sub-second", () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    expect(priv(el)._formatDuration(0, 500)).toBe("500ms");
  });

  it("_formatDuration returns seconds format with 1 decimal when delta is under one minute", () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    expect(priv(el)._formatDuration(0, 12_500)).toBe("12.5s");
  });

  it("_formatDuration returns minutes format with 1 decimal when delta is at least one minute", () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    expect(priv(el)._formatDuration(0, 90_000)).toBe("1.5m");
  });
});

describe("IcSubAgentsView render() — top-level branches", () => {
  let el: IcSubAgentsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the skeleton dashboard template while load state is 'loading'", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    await el.updateComplete;
    const skel = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(skel?.getAttribute("variant")).toBe("dashboard");
  });

  it("renders the error-message template + retry button when load state is 'error'", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "error";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".error-message")).not.toBeNull();
    expect(el.shadowRoot?.querySelector(".retry-btn")).not.toBeNull();
  });

  it("renders the ic-empty-state when load completes with zero sub-agent runs", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-empty-state")).not.toBeNull();
  });

  it("renders the run-list container when at least one sub-agent run is present", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-1",
        agentId: "alpha",
        task: "A simple task",
        status: "running",
        startedAt: 1_000,
        depth: 0,
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".run-list")).not.toBeNull();
  });

  it("renders the kill confirm dialog with open=true when _confirmKillRunId is non-null", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [];
    priv(el)._confirmKillRunId = "to-kill";
    await el.updateComplete;
    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect(dialog?.hasAttribute("open")).toBe(true);
  });
});

describe("IcSubAgentsView _renderRun — per-run card branches", () => {
  let el: IcSubAgentsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders a kill button when run status is 'running' allowing termination of in-flight runs", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-2",
        agentId: "alpha",
        task: "task",
        status: "running",
        startedAt: 100,
        depth: 0,
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".kill-btn")).not.toBeNull();
  });

  it("renders a kill button when run status is 'queued' since queued runs can be cancelled", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-3",
        agentId: "alpha",
        task: "task",
        status: "queued",
        startedAt: 100,
        depth: 0,
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".kill-btn")).not.toBeNull();
  });

  it("omits the kill button when run status is 'completed' (terminal state cannot be killed)", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-4",
        agentId: "alpha",
        task: "task",
        status: "completed",
        startedAt: 100,
        completedAt: 200,
        depth: 0,
        result: {
          tokensUsed: { total: 5_000 },
          cost: { total: 0.0125 },
          stepsExecuted: 3,
        },
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".kill-btn")).toBeNull();
  });

  it("renders the duration meta when run.completedAt is set indicating run has terminated", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-5",
        agentId: "alpha",
        task: "task",
        status: "completed",
        startedAt: 0,
        completedAt: 1500,
        depth: 0,
      },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Duration:");
  });

  it("renders the tokens/cost/steps meta block when run.result is present (result branch)", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-6",
        agentId: "alpha",
        task: "task",
        status: "completed",
        startedAt: 0,
        completedAt: 2000,
        depth: 2,
        result: {
          tokensUsed: { total: 12345 },
          cost: { total: 0.5 },
          stepsExecuted: 5,
        },
      },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Tokens:");
    expect(html).toContain("Cost:");
    expect(html).toContain("Steps:");
  });

  it("renders the run-error message div when run.error is set indicating failure", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-7",
        agentId: "beta",
        task: "task",
        status: "failed",
        startedAt: 0,
        completedAt: 500,
        depth: 1,
        error: "rate limited",
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".run-error")?.textContent).toContain("rate limited");
  });

  it("truncates the run task text to 80 characters with horizontal ellipsis for long task strings", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    const longTask = "x".repeat(120);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-8",
        agentId: "alpha",
        task: longTask,
        status: "completed",
        startedAt: 0,
        completedAt: 100,
        depth: 0,
      },
    ];
    await el.updateComplete;
    const taskDiv = el.shadowRoot?.querySelector(".run-task");
    expect(taskDiv?.textContent?.endsWith("…")).toBe(true);
  });

  it("renders the status tag with the color matching the run.status via _statusColor mapping", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-9",
        agentId: "alpha",
        task: "t",
        status: "failed",
        startedAt: 0,
        depth: 0,
      },
    ];
    await el.updateComplete;
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag?.getAttribute("color")).toBe("red");
  });

  it("renders the agent id span containing the run.agentId value verbatim", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-10",
        agentId: "my-custom-agent-id",
        task: "t",
        status: "completed",
        startedAt: 0,
        depth: 0,
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".run-agent-id")?.textContent).toContain(
      "my-custom-agent-id",
    );
  });

  it("renders depth meta value matching the run.depth integer for sub-agent nesting visibility", async () => {
    el = document.createElement("ic-subagents-view") as IcSubAgentsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._runs = [
      {
        runId: "r-11",
        agentId: "alpha",
        task: "t",
        status: "running",
        startedAt: 0,
        depth: 4,
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("Depth:");
  });
});
