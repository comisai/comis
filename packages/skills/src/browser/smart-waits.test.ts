import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page, Locator } from "playwright-core";
import { smartWait } from "./smart-waits.js";

// ── Mock helpers ─────────────────────────────────────────────────────

function createMockLocator(overrides?: Partial<Locator>): Locator {
  return {
    first: vi.fn().mockReturnThis(),
    waitFor: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Locator;
}

function createMockPage(overrides?: Partial<Page>): Page {
  const mockLocator = createMockLocator();

  return {
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(mockLocator),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("smartWait", () => {
  let page: Page;

  beforeEach(() => {
    page = createMockPage();
  });

  it("should return ok immediately when no conditions are specified", async () => {
    const result = await smartWait(page, {});
    expect(result.ok).toBe(true);
  });

  it("should call page.waitForTimeout when timeMs is specified", async () => {
    const result = await smartWait(page, { timeMs: 500 });

    expect(result.ok).toBe(true);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });

  it("should clamp timeMs to max 30000", async () => {
    const result = await smartWait(page, { timeMs: 50_000 });

    expect(result.ok).toBe(true);
    expect(page.waitForTimeout).toHaveBeenCalledWith(30_000);
  });

  it("should clamp timeMs to min 0", async () => {
    const result = await smartWait(page, { timeMs: -100 });

    expect(result.ok).toBe(true);
    expect(page.waitForTimeout).toHaveBeenCalledWith(0);
  });

  it("should create locator with text and wait for visible state", async () => {
    const result = await smartWait(page, { text: "Hello World" });

    expect(result.ok).toBe(true);
    expect(page.locator).toHaveBeenCalledWith("text=Hello World");
    const locator = (page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(locator.first).toHaveBeenCalled();
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 20_000,
    });
  });

  it("should create locator with textGone and wait for hidden state", async () => {
    const result = await smartWait(page, { textGone: "Loading..." });

    expect(result.ok).toBe(true);
    expect(page.locator).toHaveBeenCalledWith("text=Loading...");
    const locator = (page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(locator.first).toHaveBeenCalled();
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: "hidden",
      timeout: 20_000,
    });
  });

  it("should create locator with CSS selector and wait for visible state", async () => {
    const result = await smartWait(page, { selector: "#my-button" });

    expect(result.ok).toBe(true);
    expect(page.locator).toHaveBeenCalledWith("#my-button");
    const locator = (page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(locator.first).toHaveBeenCalled();
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 20_000,
    });
  });

  it("should call page.waitForURL with glob pattern", async () => {
    const result = await smartWait(page, { url: "/dashboard" });

    expect(result.ok).toBe(true);
    expect(page.waitForURL).toHaveBeenCalledWith("**/*/dashboard*", {
      timeout: 20_000,
    });
  });

  it("should call page.waitForLoadState", async () => {
    const result = await smartWait(page, { loadState: "networkidle" });

    expect(result.ok).toBe(true);
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 20_000,
    });
  });

  it("should call page.waitForFunction", async () => {
    const result = await smartWait(page, { fn: "document.querySelector('.ready')" });

    expect(result.ok).toBe(true);
    expect(page.waitForFunction).toHaveBeenCalledWith(
      "document.querySelector('.ready')",
      undefined,
      { timeout: 20_000 },
    );
  });

  it("should process multiple conditions sequentially", async () => {
    const callOrder: string[] = [];
    (page.waitForTimeout as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("timeout");
    });
    (page.waitForLoadState as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("loadState");
    });

    const result = await smartWait(page, {
      timeMs: 100,
      loadState: "domcontentloaded",
    });

    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["timeout", "loadState"]);
  });

  it("should clamp timeoutMs to minimum 1000", async () => {
    const result = await smartWait(page, { text: "Hi", timeoutMs: 100 });

    expect(result.ok).toBe(true);
    const locator = (page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 1000,
    });
  });

  it("should clamp timeoutMs to maximum 60000", async () => {
    const result = await smartWait(page, { text: "Hi", timeoutMs: 120_000 });

    expect(result.ok).toBe(true);
    const locator = (page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 60_000,
    });
  });

  it("should return err on Playwright timeout error", async () => {
    (page.waitForURL as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Timeout 20000ms exceeded waiting for URL"),
    );

    const result = await smartWait(page, { url: "/never" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("smartWait failed");
      expect(result.error.message).toContain("Timeout");
    }
  });

  it("should use default timeoutMs of 20000 when not specified", async () => {
    const result = await smartWait(page, { loadState: "load" });

    expect(result.ok).toBe(true);
    expect(page.waitForLoadState).toHaveBeenCalledWith("load", {
      timeout: 20_000,
    });
  });
});
