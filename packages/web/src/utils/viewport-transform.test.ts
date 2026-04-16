import { describe, it, expect } from "vitest";
import {
  screenToGraph,
  graphToScreen,
  zoomAtPoint,
  DEFAULT_VIEWPORT,
  MIN_SCALE,
  MAX_SCALE,
  type ViewportTransform,
} from "./viewport-transform.js";

/** Mock DOMRect at canvas origin */
const RECT = { left: 0, top: 0, width: 800, height: 600 } as DOMRect;

/** Mock DOMRect offset from viewport origin */
const OFFSET_RECT = { left: 100, top: 50, width: 800, height: 600 } as DOMRect;

describe("ViewportTransform constants", () => {
  it("DEFAULT_VIEWPORT is identity transform", () => {
    expect(DEFAULT_VIEWPORT).toEqual({ x: 0, y: 0, scale: 1.0 });
  });

  it("MIN_SCALE is 0.25", () => {
    expect(MIN_SCALE).toBe(0.25);
  });

  it("MAX_SCALE is 2.0", () => {
    expect(MAX_SCALE).toBe(2.0);
  });
});

describe("screenToGraph", () => {
  it("at scale=1.0, pan=(0,0) returns identity (screen coords = graph coords)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = screenToGraph(200, 150, RECT, vt);
    expect(result).toEqual({ x: 200, y: 150 });
  });

  it("at scale=2.0 returns half the offset (zoomed in)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 2.0 };
    const result = screenToGraph(200, 150, RECT, vt);
    expect(result).toEqual({ x: 100, y: 75 });
  });

  it("at scale=0.5 returns double the offset (zoomed out)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 0.5 };
    const result = screenToGraph(200, 150, RECT, vt);
    expect(result).toEqual({ x: 400, y: 300 });
  });

  it("with pan offset (100,50) correctly subtracts pan before dividing by scale", () => {
    const vt: ViewportTransform = { x: 100, y: 50, scale: 1.0 };
    const result = screenToGraph(200, 150, RECT, vt);
    expect(result).toEqual({ x: 100, y: 100 });
  });

  it("with pan offset and scale=2.0 combines both transformations", () => {
    const vt: ViewportTransform = { x: 100, y: 50, scale: 2.0 };
    const result = screenToGraph(300, 250, RECT, vt);
    // (300 - 0 - 100) / 2.0 = 100, (250 - 0 - 50) / 2.0 = 100
    expect(result).toEqual({ x: 100, y: 100 });
  });

  it("with canvasRect offset (canvas not at top-left of viewport)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = screenToGraph(300, 200, OFFSET_RECT, vt);
    // (300 - 100 - 0) / 1.0 = 200, (200 - 50 - 0) / 1.0 = 150
    expect(result).toEqual({ x: 200, y: 150 });
  });

  it("with canvasRect offset and scale and pan combined", () => {
    const vt: ViewportTransform = { x: 50, y: 25, scale: 0.5 };
    const result = screenToGraph(250, 125, OFFSET_RECT, vt);
    // (250 - 100 - 50) / 0.5 = 200, (125 - 50 - 25) / 0.5 = 100
    expect(result).toEqual({ x: 200, y: 100 });
  });
});

describe("graphToScreen", () => {
  it("at scale=1.0, pan=(0,0) returns identity", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = graphToScreen(200, 150, RECT, vt);
    expect(result).toEqual({ x: 200, y: 150 });
  });

  it("at scale=2.0 doubles the coordinates", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 2.0 };
    const result = graphToScreen(100, 75, RECT, vt);
    expect(result).toEqual({ x: 200, y: 150 });
  });

  it("with pan offset adds pan", () => {
    const vt: ViewportTransform = { x: 100, y: 50, scale: 1.0 };
    const result = graphToScreen(100, 100, RECT, vt);
    expect(result).toEqual({ x: 200, y: 150 });
  });

  it("with canvasRect offset adds rect position", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = graphToScreen(200, 150, OFFSET_RECT, vt);
    expect(result).toEqual({ x: 300, y: 200 });
  });
});

describe("screenToGraph and graphToScreen round-trip", () => {
  const testCases: Array<{
    label: string;
    vt: ViewportTransform;
    rect: DOMRect;
    screenX: number;
    screenY: number;
  }> = [
    { label: "identity", vt: { x: 0, y: 0, scale: 1.0 }, rect: RECT, screenX: 400, screenY: 300 },
    { label: "zoomed in", vt: { x: 0, y: 0, scale: 2.0 }, rect: RECT, screenX: 400, screenY: 300 },
    { label: "zoomed out", vt: { x: 0, y: 0, scale: 0.5 }, rect: RECT, screenX: 400, screenY: 300 },
    { label: "panned", vt: { x: 150, y: -80, scale: 1.0 }, rect: RECT, screenX: 400, screenY: 300 },
    { label: "panned + zoomed", vt: { x: 150, y: -80, scale: 1.5 }, rect: RECT, screenX: 400, screenY: 300 },
    { label: "offset rect", vt: { x: 50, y: 25, scale: 0.75 }, rect: OFFSET_RECT, screenX: 500, screenY: 350 },
  ];

  for (const { label, vt, rect, screenX, screenY } of testCases) {
    it(`round-trip preserves coordinates (${label})`, () => {
      const graph = screenToGraph(screenX, screenY, rect, vt);
      const screen = graphToScreen(graph.x, graph.y, rect, vt);
      expect(screen.x).toBeCloseTo(screenX, 10);
      expect(screen.y).toBeCloseTo(screenY, 10);
    });
  }
});

describe("zoomAtPoint", () => {
  it("keeps cursor point fixed in graph space when zooming in", () => {
    const vtBefore: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const cursorX = 400;
    const cursorY = 300;

    const vtAfter = zoomAtPoint(vtBefore, cursorX, cursorY, -1, MIN_SCALE, MAX_SCALE);

    // The graph point under the cursor should be the same before and after zoom
    const graphBefore = screenToGraph(cursorX, cursorY, RECT, vtBefore);
    const graphAfter = screenToGraph(cursorX, cursorY, RECT, vtAfter);

    expect(graphAfter.x).toBeCloseTo(graphBefore.x, 10);
    expect(graphAfter.y).toBeCloseTo(graphBefore.y, 10);
  });

  it("keeps cursor point fixed in graph space when zooming out", () => {
    const vtBefore: ViewportTransform = { x: 50, y: 30, scale: 1.5 };
    const cursorX = 400;
    const cursorY = 300;

    const vtAfter = zoomAtPoint(vtBefore, cursorX, cursorY, 1, MIN_SCALE, MAX_SCALE);

    const graphBefore = screenToGraph(cursorX, cursorY, RECT, vtBefore);
    const graphAfter = screenToGraph(cursorX, cursorY, RECT, vtAfter);

    expect(graphAfter.x).toBeCloseTo(graphBefore.x, 10);
    expect(graphAfter.y).toBeCloseTo(graphBefore.y, 10);
  });

  it("delta > 0 zooms out (scale decreases)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = zoomAtPoint(vt, 400, 300, 1, MIN_SCALE, MAX_SCALE);
    expect(result.scale).toBeLessThan(vt.scale);
  });

  it("delta < 0 zooms in (scale increases)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = zoomAtPoint(vt, 400, 300, -1, MIN_SCALE, MAX_SCALE);
    expect(result.scale).toBeGreaterThan(vt.scale);
  });

  it("clamps to MIN_SCALE when zooming out beyond limit", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: MIN_SCALE };
    const result = zoomAtPoint(vt, 400, 300, 1, MIN_SCALE, MAX_SCALE);
    expect(result.scale).toBe(MIN_SCALE);
  });

  it("clamps to MAX_SCALE when zooming in beyond limit", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: MAX_SCALE };
    const result = zoomAtPoint(vt, 400, 300, -1, MIN_SCALE, MAX_SCALE);
    expect(result.scale).toBe(MAX_SCALE);
  });

  it("zoom factor is 0.9 for delta > 0 (zoom out)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = zoomAtPoint(vt, 0, 0, 1, MIN_SCALE, MAX_SCALE);
    expect(result.scale).toBeCloseTo(0.9, 10);
  });

  it("zoom factor is 1.1 for delta < 0 (zoom in)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = zoomAtPoint(vt, 0, 0, -1, MIN_SCALE, MAX_SCALE);
    expect(result.scale).toBeCloseTo(1.1, 10);
  });

  it("returns new ViewportTransform object (immutable)", () => {
    const vt: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
    const result = zoomAtPoint(vt, 400, 300, -1, MIN_SCALE, MAX_SCALE);
    expect(result).not.toBe(vt);
  });
});
