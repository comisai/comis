/**
 * PDF page renderer -- createPdfPageRenderer() factory.
 *
 * Renders individual PDF pages to PNG using @napi-rs/canvas via dynamic import.
 * Used by pdf-extractor.ts for vision fallback on text-sparse pages.
 *
 * @napi-rs/canvas is loaded lazily to allow graceful degradation when
 * the native binary is not installed. The module reference is cached
 * after first load.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Render scale for PDF pages (1.5 = sufficient for LLM OCR, ~4.4MB per US Letter page). */
export const RENDER_SCALE = 1.5;

/** Maximum number of pages per document that can be sent to vision API (cost control). */
export const MAX_VISION_PAGES = 5;

// ─── Interface ──────────────────────────────────────────────────────────────

/**
 * PDF page renderer -- renders a pdfjs-dist page to a PNG buffer.
 *
 * `page` is typed as `unknown` to avoid importing pdfjs-dist types
 * (same pattern as existing pdf-extractor.ts code).
 */
export interface PdfPageRenderer {
  render(page: unknown, scale: number): Promise<Result<Buffer, Error>>;
  readonly available: boolean;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a PdfPageRenderer that uses @napi-rs/canvas for rendering.
 *
 * The factory dynamically imports @napi-rs/canvas on first render call
 * and caches the module reference for subsequent calls.
 *
 * @param deps - Optional logger for debug output
 * @returns PdfPageRenderer implementation
 */
export function createPdfPageRenderer(deps?: {
  logger?: {
    debug?(obj: Record<string, unknown>, msg: string): void;
  };
}): PdfPageRenderer {
  let canvasModule: typeof import("@napi-rs/canvas") | null = null;
  let checked = false;

  async function ensureCanvas(): Promise<typeof import("@napi-rs/canvas") | null> {
    if (checked) return canvasModule;
    checked = true;
    try {
      canvasModule = await import("@napi-rs/canvas");
    } catch {
      deps?.logger?.debug?.(
        {},
        "@napi-rs/canvas not available, PDF image fallback disabled",
      );
    }
    return canvasModule;
  }

  return {
    get available() {
      return canvasModule !== null;
    },

    async render(page: unknown, scale: number): Promise<Result<Buffer, Error>> {
      const mod = await ensureCanvas();
      if (!mod) {
        return err(new Error("@napi-rs/canvas not available"));
      }

      try {
        // Type-narrow the page object from unknown
        const pdfPage = page as {
          getViewport(opts: { scale: number }): { width: number; height: number };
          render(ctx: {
            canvasContext: CanvasRenderingContext2D;
            viewport: { width: number; height: number };
          }): { promise: Promise<void> };
        };

        const viewport = pdfPage.getViewport({ scale });
        const canvas = mod.createCanvas(
          Math.floor(viewport.width),
          Math.floor(viewport.height),
        );
        const context = canvas.getContext("2d");

        // Cast context: @napi-rs/canvas context is compatible with pdfjs-dist
        // rendering but TypeScript types don't align
        await pdfPage.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        // Async encode in libuv thread pool (non-blocking -- NOT encodeSync)
        const pngBuffer = await canvas.encode("png");

        // Release canvas memory
        canvas.width = 0;
        canvas.height = 0;

        return ok(Buffer.from(pngBuffer));
      } catch (e: unknown) {
        return err(
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    },
  };
}
