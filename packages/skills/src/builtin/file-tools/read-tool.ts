// SPDX-License-Identifier: Apache-2.0
/**
 * Native read tool: file reading with line numbers, pagination, encoding
 * awareness, notebook rendering, dedup, and security guards.
 *
 * Replaces pi-mono createReadTool + 3-layer wrapper stack (safePath +
 * pathSuggestion + fileStateGuards) with a single self-contained factory.
 * Follows the exec-tool.ts pattern: factory function returning AgentTool.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import { extname } from "node:path";
import { safePath, PathTraversalError } from "@comis/core";
import type { FileStateTracker } from "../file/file-state-tracker.js";
import { isDeviceFile } from "../file/file-state-tracker.js";
import { suggestSimilarPaths } from "../file/path-suggest.js";
import { type LazyPaths, resolvePaths } from "../file/safe-path-wrapper.js";
import { readStringParam, readNumberParam } from "../platform/tool-helpers.js";
import { readFileWithMetadata } from "./shared/file-encoding.js";
import { parseNotebook, renderNotebookCells } from "./shared/notebook-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 2000;

/** Maximum file size in bytes (1 GiB). Files above this are rejected. */
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger interface (skills does not import @comis/infra). */
interface ToolLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ReadParams = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file to read (relative to workspace or absolute)",
    }),
    offset: Type.Optional(
      Type.Integer({
        description:
          "Line number to start reading from (0-based). Use with limit for pagination.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum number of lines to read. Defaults to 2000.",
        default: 2000,
      }),
    ),
    pages: Type.Optional(
      Type.String({
        description:
          "Page range for PDF files (e.g., '1-5', '3', '10-20'). " +
          "Defaults to all pages up to 50. Maximum 50 pages per request.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try to stat a file with Unicode fallbacks for macOS path quirks.
 * Returns the first successful stat result and the resolved path,
 * or null if all attempts fail.
 */
async function statWithFallbacks(
  filePath: string,
): Promise<{ stat: import("node:fs").Stats; resolvedPath: string } | null> {
  // Attempt 1: exact path
  try {
    return { stat: await fs.stat(filePath), resolvedPath: filePath };
  } catch {
    // continue to fallbacks
  }

  // Attempt 2: thin space (U+202F) <-> regular space (U+0020)
  const thinSpaceVariant = filePath.includes("\u202F")
    ? filePath.replace(/\u202F/g, " ")
    : filePath.replace(/ /g, "\u202F");
  try {
    return { stat: await fs.stat(thinSpaceVariant), resolvedPath: thinSpaceVariant };
  } catch {
    // continue
  }

  // Attempt 3: NFD <-> NFC normalization
  const nfdVariant = filePath.normalize("NFD");
  if (nfdVariant !== filePath) {
    try {
      return { stat: await fs.stat(nfdVariant), resolvedPath: nfdVariant };
    } catch {
      // continue
    }
  }
  const nfcVariant = filePath.normalize("NFC");
  if (nfcVariant !== filePath) {
    try {
      return { stat: await fs.stat(nfcVariant), resolvedPath: nfcVariant };
    } catch {
      // continue
    }
  }

  // Attempt 4: combined (thin space + NFD)
  const combinedVariant = thinSpaceVariant.normalize("NFD");
  if (combinedVariant !== filePath && combinedVariant !== thinSpaceVariant && combinedVariant !== nfdVariant) {
    try {
      return { stat: await fs.stat(combinedVariant), resolvedPath: combinedVariant };
    } catch {
      // all fallbacks exhausted
    }
  }

  return null;
}

/**
 * Format byte size as human-readable string.
 * Examples: "512B", "4.1KB", "1.3MB", "1.1GB"
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`;
}

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------

/** Maximum pages extractable in a single read call. */
const MAX_PDF_PAGES = 50;

/**
 * Parse a pages parameter string into start/end page numbers.
 *
 * Supports: single page ("5"), range ("3-7"), undefined (default to all up to maxPages).
 * Clamps values within [1, totalPages] and caps span at maxPages.
 *
 * Exported with underscore prefix for test access (project convention).
 */
export function _parsePageRangeForTest(
  range: string | undefined,
  totalPages: number,
  maxPages: number,
): { start: number; end: number } {
  return parsePageRange(range, totalPages, maxPages);
}

function parsePageRange(
  range: string | undefined,
  totalPages: number,
  maxPages: number,
): { start: number; end: number } {
  if (!range) {
    return { start: 1, end: Math.min(totalPages, maxPages) };
  }
  if (/^\d+$/.test(range)) {
    const page = Math.max(1, Math.min(parseInt(range, 10), totalPages));
    return { start: page, end: page };
  }
  const match = range.match(/^(\d+)-(\d+)$/);
  if (match) {
    const start = Math.max(1, parseInt(match[1], 10));
    const end = Math.min(totalPages, parseInt(match[2], 10));
    if (end - start + 1 > maxPages) {
      return { start, end: start + maxPages - 1 };
    }
    return { start, end };
  }
  // Invalid format: fall back to defaults
  return { start: 1, end: Math.min(totalPages, maxPages) };
}

interface PdfExtractResult {
  text: string;
  pageCount: number;
  totalPages: number;
  extractedChars: number;
}

interface PdfExtractError {
  kind: "encrypted" | "parse";
  message: string;
}

/**
 * Extract text from a PDF file using pdfjs-dist (lazy dynamic import).
 *
 * Returns page-separated text with "--- Page N ---" markers.
 * Follows the same pdfjs-dist patterns as pdf-extractor.ts.
 */
async function extractPdfText(
  filePath: string,
  options: { pages?: string; maxChars: number },
): Promise<Result<PdfExtractResult, PdfExtractError>> {
  try {
    const buffer = await fs.readFile(filePath);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;

    try {
      const { start, end } = parsePageRange(options.pages, pdf.numPages, MAX_PDF_PAGES);

      const texts: string[] = [];
      for (let i = start; i <= end; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = (content.items as readonly Record<string, unknown>[])
          .filter(
            (item): item is Record<string, unknown> & { str: string; hasEOL: boolean } =>
              typeof item === "object" && item !== null && "str" in item,
          )
          .map((item) => item.str + (item.hasEOL ? "\n" : ""))
          .join("");
        texts.push(`--- Page ${i} ---\n${pageText}`);
      }

      let text = texts.join("\n\n");
      if (text.length > options.maxChars) {
        text = text.slice(0, options.maxChars) + `\n[truncated at ${options.maxChars} characters]`;
      }

      return ok({
        text,
        pageCount: end - start + 1,
        totalPages: pdf.numPages,
        extractedChars: text.length,
      });
    } finally {
      await pdf.destroy();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("password") ||
      msg.includes("encrypted") ||
      (typeof e === "object" && e !== null && (e as Record<string, unknown>).name === "PasswordException")
    ) {
      return err({ kind: "encrypted", message: "PDF is password-protected" });
    }
    return err({ kind: "parse", message: `Failed to extract PDF: ${msg}` });
  }
}

/**
 * Resolve a read path through the workspace -> readOnlyPaths -> sharedPaths
 * fallback chain. Returns the resolved absolute path.
 *
 * Throws Error with [path_traversal] prefix when the path cannot be resolved
 * through any allowed root.
 */
function resolveReadPath(
  workspacePath: string,
  filePath: string,
  readOnlyPaths: string[] | undefined,
  sharedPaths: LazyPaths | undefined,
): string {
  // Try workspace first
  try {
    return safePath(workspacePath, filePath);
  } catch (error) {
    if (!(error instanceof PathTraversalError)) throw error;
  }

  // Try readOnlyPaths
  if (readOnlyPaths) {
    for (const roPath of readOnlyPaths) {
      try {
        return safePath(roPath, filePath);
      } catch (error) {
        if (!(error instanceof PathTraversalError)) throw error;
        // This readOnlyPath didn't match -- try next
      }
    }
  }

  // Try sharedPaths (lazily resolved)
  const resolved = resolvePaths(sharedPaths);
  for (const sp of resolved) {
    try {
      return safePath(sp, filePath);
    } catch (error) {
      if (!(error instanceof PathTraversalError)) throw error;
      // This sharedPath didn't match -- try next
    }
  }

  throw new Error(`[path_traversal] Path outside workspace bounds: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the native read tool.
 *
 * Returns an AgentTool that reads files with line numbers, pagination,
 * encoding awareness, notebook rendering, dedup stubs, and security guards.
 *
 * @param workspacePath - Workspace root directory (all relative paths resolve against this)
 * @param logger - Optional pino-compatible logger
 * @param tracker - Optional FileStateTracker for dedup and state recording
 * @param readOnlyPaths - Optional additional paths that the read tool may access
 * @param sharedPaths - Optional shared paths (lazily resolved) accessible by all tools
 */
export function createComisReadTool(
  workspacePath: string,
  logger?: ToolLogger,
  tracker?: FileStateTracker,
  readOnlyPaths?: string[],
  sharedPaths?: LazyPaths,
): AgentTool<typeof ReadParams> {
  // Comis extension: promptGuidelines (not part of AgentTool type, spread to bypass excess property check)
  const ext = { promptGuidelines: [
    "Use offset/limit for files larger than 2000 lines instead of reading the whole file.",
    "For PDFs, use the `pages` parameter to read specific page ranges (max 50 pages).",
    "If file not found, use `find` or `grep` to locate the correct path.",
  ] };
  return {
    ...ext,
    name: "read",
    label: "Read",
    description:
      "Read a file with line numbers and optional pagination (offset + limit). " +
      "Returns content with line number prefixes for reference. Handles text files, " +
      "images (returned as-is for multimodal), PDFs (text extraction with page range support), " +
      "and common encodings (UTF-8, UTF-16LE). " +
      "Use offset/limit for large files. Use pages param for PDFs. Error if file not found -- safe to try.",
    parameters: ReadParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      // Extract params
      const filePath = readStringParam(params, "path")!;
      const offset = readNumberParam(params, "offset", false) ?? 0;
      const limit = readNumberParam(params, "limit", false) ?? DEFAULT_LIMIT;

      // V1+V2: Path resolution (workspace -> readOnlyPaths -> sharedPaths)
      const resolvedPath = resolveReadPath(
        workspacePath,
        filePath,
        readOnlyPaths,
        sharedPaths,
      );

      // V3: Device file blocking
      if (isDeviceFile(resolvedPath)) {
        throw new Error(
          "[device_file] Cannot read device file: " + resolvedPath,
        );
      }

      // V4: File existence + stat with Unicode fallbacks (macOS screenshot paths)
      const fallbackResult = await statWithFallbacks(resolvedPath);
      if (!fallbackResult) {
        const suggestions = suggestSimilarPaths(resolvedPath, workspacePath);
        const hint =
          suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(", ")}?`
            : " Use find or grep to locate the correct path.";
        throw new Error(`[file_not_found] File not found: ${filePath}.${hint}`);
      }
      const { stat, resolvedPath: actualPath } = fallbackResult;

      // V5: File size limit (1 GiB)
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(
          `[file_too_large] File too large (${formatSize(stat.size)}). Maximum: 1 GiB`,
        );
      }

      // V6: PDF text extraction (inline, replacing old rejection)
      if (extname(actualPath).toLowerCase() === ".pdf") {
        const pagesParam = readStringParam(params as Record<string, unknown>, "pages", false);
        const pdfResult = await extractPdfText(actualPath, {
          pages: pagesParam ?? undefined,
          maxChars: 200_000,
        });
        if (!pdfResult.ok) {
          if (pdfResult.error.kind === "encrypted") {
            throw new Error("[pdf_encrypted] PDF is password-protected. Cannot extract text.");
          }
          throw new Error(`[pdf_error] ${pdfResult.error.message}`);
        }

        const { text, pageCount, totalPages, extractedChars } = pdfResult.value;

        const lines = text.split("\n");
        const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join("\n");

        const header =
          pageCount < totalPages
            ? `[PDF: pages 1-${pageCount} of ${totalPages} (${formatSize(stat.size)}). Use pages param for specific range.]`
            : `[PDF: ${totalPages} page(s) (${formatSize(stat.size)})]`;

        const pdfRawBuf = await fs.readFile(actualPath);
        tracker?.recordRead(actualPath, stat.mtimeMs, undefined, undefined, pdfRawBuf);

        return {
          content: [{ type: "text", text: `${header}\n${numbered}` }],
          details: {
            pdf: true,
            pageCount,
            totalPages,
            extractedChars,
            sizeBytes: stat.size,
            filePath: actualPath,  // For microcompaction guard recovery detection
          },
        };
      }

      // V7: Dedup check
      if (tracker) {
        const stub = tracker.shouldReturnStub(
          actualPath,
          stat.mtimeMs,
          stat.size,
          offset,
          limit,
        );
        if (stub) {
          return {
            content: [{ type: "text", text: stub }],
            details: { stub: true },
          };
        }
      }

      // V8: Notebook rendering
      if (extname(actualPath).toLowerCase() === ".ipynb") {
        const raw = await fs.readFile(actualPath, "utf-8");
        const parseResult = parseNotebook(raw);
        if (!parseResult.ok) {
          throw new Error(
            `[read_error] Failed to parse notebook: ${parseResult.error.message}`,
          );
        }

        // Pass the original filePath (not actualPath) for jq hints
        const rendered = renderNotebookCells(parseResult.value, {
          filePath,
        });

        // Record read state (no offset/limit for notebooks, pass content for hash)
        tracker?.recordRead(actualPath, stat.mtimeMs, undefined, undefined, Buffer.from(raw, "utf-8"));

        logger?.debug(
          { path: filePath, cells: parseResult.value.cells.length },
          "Notebook read complete",
        );

        return {
          content: [{ type: "text", text: rendered }],
          details: {
            notebook: true,
            cells: parseResult.value.cells.length,
            sizeBytes: stat.size,
            filePath: actualPath,  // For microcompaction guard recovery detection
          },
        };
      }

      // Normal file read via I/O bridge
      const fileData = await readFileWithMetadata(actualPath);

      // Line-number formatting + pagination
      const lines = fileData.content.split("\n");
      const totalLines = lines.length;
      const sliced = lines.slice(offset, offset + limit);
      const numbered = sliced
        .map((line, i) => `${offset + i + 1}\t${line}`)
        .join("\n");

      // Build output with optional pagination header/footer
      let output = "";
      if (offset > 0 || offset + limit < totalLines) {
        const endLine = Math.min(offset + limit, totalLines);
        output += `[Reading lines ${offset + 1}-${endLine} of ${totalLines} (file: ${formatSize(stat.size)})]\n`;
        output += numbered;
        if (offset + limit < totalLines) {
          output += "\n[Use offset/limit to read more]";
        }
      } else {
        output = numbered;
      }

      // Record read state (pass content for full reads to enable content-hash staleness fallback)
      const isFullRead = params.offset === undefined && params.limit === undefined;
      const contentBuf = isFullRead ? Buffer.from(fileData.content, "utf-8") : undefined;
      tracker?.recordRead(actualPath, stat.mtimeMs, offset, limit, contentBuf);

      logger?.debug(
        {
          path: filePath,
          lines: totalLines,
          encoding: fileData.encoding,
          lineEnding: fileData.lineEnding,
          sizeBytes: fileData.sizeBytes,
        },
        "File read complete",
      );

      const readDetails = {
        totalLines,
        startLine: offset + 1,
        endLine: Math.min(offset + limit, totalLines),
        sizeBytes: stat.size,
        encoding: fileData.encoding,
        paginated: offset > 0 || offset + limit < totalLines,
        filePath: actualPath,  // For microcompaction guard recovery detection
      };

      return {
        content: [{ type: "text", text: output }],
        details: readDetails,
      };
    },
  };
}
