// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import "./ic-graph-canvas.js";
import type { IcGraphCanvas } from "./ic-graph-canvas.js";
import type { PipelineNode, PipelineEdge } from "../../api/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcGraphCanvas> {
  const el = document.createElement("ic-graph-canvas") as IcGraphCanvas;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function makeNode(overrides: Partial<PipelineNode> & { id: string }): PipelineNode {
  return {
    task: "Default task text",
    dependsOn: [],
    position: { x: 100, y: 100 },
    ...overrides,
  };
}

function makeEdge(overrides: Partial<PipelineEdge> & { id: string; source: string; target: string }): PipelineEdge {
  return { ...overrides };
}

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Existing tests
// ---------------------------------------------------------------------------

describe("IcGraphCanvas", () => {
  it("renders SVG layer with dot-grid pattern", async () => {
    const el = await createElement();
    const svg = el.shadowRoot?.querySelector("svg.svg-layer");
    expect(svg).not.toBeNull();

    const pattern = svg?.querySelector("pattern#dot-grid");
    expect(pattern).not.toBeNull();
    expect(pattern?.getAttribute("width")).toBe("24");
    expect(pattern?.getAttribute("height")).toBe("24");

    const circle = pattern?.querySelector("circle");
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute("r")).toBe("1");
  });

  it("renders HTML layer", async () => {
    const el = await createElement();
    const htmlLayer = el.shadowRoot?.querySelector(".html-layer");
    expect(htmlLayer).not.toBeNull();

    const transformGroup = htmlLayer?.querySelector("div.transform-group");
    expect(transformGroup).not.toBeNull();
  });

  it("renders zoom indicator showing 100%", async () => {
    const el = await createElement();
    const indicator = el.shadowRoot?.querySelector(".zoom-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toBe("100%");
  });

  it("interaction mode starts as idle", async () => {
    const el = await createElement();
    expect(el.interactionMode).toBe("idle");
  });

  it("zoom indicator reflects viewport.scale property", async () => {
    const el = await createElement({
      viewport: { x: 0, y: 0, scale: 0.5 },
    });
    const indicator = el.shadowRoot?.querySelector(".zoom-indicator");
    expect(indicator?.textContent).toBe("50%");
  });

  it("renders SVG transform group with correct transform", async () => {
    const el = await createElement({
      viewport: { x: 10, y: 20, scale: 1.5 },
    });
    const g = el.shadowRoot?.querySelector("g.transform-group") as SVGGElement;
    expect(g).not.toBeNull();
    // The inline style from render sets the initial transform
    expect(g.getAttribute("style")).toContain("translate(10px, 20px)");
    expect(g.getAttribute("style")).toContain("scale(1.5)");
  });

  it("renders canvas container with expected structure", async () => {
    const el = await createElement();
    const container = el.shadowRoot?.querySelector(".canvas-container");
    expect(container).not.toBeNull();

    // Should have SVG layer, HTML layer, and zoom indicator
    const svgLayer = container?.querySelector(".svg-layer");
    const htmlLayer = container?.querySelector(".html-layer");
    const indicator = container?.querySelector(".zoom-indicator");
    expect(svgLayer).not.toBeNull();
    expect(htmlLayer).not.toBeNull();
    expect(indicator).not.toBeNull();
  });

  it("updates zoom indicator when viewport changes", async () => {
    const el = await createElement();
    const indicator = el.shadowRoot?.querySelector(".zoom-indicator");
    expect(indicator?.textContent).toBe("100%");

    // Update viewport
    el.viewport = { x: 0, y: 0, scale: 2.0 };
    await el.updateComplete;

    expect(indicator?.textContent).toBe("200%");
  });

  it("dot-grid rect covers large area", async () => {
    const el = await createElement();
    const rect = el.shadowRoot?.querySelector("g.transform-group > rect");
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("x")).toBe("-5000");
    expect(rect?.getAttribute("y")).toBe("-5000");
    expect(rect?.getAttribute("width")).toBe("10000");
    expect(rect?.getAttribute("height")).toBe("10000");
    expect(rect?.getAttribute("fill")).toBe("url(#dot-grid)");
  });

  // -------------------------------------------------------------------------
  // Node card rendering tests
  // -------------------------------------------------------------------------

  it("renders node cards for each node in nodes property", async () => {
    const nodes = [
      makeNode({ id: "a", position: { x: 0, y: 0 } }),
      makeNode({ id: "b", position: { x: 200, y: 100 } }),
    ];
    const el = await createElement({ nodes });
    const cards = el.shadowRoot?.querySelectorAll(".node-card");
    expect(cards?.length).toBe(2);
  });

  it("node card shows nodeId and status dot", async () => {
    const nodes = [makeNode({ id: "my-node" })];
    const el = await createElement({ nodes });

    const idEl = el.shadowRoot?.querySelector(".node-id");
    expect(idEl?.textContent).toBe("my-node");

    const dot = el.shadowRoot?.querySelector(".node-status-dot");
    expect(dot).not.toBeNull();
  });

  it("node card shows agent tag when agentId set", async () => {
    const withAgent = [makeNode({ id: "a", agentId: "scraper" })];
    const el = await createElement({ nodes: withAgent });
    const tag = el.shadowRoot?.querySelector(".node-agent-tag");
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe("scraper");

    // Without agentId - no tag
    document.body.innerHTML = "";
    const withoutAgent = [makeNode({ id: "b" })];
    const el2 = await createElement({ nodes: withoutAgent });
    const tag2 = el2.shadowRoot?.querySelector(".node-agent-tag");
    expect(tag2).toBeNull();
  });

  it("node card shows agent tag from typeConfig.agent when agentId absent", async () => {
    const withTypeAgent = [makeNode({ id: "c", typeId: "agent", typeConfig: { agent: "ta-fundamentals" } })];
    const el = await createElement({ nodes: withTypeAgent });
    const tag = el.shadowRoot?.querySelector(".node-agent-tag");
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe("ta-fundamentals");
  });

  it("node card has input and output ports", async () => {
    const nodes = [makeNode({ id: "n1" })];
    const el = await createElement({ nodes });

    const portIn = el.shadowRoot?.querySelector(".port-in");
    const portOut = el.shadowRoot?.querySelector(".port-out");
    expect(portIn).not.toBeNull();
    expect(portOut).not.toBeNull();
  });

  it("node card shows constraint indicators when set", async () => {
    const nodes = [
      makeNode({ id: "c1", timeoutMs: 30000, maxSteps: 5 }),
    ];
    const el = await createElement({ nodes });
    const constraints = el.shadowRoot?.querySelector(".node-constraints");
    expect(constraints).not.toBeNull();
    expect(constraints?.textContent).toContain("30s");
    expect(constraints?.textContent).toContain("5 steps");
  });

  // -------------------------------------------------------------------------
  // Edge rendering tests
  // -------------------------------------------------------------------------

  it("renders edges as SVG paths", async () => {
    const nodes = [
      makeNode({ id: "src", position: { x: 100, y: 50 } }),
      makeNode({ id: "tgt", position: { x: 100, y: 200 } }),
    ];
    const edges = [makeEdge({ id: "e1", source: "src", target: "tgt" })];
    const el = await createElement({ nodes, edges });

    const group = el.shadowRoot?.querySelector(".edge-group");
    expect(group).not.toBeNull();

    const path = group?.querySelector(".edge-path");
    expect(path).not.toBeNull();
    expect(path?.getAttribute("d")).toBeTruthy();

    const hitArea = group?.querySelector(".edge-hit-area");
    expect(hitArea).not.toBeNull();
  });

  it("renders arrowhead for each edge", async () => {
    const nodes = [
      makeNode({ id: "a", position: { x: 0, y: 0 } }),
      makeNode({ id: "b", position: { x: 0, y: 150 } }),
    ];
    const edges = [makeEdge({ id: "e1", source: "a", target: "b" })];
    const el = await createElement({ nodes, edges });

    const arrow = el.shadowRoot?.querySelector(".edge-arrow");
    expect(arrow).not.toBeNull();
    const d = arrow?.getAttribute("d");
    expect(d).toBeTruthy();
    // Arrowhead path should be a closed triangle (ends with Z)
    expect(d).toContain("Z");
  });

  it("selected edge has --selected class", async () => {
    const nodes = [
      makeNode({ id: "a", position: { x: 0, y: 0 } }),
      makeNode({ id: "b", position: { x: 0, y: 150 } }),
    ];
    const edges = [makeEdge({ id: "e1", source: "a", target: "b" })];
    const el = await createElement({
      nodes,
      edges,
      selectedEdgeId: "e1",
    });

    const selectedPath = el.shadowRoot?.querySelector(".edge-path--selected");
    expect(selectedPath).not.toBeNull();

    const selectedArrow = el.shadowRoot?.querySelector(".edge-arrow--selected");
    expect(selectedArrow).not.toBeNull();
  });

  it("selected node card has --selected class", async () => {
    const nodes = [makeNode({ id: "sel" })];
    const el = await createElement({
      nodes,
      selectedNodeIds: new Set(["sel"]),
    });

    const card = el.shadowRoot?.querySelector(".node-card--selected");
    expect(card).not.toBeNull();
  });

  it("dispatches edge-select event on edge hit area click", async () => {
    const nodes = [
      makeNode({ id: "a", position: { x: 0, y: 0 } }),
      makeNode({ id: "b", position: { x: 0, y: 150 } }),
    ];
    const edges = [makeEdge({ id: "e1", source: "a", target: "b" })];
    const el = await createElement({ nodes, edges });

    let receivedId: string | null = null;
    el.addEventListener("edge-select", ((e: CustomEvent<string>) => {
      receivedId = e.detail;
    }) as EventListener);

    const hitArea = el.shadowRoot?.querySelector(".edge-hit-area") as SVGPathElement;
    expect(hitArea).not.toBeNull();
    hitArea.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(receivedId).toBe("e1");
  });
});
