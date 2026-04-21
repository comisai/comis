// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  NODE_WIDTH,
  NODE_FIXED_HEIGHT,
  getOutputPortPosition,
  getInputPortPosition,
  computeBezierPath,
  computeArrowhead,
  computeBezierMidpoint,
  type Point,
} from "./edge-geometry.js";

describe("edge-geometry", () => {
  describe("constants", () => {
    it("NODE_WIDTH is 200", () => {
      expect(NODE_WIDTH).toBe(200);
    });

    it("NODE_FIXED_HEIGHT is 80", () => {
      expect(NODE_FIXED_HEIGHT).toBe(80);
    });
  });

  describe("getOutputPortPosition", () => {
    it("returns bottom-center of node card at origin", () => {
      const pos = getOutputPortPosition({ position: { x: 0, y: 0 } });
      expect(pos).toEqual({ x: NODE_WIDTH / 2, y: NODE_FIXED_HEIGHT });
    });

    it("returns bottom-center of node card at offset position", () => {
      const pos = getOutputPortPosition({ position: { x: 100, y: 200 } });
      expect(pos).toEqual({ x: 100 + NODE_WIDTH / 2, y: 200 + NODE_FIXED_HEIGHT });
    });
  });

  describe("getInputPortPosition", () => {
    it("returns top-center of node card at origin", () => {
      const pos = getInputPortPosition({ position: { x: 0, y: 0 } });
      expect(pos).toEqual({ x: NODE_WIDTH / 2, y: 0 });
    });

    it("returns top-center of node card at offset position", () => {
      const pos = getInputPortPosition({ position: { x: 100, y: 200 } });
      expect(pos).toEqual({ x: 100 + NODE_WIDTH / 2, y: 200 });
    });
  });

  describe("computeBezierPath", () => {
    it("starts with M at source point", () => {
      const path = computeBezierPath({ x: 10, y: 20 }, { x: 10, y: 220 });
      expect(path).toMatch(/^M 10 20/);
    });

    it("contains C command", () => {
      const path = computeBezierPath({ x: 10, y: 20 }, { x: 10, y: 220 });
      expect(path).toContain("C");
    });

    it("ends at target point coordinates", () => {
      const path = computeBezierPath({ x: 10, y: 20 }, { x: 50, y: 220 });
      expect(path).toMatch(/50 220$/);
    });

    it("for vertical alignment control points maintain same x", () => {
      const path = computeBezierPath({ x: 100, y: 0 }, { x: 100, y: 200 });
      // M 100 0 C 100 cpY, 100 cpY, 100 200
      // All x values in the path should be 100
      const numbers = path.replace(/[MCZ,]/g, " ").trim().split(/\s+/).map(Number);
      // numbers: [sx, sy, cp1x, cp1y, cp2x, cp2y, tx, ty]
      expect(numbers[0]).toBe(100); // source x
      expect(numbers[2]).toBe(100); // cp1 x
      expect(numbers[4]).toBe(100); // cp2 x
      expect(numbers[6]).toBe(100); // target x
    });

    it("for short vertical distance (60px) cpOffset does not exceed half the distance", () => {
      const source: Point = { x: 100, y: 0 };
      const target: Point = { x: 100, y: 60 };
      const path = computeBezierPath(source, target);
      // dy = 60, cpOffset = max(30, min(60*0.5, 150)) = max(30, 30) = 30
      // cp1y = 0 + 30 = 30, cp2y = 60 - 30 = 30
      // cp1y should not exceed midpoint (30), and cp2y should not go below midpoint (30)
      const numbers = path.replace(/[MCZ,]/g, " ").trim().split(/\s+/).map(Number);
      const cp1y = numbers[3]!;
      const cp2y = numbers[5]!;
      // Control points should not cross (no loops)
      expect(cp1y).toBeLessThanOrEqual(cp2y + 0.001);
    });

    it("for large distance (500px) cpOffset caps at 150", () => {
      const source: Point = { x: 100, y: 0 };
      const target: Point = { x: 100, y: 500 };
      const path = computeBezierPath(source, target);
      // dy = 500, cpOffset = max(30, min(500*0.5, 150)) = max(30, 150) = 150
      // cp1y = 0 + 150 = 150, cp2y = 500 - 150 = 350
      const numbers = path.replace(/[MCZ,]/g, " ").trim().split(/\s+/).map(Number);
      const cp1y = numbers[3]!;
      const cp2y = numbers[5]!;
      expect(cp1y).toBe(150);
      expect(cp2y).toBe(350);
    });
  });

  describe("computeArrowhead", () => {
    it("returns a closed triangle path (M ... L ... L ... Z)", () => {
      const path = computeArrowhead({ x: 100, y: 200 }, { x: 100, y: 0 });
      expect(path).toMatch(/^M .+ L .+ L .+ Z$/);
    });

    it("triangle points toward target", () => {
      // The triangle vertex is at the target point
      const target: Point = { x: 100, y: 200 };
      const path = computeArrowhead(target, { x: 100, y: 0 });
      // Should contain L 100 200 (the target point as the tip)
      expect(path).toContain(`L ${target.x} ${target.y}`);
    });

    it("default size is 8px", () => {
      const target: Point = { x: 100, y: 200 };
      const source: Point = { x: 100, y: 0 };
      const path = computeArrowhead(target, source);
      // Parse the triangle vertices
      const coords = path.replace(/[MLZC]/g, "").trim().split(/\s+/).map(Number);
      // coords: [x1, y1, tx, ty, x2, y2]
      const x1 = coords[0]!, y1 = coords[1]!;
      const tx = coords[2]!, ty = coords[3]!;
      // Distance from tip to each wing should be ~8
      const dist = Math.sqrt((tx - x1) ** 2 + (ty - y1) ** 2);
      expect(dist).toBeCloseTo(8, 5);
    });

    it("custom size parameter works", () => {
      const target: Point = { x: 100, y: 200 };
      const source: Point = { x: 100, y: 0 };
      const path = computeArrowhead(target, source, 12);
      const coords = path.replace(/[MLZC]/g, "").trim().split(/\s+/).map(Number);
      const x1 = coords[0]!, y1 = coords[1]!;
      const tx = coords[2]!, ty = coords[3]!;
      const dist = Math.sqrt((tx - x1) ** 2 + (ty - y1) ** 2);
      expect(dist).toBeCloseTo(12, 5);
    });

    it("for straight-down edge arrowhead points downward (angle ~PI/2)", () => {
      // Source directly above target (same x)
      const source: Point = { x: 100, y: 0 };
      const target: Point = { x: 100, y: 200 };
      const path = computeArrowhead(target, source);
      const coords = path.replace(/[MLZC]/g, "").trim().split(/\s+/).map(Number);
      // x1, y1 are the left wing; tx, ty is tip; x2, y2 is right wing
      const x1 = coords[0]!, y1 = coords[1]!;
      const x2 = coords[4]!, y2 = coords[5]!;
      const ty = coords[3]!;
      // Both wing points should be above the target (y < ty) for a downward arrow
      expect(y1).toBeLessThan(ty);
      expect(y2).toBeLessThan(ty);
      // Wings should be symmetric around the center x
      expect(x1 + x2).toBeCloseTo(200, 5); // symmetric around x=100
    });
  });

  describe("computeBezierMidpoint", () => {
    it("for vertical edge midpoint x equals source x", () => {
      const source: Point = { x: 100, y: 0 };
      const target: Point = { x: 100, y: 200 };
      const mid = computeBezierMidpoint(source, target);
      expect(mid.x).toBe(100);
    });

    it("for horizontal offset midpoint x is between source.x and target.x", () => {
      const source: Point = { x: 50, y: 0 };
      const target: Point = { x: 250, y: 200 };
      const mid = computeBezierMidpoint(source, target);
      expect(mid.x).toBeGreaterThan(50);
      expect(mid.x).toBeLessThan(250);
    });

    it("midpoint y is between source.y and target.y", () => {
      const source: Point = { x: 100, y: 0 };
      const target: Point = { x: 100, y: 200 };
      const mid = computeBezierMidpoint(source, target);
      expect(mid.y).toBeGreaterThan(0);
      expect(mid.y).toBeLessThan(200);
    });

    it("midpoint y is approximately halfway for symmetric curves", () => {
      // For same x, the midpoint should be close to vertical midpoint
      const source: Point = { x: 100, y: 0 };
      const target: Point = { x: 100, y: 200 };
      const mid = computeBezierMidpoint(source, target);
      // With control points at (100, cpOffset) and (100, 200-cpOffset),
      // the cubic Bezier midpoint at t=0.5 should be at y=100
      expect(mid.y).toBeCloseTo(100, 5);
    });
  });
});
