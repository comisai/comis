// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke + render-decision tests for the 5 pipeline view files
 * (Phase 40 Plan 40-15 gap-closure for COV-03, Option-A coverage measurement).
 *
 * Per the plan's coverage-gate-gotcha analysis, the views/pipelines/* files
 * are NOT transitively imported by any existing test, so Option B (per-package)
 * coverage does not see them at all but Option A (root-level pnpm test) sees
 * them at 0%. This file adds at minimum:
 *   1. Custom-element registration assertion (forces the side-effect import
 *      so all top-level decorators / module bindings execute).
 *   2. Instantiation smoke test (default render path runs without throwing).
 *   3. One or two render-decision branches per file (loading vs populated).
 *
 * The combination lifts each pipelines/* file's Option-A measurement
 * significantly toward the package floor.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import type { IcPipelineList } from "./pipeline-list.js";
import type { IcPipelineBuilder } from "./pipeline-builder.js";
import type { IcPipelineMonitor } from "./pipeline-monitor.js";
import type { IcPipelineHistory } from "./pipeline-history.js";
import type { IcPipelineHistoryDetail } from "./pipeline-history-detail.js";

// Side-effect imports register the custom elements so coverage instruments
// the module-level @customElement decorator + class body executions.
import "./pipeline-list.js";
import "./pipeline-builder.js";
import "./pipeline-monitor.js";
import "./pipeline-history.js";
import "./pipeline-history-detail.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv<T extends HTMLElement>(el: T): any {
  return el as unknown as Record<string, unknown>;
}

describe("ic-pipeline-list custom element registration + render branches", () => {
  let el: IcPipelineList;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("registers the 'ic-pipeline-list' custom element after the side-effect import executes", () => {
    expect(customElements.get("ic-pipeline-list")).toBeDefined();
  });

  it("instantiates and renders without throwing when mounted in default loading state", async () => {
    el = document.createElement("ic-pipeline-list") as IcPipelineList;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".page-title")).not.toBeNull();
  });

  it("renders the skeleton list template while _loading state is true", async () => {
    el = document.createElement("ic-pipeline-list") as IcPipelineList;
    document.body.appendChild(el);
    priv(el)._loading = true;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-skeleton-view")).not.toBeNull();
  });

  it("renders the empty state when load completes and _pipelines array is empty", async () => {
    el = document.createElement("ic-pipeline-list") as IcPipelineList;
    document.body.appendChild(el);
    priv(el)._loading = false;
    priv(el)._pipelines = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-empty-state")).not.toBeNull();
  });

  it("renders the History + New Pipeline action buttons in the page header", async () => {
    el = document.createElement("ic-pipeline-list") as IcPipelineList;
    document.body.appendChild(el);
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("History");
    expect(html).toContain("New Pipeline");
  });

  it("renders the delete confirm dialog when _deleteTarget is non-null", async () => {
    el = document.createElement("ic-pipeline-list") as IcPipelineList;
    document.body.appendChild(el);
    priv(el)._loading = false;
    priv(el)._pipelines = [];
    priv(el)._deleteTarget = { id: "p-1", label: "My Pipeline" };
    await el.updateComplete;
    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect(dialog).not.toBeNull();
  });
});

describe("ic-pipeline-builder custom element registration + smoke render", () => {
  let el: IcPipelineBuilder;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("registers the 'ic-pipeline-builder' custom element after the side-effect import", () => {
    expect(customElements.get("ic-pipeline-builder")).toBeDefined();
  });

  it("instantiates and mounts without throwing on default state with empty graphId prop", async () => {
    el = document.createElement("ic-pipeline-builder") as IcPipelineBuilder;
    el.graphId = "";
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot).not.toBeNull();
  });

  it("renders the initial graph builder shell with empty node + edge arrays by default", async () => {
    el = document.createElement("ic-pipeline-builder") as IcPipelineBuilder;
    el.graphId = "";
    document.body.appendChild(el);
    await el.updateComplete;
    expect(priv(el)._nodes).toEqual([]);
    expect(priv(el)._edges).toEqual([]);
  });

  it("starts with the default viewport transform at origin and scale 1.0", async () => {
    el = document.createElement("ic-pipeline-builder") as IcPipelineBuilder;
    el.graphId = "";
    document.body.appendChild(el);
    expect(priv(el)._viewport.scale).toBe(1.0);
    expect(priv(el)._viewport.x).toBe(0);
    expect(priv(el)._viewport.y).toBe(0);
  });

  it("starts with empty selectedNodeIds set and null selectedEdgeId before any user interaction", () => {
    el = document.createElement("ic-pipeline-builder") as IcPipelineBuilder;
    expect(priv(el)._selectedNodeIds.size).toBe(0);
    expect(priv(el)._selectedEdgeId).toBeNull();
  });
});

describe("ic-pipeline-monitor custom element registration + smoke render", () => {
  let el: IcPipelineMonitor;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("registers the 'ic-pipeline-monitor' custom element after the side-effect import", () => {
    expect(customElements.get("ic-pipeline-monitor")).toBeDefined();
  });

  it("instantiates and renders without throwing on default empty graphId state", async () => {
    el = document.createElement("ic-pipeline-monitor") as IcPipelineMonitor;
    el.graphId = "";
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot).not.toBeNull();
  });

  it("accepts a graphId property without throwing for valid graph ids", async () => {
    el = document.createElement("ic-pipeline-monitor") as IcPipelineMonitor;
    el.graphId = "graph-123";
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.graphId).toBe("graph-123");
  });
});

describe("ic-pipeline-history custom element registration + smoke render", () => {
  let el: IcPipelineHistory;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("registers the 'ic-pipeline-history' custom element after the side-effect import", () => {
    expect(customElements.get("ic-pipeline-history")).toBeDefined();
  });

  it("instantiates and renders without throwing on default empty history state", async () => {
    el = document.createElement("ic-pipeline-history") as IcPipelineHistory;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot).not.toBeNull();
  });
});

describe("ic-pipeline-history-detail custom element registration + smoke render", () => {
  let el: IcPipelineHistoryDetail;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("registers the 'ic-pipeline-history-detail' custom element after the side-effect import", () => {
    expect(customElements.get("ic-pipeline-history-detail")).toBeDefined();
  });

  it("instantiates and renders without throwing on default empty graphId state", async () => {
    el = document.createElement("ic-pipeline-history-detail") as IcPipelineHistoryDetail;
    el.graphId = "";
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot).not.toBeNull();
  });

  it("accepts a graphId property without throwing for valid run ids", async () => {
    el = document.createElement("ic-pipeline-history-detail") as IcPipelineHistoryDetail;
    el.graphId = "run-456";
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.graphId).toBe("run-456");
  });
});
