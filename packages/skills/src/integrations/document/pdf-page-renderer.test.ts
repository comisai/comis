import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPdfPageRenderer } from "./pdf-page-renderer.js";

// ─── @napi-rs/canvas mock ──────────────────────────────────────────────────
// vi.mock is hoisted. We control the mock canvas module to test the factory
// without requiring actual native binaries.

const mockEncode = vi.hoisted(() => vi.fn());
const mockGetContext = vi.hoisted(() => vi.fn());
const mockCreateCanvas = vi.hoisted(() => vi.fn());
const shouldFailImport = vi.hoisted(() => ({ value: false }));

vi.mock("@napi-rs/canvas", () => {
  if (shouldFailImport.value) {
    throw new Error("Cannot find module '@napi-rs/canvas'");
  }

  const canvas = {
    width: 100,
    height: 100,
    getContext: mockGetContext,
    encode: mockEncode,
  };
  mockCreateCanvas.mockReturnValue(canvas);

  return {
    createCanvas: mockCreateCanvas,
  };
});

// ─── Mock page object ──────────────────────────────────────────────────────

function createMockPage() {
  return {
    getViewport: vi.fn().mockReturnValue({ width: 100, height: 100 }),
    render: vi.fn().mockReturnValue({ promise: Promise.resolve() }),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("createPdfPageRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldFailImport.value = false;
    mockGetContext.mockReturnValue({});
    mockEncode.mockResolvedValue(Buffer.from("mock-png"));
  });

  it("returns renderer with available=false initially", () => {
    const renderer = createPdfPageRenderer();
    // Before any render call, the module has not been loaded yet
    expect(renderer.available).toBe(false);
  });

  it("returns error when @napi-rs/canvas is not importable", async () => {
    shouldFailImport.value = true;

    // Clear module cache to force re-import
    vi.resetModules();
    const { createPdfPageRenderer: freshFactory } = await import("./pdf-page-renderer.js");

    const renderer = freshFactory();
    const page = createMockPage();
    const result = await renderer.render(page, 1.5);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("@napi-rs/canvas not available");
  });

  it("renders PNG buffer for valid page mock", async () => {
    const renderer = createPdfPageRenderer();
    const page = createMockPage();

    const result = await renderer.render(page, 1.5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.isBuffer(result.value)).toBe(true);
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1.5 });
    expect(mockCreateCanvas).toHaveBeenCalledWith(100, 100);
    expect(mockGetContext).toHaveBeenCalledWith("2d");
    expect(page.render).toHaveBeenCalled();
    expect(mockEncode).toHaveBeenCalledWith("png");
  });

  it("releases canvas memory after encoding", async () => {
    const canvas = {
      width: 100,
      height: 100,
      getContext: mockGetContext,
      encode: mockEncode,
    };
    mockCreateCanvas.mockReturnValue(canvas);

    const renderer = createPdfPageRenderer();
    const page = createMockPage();

    await renderer.render(page, 1.5);

    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("caches module reference across multiple render calls", async () => {
    // Track how many times the module factory runs by checking createCanvas calls
    const renderer = createPdfPageRenderer();
    const page = createMockPage();

    await renderer.render(page, 1.5);
    await renderer.render(page, 1.5);

    // createCanvas should be called twice (once per render), but the module
    // import should only happen once. Since vi.mock returns the same module,
    // we verify caching by checking that renderer.available is true after first call.
    expect(renderer.available).toBe(true);
    expect(mockCreateCanvas).toHaveBeenCalledTimes(2);
  });
});
