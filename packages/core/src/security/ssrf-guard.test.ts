import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateUrl, BLOCKED_RANGES, CLOUD_METADATA_IPS } from "./ssrf-guard.js";

// Mock dns/promises so we get deterministic results without real DNS
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

// Import the mock after vi.mock
import { lookup } from "node:dns/promises";
const mockLookup = vi.mocked(lookup);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SSRF Guard", () => {
  describe("exports", () => {
    it("exports BLOCKED_RANGES with expected entries", () => {
      expect(BLOCKED_RANGES).toContain("private");
      expect(BLOCKED_RANGES).toContain("loopback");
      expect(BLOCKED_RANGES).toContain("linkLocal");
      expect(BLOCKED_RANGES).toContain("uniqueLocal");
      expect(BLOCKED_RANGES).toContain("unspecified");
      expect(BLOCKED_RANGES).toContain("reserved");
    });

    it("exports CLOUD_METADATA_IPS with known addresses", () => {
      expect(CLOUD_METADATA_IPS).toContain("169.254.169.254");
      expect(CLOUD_METADATA_IPS).toContain("169.254.170.2");
      expect(CLOUD_METADATA_IPS).toContain("100.100.100.200");
    });
  });

  describe("validateUrl", () => {
    it("blocks loopback addresses (127.0.0.1)", async () => {
      mockLookup.mockResolvedValue({ address: "127.0.0.1", family: 4 });

      const result = await validateUrl("http://127.0.0.1/secret");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("loopback");
      }
    });

    it("blocks private addresses (192.168.x.x)", async () => {
      mockLookup.mockResolvedValue({ address: "192.168.1.1", family: 4 });

      const result = await validateUrl("http://192.168.1.1/admin");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("private");
      }
    });

    it("blocks private addresses (10.x.x.x)", async () => {
      mockLookup.mockResolvedValue({ address: "10.0.0.1", family: 4 });

      const result = await validateUrl("http://10.0.0.1/internal");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("private");
      }
    });

    it("blocks cloud metadata addresses (169.254.169.254)", async () => {
      mockLookup.mockResolvedValue({ address: "169.254.169.254", family: 4 });

      const result = await validateUrl("http://169.254.169.254/latest/meta-data/");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/cloud metadata|linkLocal/i);
      }
    });

    it("blocks non-http protocols (ftp)", async () => {
      const result = await validateUrl("ftp://example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Blocked protocol");
      }
    });

    it("rejects invalid URLs", async () => {
      const result = await validateUrl("not-a-url");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid URL");
      }
    });

    it("allows public IPs (example.com resolving to 93.184.216.34)", async () => {
      mockLookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });

      const result = await validateUrl("https://example.com");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hostname).toBe("example.com");
        expect(result.value.ip).toBe("93.184.216.34");
        expect(result.value.url.protocol).toBe("https:");
      }
    });

    it("blocks IPv6 loopback (::1)", async () => {
      mockLookup.mockResolvedValue({ address: "::1", family: 6 });

      const result = await validateUrl("http://[::1]/secret");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("loopback");
      }
    });

    it("handles DNS resolution failures gracefully", async () => {
      mockLookup.mockRejectedValue(new Error("getaddrinfo ENOTFOUND bad.invalid"));

      const result = await validateUrl("http://bad.invalid");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("ENOTFOUND");
      }
    });

    it("blocks Alibaba Cloud metadata (100.100.100.200)", async () => {
      mockLookup.mockResolvedValue({ address: "100.100.100.200", family: 4 });

      const result = await validateUrl("http://metadata.tencentyun.com/");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("cloud metadata");
      }
    });

    it("blocks AWS ECS metadata (169.254.170.2)", async () => {
      mockLookup.mockResolvedValue({ address: "169.254.170.2", family: 4 });

      const result = await validateUrl("http://169.254.170.2/v2/metadata");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/cloud metadata|linkLocal/i);
      }
    });

    it("blocks unspecified address (0.0.0.0)", async () => {
      mockLookup.mockResolvedValue({ address: "0.0.0.0", family: 4 });

      const result = await validateUrl("http://0.0.0.0/");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("unspecified");
      }
    });

  });
});
