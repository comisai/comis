import { describe, it, expect, vi } from "vitest";
import { createExtractDocumentTool } from "./extract-document-tool.js";

describe("extract_document tool", () => {
  it("calls media.extract_document with attachment_url and max_chars", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ text: "Document content here", chars: 21 });
    const tool = createExtractDocumentTool(rpcCall);
    const result = await tool.execute("call-1", { attachment_url: "tg-file://doc.pdf", max_chars: 5000 });
    expect(rpcCall).toHaveBeenCalledWith("media.extract_document", { attachment_url: "tg-file://doc.pdf", max_chars: 5000 });
    expect(result.details).toEqual(
      expect.objectContaining({ text: "Document content here", chars: 21 }),
    );
  });

  it("omits max_chars when not provided", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ text: "Full document" });
    const tool = createExtractDocumentTool(rpcCall);
    await tool.execute("call-2", { attachment_url: "tg-file://doc.csv" });
    expect(rpcCall).toHaveBeenCalledWith("media.extract_document", { attachment_url: "tg-file://doc.csv", max_chars: undefined });
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error("Extraction failed"));
    const tool = createExtractDocumentTool(rpcCall);
    await expect(
      tool.execute("call-3", { attachment_url: "tg-file://doc.pdf" }),
    ).rejects.toThrow("Extraction failed");
  });

  it("throws when attachment_url is missing", async () => {
    const rpcCall = vi.fn().mockResolvedValue({});
    const tool = createExtractDocumentTool(rpcCall);
    await expect(tool.execute("call-4", {})).rejects.toThrow(
      "Missing required parameter: attachment_url",
    );
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
