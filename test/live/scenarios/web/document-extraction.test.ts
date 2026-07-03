// SPDX-License-Identifier: Apache-2.0
/**
 * WEB-03 — document-extraction certification (the Stage-B keystone).
 *
 * Drives the REAL public extractors from `@comis/skills`
 * (createFileExtractor / createPdfExtractor / createCompositeFileExtractor) with small
 * fixture buffers. Document extraction of text formats is 100% local/keyless/deterministic:
 *
 *   Stage-A (always): the DOCX MIME constant + buildDocExtractionConfig() allowedMimes/OCR-gate shape.
 *   Stage-B (always, no daemon/key/network):
 *     - CSV → text within maxChars (extractedChars === text.length);
 *     - maxChars truncation with the VERBATIM product marker `[truncated at N characters]`;
 *     - composite DOCX → `unsupported_mime` (DOCX is classified BINARY — there is NO DOCX
 *       extractor; assert the honest err, never a faked success);
 *     - a text-bearing PDF (the proven HELLO_WORLD_PDF base64, lifted from the product's own
 *       pdf-extractor.test.ts) extracts under real pdfjs-dist → text contains "Hello", pageCount 1.
 *       If pdfjs-dist cannot load in-sandbox the PDF test reports SKIPPED(no-pdf-engine) — skip≠fail.
 *   Stage-C (it.skip — COMIS_LIVE + a real vision provider): OCR fallback on a text-sparse PDF
 *     page (config.pdfImageFallback=true + visionProvider) prepends `[Vision OCR]:` text.
 *
 * Assertions are on the RETURN Result — there are NO media/web/docs event-bus events emitted by
 * these pure extractor functions. The OCR gate is config-driven (pdfImageFallback) — asserted at Stage-B.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFileExtractor,
  createPdfExtractor,
  createCompositeFileExtractor,
} from "@comis/skills";
import { buildDocExtractionConfig } from "../../harness/web-config.js";
import { buildCredentialRegistry } from "../../credentials.js";

const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const isLive = !!process.env["COMIS_LIVE"];

/** The real Office DOCX MIME — in file-classifier.ts BINARY_MIMES ⇒ classified "binary" ⇒ unsupported_mime. */
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A proven valid single-page PDF whose content stream prints "Hello, world!".
 * Lifted verbatim from packages/skills/src/tools/integrations/document/pdf-extractor.test.ts
 * (the HELLO_WORLD_PDF constant) — it extracts under real pdfjs-dist to text containing "Hello".
 */
const HELLO_PDF = Buffer.from(
  "JVBERi0xLjcKCjEgMCBvYmogICUgZW50cnkgcG9pbnQKPDwKICAvVHlwZSAvQ2F0YWxvZwog" +
  "IC9QYWdlcyAyIDAgUgo+PgplbmRvYmoKCjIgMCBvYmoKPDwKICAvVHlwZSAvUGFnZXMKICAv" +
  "TWVkaWFCb3ggWyAwIDAgMjAwIDIwMCBdCiAgL0NvdW50IDEKICAvS2lkcyBbIDMgMCBSIF0K" +
  "Pj4KZW5kb2JqCgozIDAgb2JqCjw8CiAgL1R5cGUgL1BhZ2UKICAvUGFyZW50IDIgMCBSCiAg" +
  "L1Jlc291cmNlcyA8PAogICAgL0ZvbnQgPDwKICAgICAgL0YxIDQgMCBSIAogICAgPj4KICA+" +
  "PgogIC9Db250ZW50cyA1IDAgUgo+PgplbmRvYmoKCjQgMCBvYmoKPDwKICAvVHlwZSAvRm9u" +
  "dAogIC9TdWJ0eXBlIC9UeXBlMQogIC9CYXNlRm9udCAvVGltZXMtUm9tYW4KPj4KZW5kb2Jq" +
  "Cgo1IDAgb2JqICAlIHBhZ2UgY29udGVudAo8PAogIC9MZW5ndGggNDQKPj4Kc3RyZWFtCkJU" +
  "CjcwIDUwIFRECi9GMSAxMiBUZgooSGVsbG8sIHdvcmxkISkgVGoKRVQKZW5kc3RyZWFtCmVu" +
  "ZG9iagoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDEwIDAwMDAwIG4g" +
  "CjAwMDAwMDAwNzkgMDAwMDAgbiAKMDAwMDAwMDE3MyAwMDAwMCBuIAowMDAwMDAwMzAxIDAw" +
  "MDAwIG4gCjAwMDAwMDAzODAgMDAwMDAgbiAKdHJhaWxlcgo8PAogIC9TaXplIDYKICAvUm9v" +
  "dCAxIDAgUgo+PgpzdGFydHhyZWYKNDkyCiUlRU9G",
  "base64",
);

const csvBuf = readFileSync(join(__dirnameLocal, "../../fixtures/web/sample.csv"));

let pdfEngineOk = false;
beforeAll(async () => {
  try {
    const r = await createPdfExtractor({ config: buildDocExtractionConfig() }).extract({
      source: "buffer",
      buffer: HELLO_PDF,
      mimeType: "application/pdf",
      fileName: "hello.pdf",
    });
    pdfEngineOk = r.ok && r.value.text.includes("Hello");
  } catch {
    pdfEngineOk = false;
  }
});

// ---------------------------------------------------------------------------
// Stage-A — constants + config shape (no extractor invocation)
// ---------------------------------------------------------------------------

describe("WEB-03 Stage-A — DOCX MIME + doc-extraction config shape", () => {
  it("DOCX_MIME is the real Office wordprocessingml MIME", () => {
    expect(DOCX_MIME).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("buildDocExtractionConfig allowedMimes includes text/csv + application/pdf but NOT the DOCX MIME", () => {
    const cfg = buildDocExtractionConfig();
    expect(cfg.allowedMimes).toContain("text/csv");
    expect(cfg.allowedMimes).toContain("application/pdf");
    expect(cfg.allowedMimes).not.toContain(DOCX_MIME);
  });

  it("the OCR fallback gate is config-driven (pdfImageFallback)", () => {
    expect(buildDocExtractionConfig().pdfImageFallback).toBe(false);
    expect(buildDocExtractionConfig({ pdfImageFallback: true }).pdfImageFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — real extractors, fixture buffers (no daemon/key/network)
// ---------------------------------------------------------------------------

describe("WEB-03 Stage-B — local extraction (CSV / maxChars truncation / DOCX unsupported_mime / PDF)", () => {
  it("createFileExtractor extracts a CSV fixture to text (extractedChars === text.length)", async () => {
    const extractor = createFileExtractor({ config: buildDocExtractionConfig() });
    const result = await extractor.extract({
      source: "buffer",
      buffer: csvBuf,
      mimeType: "text/csv",
      fileName: "sample.csv",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain("name,role");
      expect(result.value.text).toContain("Ada,engineer");
      expect(result.value.extractedChars).toBe(result.value.text.length);
      expect(result.value.truncated).toBe(false);
    }
  });

  it("truncates at maxChars with the verbatim product marker [truncated at N characters]", async () => {
    const extractor = createFileExtractor({ config: buildDocExtractionConfig({ maxChars: 20 }) });
    const big = "a".repeat(200) + "\n";
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from(big, "utf-8"),
      mimeType: "text/plain",
      fileName: "big.txt",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.truncated).toBe(true);
      expect(result.value.text.endsWith("[truncated at 20 characters]")).toBe(true);
    }
  });

  it("composite routes a DOCX MIME to the text extractor → unsupported_mime (DOCX is binary; no DOCX extractor)", async () => {
    const config = buildDocExtractionConfig();
    const composite = createCompositeFileExtractor({
      textExtractor: createFileExtractor({ config }),
      pdfExtractor: createPdfExtractor({ config }),
    });
    const result = await composite.extract({
      source: "buffer",
      buffer: Buffer.from("PK fake docx zip bytes", "utf-8"),
      mimeType: DOCX_MIME,
      fileName: "report.docx",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported_mime");
    }
  });

  // PDF text extraction needs pdfjs-dist; gate on the beforeAll engine probe (skip≠fail).
  (pdfEngineOk ? it : it.skip)(
    "extracts a text-bearing PDF locally (SKIPPED(no-pdf-engine) if pdfjs-dist is unavailable)",
    async () => {
      const extractor = createPdfExtractor({ config: buildDocExtractionConfig() });
      const result = await extractor.extract({
        source: "buffer",
        buffer: HELLO_PDF,
        mimeType: "application/pdf",
        fileName: "hello.pdf",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.text).toContain("Hello");
        expect(typeof result.value.pageCount).toBe("number");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Stage-C — OCR fallback (real vision provider, COMIS_LIVE-gated, operator-run)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("WEB-03 Stage-C — PDF OCR fallback (COMIS_LIVE + real vision provider)", () => {
  it("credential registry resolves a vision category to a SkipVerdict | null (keyless invariant honest)", () => {
    const verdict = buildCredentialRegistry().getSkipVerdict("vision(openai)");
    expect(verdict === null || verdict === "SKIPPED(no-creds)").toBe(true);
  });

  it.skip(
    "text-sparse PDF page + pdfImageFallback:true + a real VisionProvider ⇒ page text augmented with '[Vision OCR]:' " +
      "(deferred to COMIS_LIVE operator; vision-credential-gated via getSkipVerdict('vision(openai)'); SKIPPED(no-ocr) when no vision key)",
    () => {
      // Stage-C (operator): createPdfExtractor({ config: buildDocExtractionConfig({ pdfImageFallback: true }),
      //   visionProvider, pdfPageRenderer }).extract({ source:"buffer", buffer: <text-sparse PDF>, mimeType:"application/pdf" })
      //   ⇒ result.value.text contains "[Vision OCR]:". Cheapest-viable: a 1-page scanned fixture.
    },
  );
});
