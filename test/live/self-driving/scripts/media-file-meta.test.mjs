import assert from "node:assert/strict";
import test from "node:test";
import { mediaMetaForPath } from "./media-file-meta.mjs";

test("derives document metadata from a text path", () => {
  assert.deepEqual(mediaMetaForPath("/tmp/run-journal-large.txt"), {
    fileName: "run-journal-large.txt",
    mimeType: "text/plain",
  });
});

test("derives binary document and audio MIME types", () => {
  assert.deepEqual(mediaMetaForPath("/tmp/REPORT.PDF"), {
    fileName: "REPORT.PDF",
    mimeType: "application/pdf",
  });
  assert.deepEqual(mediaMetaForPath("/tmp/note.ogg"), {
    fileName: "note.ogg",
    mimeType: "audio/ogg",
  });
});

test("retains unknown filenames without fabricating a MIME type", () => {
  assert.deepEqual(mediaMetaForPath("/tmp/archive.unknown"), {
    fileName: "archive.unknown",
  });
});
