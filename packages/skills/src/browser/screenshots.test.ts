import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page, Locator } from "playwright-core";

// ── Mock playwright-session ─────────────────────────────────────────

const mockEnsurePageState = vi.fn();
const mockRefLocator = vi.fn();

vi.mock("./playwright-session.js", () => ({
  ensurePageState: (...args: unknown[]) => mockEnsurePageState(...args),
  refLocator: (...args: unknown[]) => mockRefLocator(...args),
}));

import { takeScreenshot, generatePdf } from "./screenshots.js";

// ── Helpers ─────────────────────────────────────────────────────────

function createMockLocator(overrides?: Partial<Locator>): Locator {
  return {
    screenshot: vi.fn().mockResolvedValue(Buffer.from("element-png")),
    first: vi.fn().mockReturnThis(),
    ...overrides,
  } as unknown as Locator;
}

function createMockPage(overrides?: Partial<Page>): Page {
  const mockLocator = createMockLocator();
  return {
    screenshot: vi.fn().mockResolvedValue(Buffer.from("page-png")),
    pdf: vi.fn().mockResolvedValue(Buffer.from("pdf-data")),
    locator: vi.fn().mockReturnValue(mockLocator),
    ...overrides,
  } as unknown as Page;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("takeScreenshot", () => {
  let page: Page;

  beforeEach(() => {
    vi.clearAllMocks();
    page = createMockPage();
    mockEnsurePageState.mockReturnValue(undefined);
  });

  describe("default viewport screenshot", () => {
    it("calls page.screenshot with png type and fullPage false by default", async () => {
      const result = await takeScreenshot(page);

      expect(page.screenshot).toHaveBeenCalledWith({
        type: "png",
        quality: undefined,
        fullPage: false,
      });
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.mimeType).toBe("image/png");
    });

    it("calls ensurePageState before taking screenshot", async () => {
      await takeScreenshot(page);

      expect(mockEnsurePageState).toHaveBeenCalledWith(page);
    });
  });

  describe("fullPage screenshot", () => {
    it("calls page.screenshot with fullPage true", async () => {
      await takeScreenshot(page, { fullPage: true });

      expect(page.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: true }),
      );
    });
  });

  describe("jpeg screenshot", () => {
    it("calls page.screenshot with jpeg type and default quality 80", async () => {
      const result = await takeScreenshot(page, { type: "jpeg" });

      expect(page.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ type: "jpeg", quality: 80 }),
      );
      expect(result.mimeType).toBe("image/jpeg");
    });

    it("passes custom quality through", async () => {
      await takeScreenshot(page, { type: "jpeg", quality: 50 });

      expect(page.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ quality: 50 }),
      );
    });

    it("does not set quality for png type", async () => {
      await takeScreenshot(page, { type: "png" });

      expect(page.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ quality: undefined }),
      );
    });
  });

  describe("element screenshot by ref", () => {
    it("uses refLocator and calls locator.screenshot", async () => {
      const locator = createMockLocator();
      mockRefLocator.mockReturnValue(locator);

      const result = await takeScreenshot(page, { ref: "e12" });

      expect(mockRefLocator).toHaveBeenCalledWith(page, "e12");
      expect(locator.screenshot).toHaveBeenCalledWith({
        type: "png",
        quality: undefined,
      });
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.mimeType).toBe("image/png");
    });

    it("throws when fullPage is used with ref", async () => {
      await expect(
        takeScreenshot(page, { ref: "e12", fullPage: true }),
      ).rejects.toThrow("fullPage is not supported for element screenshots");
    });
  });

  describe("element screenshot by CSS selector", () => {
    it("calls page.locator(selector).first().screenshot()", async () => {
      const locator = createMockLocator();
      (page.locator as ReturnType<typeof vi.fn>).mockReturnValue(locator);

      const result = await takeScreenshot(page, { element: ".my-class" });

      expect(page.locator).toHaveBeenCalledWith(".my-class");
      expect(locator.first).toHaveBeenCalled();
      expect(locator.screenshot).toHaveBeenCalledWith({
        type: "png",
        quality: undefined,
      });
      expect(result.mimeType).toBe("image/png");
    });

    it("throws when fullPage is used with element", async () => {
      await expect(
        takeScreenshot(page, { element: ".my-class", fullPage: true }),
      ).rejects.toThrow("fullPage is not supported for element screenshots");
    });
  });
});

describe("generatePdf", () => {
  let page: Page;

  beforeEach(() => {
    vi.clearAllMocks();
    page = createMockPage();
    mockEnsurePageState.mockReturnValue(undefined);
  });

  it("calls page.pdf with printBackground true", async () => {
    const result = await generatePdf(page);

    expect(page.pdf).toHaveBeenCalledWith({ printBackground: true });
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.mimeType).toBe("application/pdf");
  });

  it("calls ensurePageState before generating PDF", async () => {
    await generatePdf(page);

    expect(mockEnsurePageState).toHaveBeenCalledWith(page);
  });
});
