// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "playwright-core";
import { resizeViewport, setDevice } from "./viewport.js";

// ── Mock helpers ─────────────────────────────────────────────────────

function createMockPage(): Page {
  return {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("resizeViewport", () => {
  let page: Page;

  beforeEach(() => {
    page = createMockPage();
  });

  it("should set correct dimensions", async () => {
    const result = await resizeViewport(page, 1024, 768);

    expect(result.ok).toBe(true);
    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 1024,
      height: 768,
    });
  });

  it("should clamp negative width to 1", async () => {
    const result = await resizeViewport(page, -50, 600);

    expect(result.ok).toBe(true);
    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 1,
      height: 600,
    });
  });

  it("should clamp negative height to 1", async () => {
    const result = await resizeViewport(page, 800, -100);

    expect(result.ok).toBe(true);
    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 800,
      height: 1,
    });
  });

  it("should clamp huge width to 7680", async () => {
    const result = await resizeViewport(page, 99999, 1080);

    expect(result.ok).toBe(true);
    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 7680,
      height: 1080,
    });
  });

  it("should clamp huge height to 4320", async () => {
    const result = await resizeViewport(page, 1920, 99999);

    expect(result.ok).toBe(true);
    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 1920,
      height: 4320,
    });
  });

  it("should round fractional dimensions", async () => {
    const result = await resizeViewport(page, 1024.7, 768.3);

    expect(result.ok).toBe(true);
    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 1025,
      height: 768,
    });
  });

  it("should return err on Playwright error", async () => {
    (page.setViewportSize as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Browser context has been closed"),
    );

    const result = await resizeViewport(page, 1024, 768);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("resizeViewport failed");
    }
  });
});

describe("setDevice", () => {
  let page: Page;

  beforeEach(() => {
    page = createMockPage();
  });

  it("should set mobile dimensions (375x812)", async () => {
    const result = await setDevice(page, "mobile");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ width: 375, height: 812 });
    }
    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 375,
      height: 812,
    });
  });

  it("should set tablet dimensions (768x1024)", async () => {
    const result = await setDevice(page, "tablet");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ width: 768, height: 1024 });
    }
  });

  it("should set desktop dimensions (1280x720)", async () => {
    const result = await setDevice(page, "desktop");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ width: 1280, height: 720 });
    }
  });

  it("should set fullhd dimensions (1920x1080)", async () => {
    const result = await setDevice(page, "fullhd");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ width: 1920, height: 1080 });
    }
  });

  it("should set 4k dimensions (3840x2160)", async () => {
    const result = await setDevice(page, "4k");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ width: 3840, height: 2160 });
    }
  });

  it("should return err for unknown preset", async () => {
    const result = await setDevice(page, "ultrawide" as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unknown device preset");
      expect(result.error.message).toContain("ultrawide");
    }
  });
});
