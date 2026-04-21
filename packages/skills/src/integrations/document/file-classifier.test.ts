// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyFile } from "./file-classifier.js";
import { DOCUMENT_MIME_WHITELIST } from "@comis/core";

const allowedMimes = new Set<string>(DOCUMENT_MIME_WHITELIST);

describe("classifyFile", () => {
  describe("document classification", () => {
    it("classifies text/plain as document", () => {
      expect(classifyFile("text/plain", allowedMimes)).toBe("document");
    });

    it("classifies application/pdf as document", () => {
      expect(classifyFile("application/pdf", allowedMimes)).toBe("document");
    });

    it("classifies text/csv as document", () => {
      expect(classifyFile("text/csv", allowedMimes)).toBe("document");
    });

    it("classifies text/markdown as document", () => {
      expect(classifyFile("text/markdown", allowedMimes)).toBe("document");
    });

    it("classifies application/json as document", () => {
      expect(classifyFile("application/json", allowedMimes)).toBe("document");
    });

    it("classifies text/x-typescript as document", () => {
      expect(classifyFile("text/x-typescript", allowedMimes)).toBe("document");
    });

    it("classifies text/x-python as document", () => {
      expect(classifyFile("text/x-python", allowedMimes)).toBe("document");
    });

    it("classifies application/x-sh as document", () => {
      expect(classifyFile("application/x-sh", allowedMimes)).toBe("document");
    });
  });

  describe("binary classification", () => {
    it("classifies image/png as binary", () => {
      expect(classifyFile("image/png", allowedMimes)).toBe("binary");
    });

    it("classifies image/jpeg as binary", () => {
      expect(classifyFile("image/jpeg", allowedMimes)).toBe("binary");
    });

    it("classifies audio/mpeg as binary", () => {
      expect(classifyFile("audio/mpeg", allowedMimes)).toBe("binary");
    });

    it("classifies audio/ogg as binary", () => {
      expect(classifyFile("audio/ogg", allowedMimes)).toBe("binary");
    });

    it("classifies video/mp4 as binary", () => {
      expect(classifyFile("video/mp4", allowedMimes)).toBe("binary");
    });

    it("classifies video/webm as binary", () => {
      expect(classifyFile("video/webm", allowedMimes)).toBe("binary");
    });

    it("classifies application/zip as binary", () => {
      expect(classifyFile("application/zip", allowedMimes)).toBe("binary");
    });

    it("classifies application/gzip as binary", () => {
      expect(classifyFile("application/gzip", allowedMimes)).toBe("binary");
    });

    it("classifies application/x-tar as binary", () => {
      expect(classifyFile("application/x-tar", allowedMimes)).toBe("binary");
    });

    it("classifies application/x-7z-compressed as binary", () => {
      expect(classifyFile("application/x-7z-compressed", allowedMimes)).toBe("binary");
    });

    it("classifies DOCX as binary", () => {
      expect(
        classifyFile(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          allowedMimes,
        ),
      ).toBe("binary");
    });

    it("classifies XLSX as binary", () => {
      expect(
        classifyFile(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          allowedMimes,
        ),
      ).toBe("binary");
    });

    it("classifies PPTX as binary", () => {
      expect(
        classifyFile(
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          allowedMimes,
        ),
      ).toBe("binary");
    });

    it("classifies application/x-msdownload as binary", () => {
      expect(classifyFile("application/x-msdownload", allowedMimes)).toBe("binary");
    });

    it("classifies application/x-bzip2 as binary", () => {
      expect(classifyFile("application/x-bzip2", allowedMimes)).toBe("binary");
    });
  });

  describe("unknown classification", () => {
    it("returns unknown for undefined MIME type", () => {
      expect(classifyFile(undefined, allowedMimes)).toBe("unknown");
    });

    it("returns unknown for application/octet-stream (not in whitelist)", () => {
      expect(classifyFile("application/octet-stream", allowedMimes)).toBe("unknown");
    });

    it("returns unknown for text/plain when NOT in allowedMimes", () => {
      const emptyAllowed = new Set<string>();
      expect(classifyFile("text/plain", emptyAllowed)).toBe("unknown");
    });

    it("returns unknown for unrecognized MIME type", () => {
      expect(classifyFile("application/x-custom-format", allowedMimes)).toBe("unknown");
    });
  });
});
