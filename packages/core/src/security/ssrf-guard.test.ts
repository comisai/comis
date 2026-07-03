// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateUrl, validateLocalServerUrl, BLOCKED_RANGES, CLOUD_METADATA_IPS, setSsrfBlockHook } from "./ssrf-guard.js";

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

    // An SSRF block must be auditable — validateUrl fires the registered hook
    // with a closed-enum reason on the security-relevant blocks (protocol /
    // cloud_metadata / range), but NOT on a pass or a malformed/unresolvable
    // URL, and the hook NEVER affects the return.
    describe("setSsrfBlockHook audit side-channel", () => {
      afterEach(() => setSsrfBlockHook(undefined));

      it("fires reason=cloud_metadata on a metadata-IP block", async () => {
        mockLookup.mockResolvedValue({ address: "169.254.169.254", family: 4 });
        const calls: Array<{ url: string; reason: string }> = [];
        setSsrfBlockHook((info) => calls.push(info));
        const r = await validateUrl("http://169.254.169.254/latest/meta-data/?token=SECRET");
        expect(r.ok).toBe(false);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.reason).toBe("cloud_metadata");
      });

      it("fires reason=private on an RFC1918 block, and reason=protocol on a non-http scheme", async () => {
        mockLookup.mockResolvedValue({ address: "10.0.0.5", family: 4 });
        const calls: Array<{ url: string; reason: string }> = [];
        setSsrfBlockHook((info) => calls.push(info));
        await validateUrl("http://10.0.0.5/admin");
        expect(calls.at(-1)!.reason).toBe("private");
        await validateUrl("file:///etc/passwd"); // protocol blocked BEFORE dns lookup
        expect(calls.at(-1)!.reason).toBe("protocol");
      });

      it("does NOT fire on a pass, nor on a malformed URL (only real blocked targets are audited)", async () => {
        mockLookup.mockResolvedValue({ address: "1.1.1.1", family: 4 }); // public unicast → passes
        const calls: unknown[] = [];
        setSsrfBlockHook((info) => calls.push(info));
        const ok = await validateUrl("http://1.1.1.1/");
        expect(ok.ok).toBe(true);
        await validateUrl("not a url"); // invalid_url — NOT an attempt to reach a blocked target
        expect(calls).toHaveLength(0);
      });

      it("never lets a throwing hook break the guard (the Result return is unaffected)", async () => {
        mockLookup.mockResolvedValue({ address: "169.254.169.254", family: 4 });
        setSsrfBlockHook(() => {
          throw new Error("audit sink down");
        });
        const r = await validateUrl("http://169.254.169.254/");
        expect(r.ok).toBe(false); // a clean err, not a crash
      });
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

  // -------------------------------------------------------------------------
  // validateLocalServerUrl — the INVERSE verdict of validateUrl.
  //
  // validateUrl BLOCKS loopback (it guards untrusted public fetches like
  // reference_image). validateLocalServerUrl is for an operator-configured
  // LOCAL server (`transcription.local.baseUrl`): it ALLOWS loopback + an
  // explicit allowlist, and DENIES public/arbitrary egress (keeping the
  // cloud-metadata deny as defense-in-depth). A test that asserts a loopback
  // url is *rejected* would be WRONG — that is the public-fetch policy,
  // not the local-server policy.
  // -------------------------------------------------------------------------
  describe("validateLocalServerUrl", () => {
    it("ALLOWS loopback IPv4 (127.0.0.1) — the legitimate local whisper server (validateUrl would reject this)", async () => {
      mockLookup.mockResolvedValue({ address: "127.0.0.1", family: 4 });

      const result = await validateLocalServerUrl("http://127.0.0.1:8000");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hostname).toBe("127.0.0.1");
        expect(result.value.ip).toBe("127.0.0.1");
        expect(result.value.url.protocol).toBe("http:");
      }
    });

    it("ALLOWS a loopback hostname (localhost) resolving to 127.0.0.1", async () => {
      mockLookup.mockResolvedValue({ address: "127.0.0.1", family: 4 });

      const result = await validateLocalServerUrl("http://localhost:11434");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hostname).toBe("localhost");
      }
    });

    it("ALLOWS IPv6 loopback ([::1]) — strips the brackets for the DNS lookup", async () => {
      mockLookup.mockResolvedValue({ address: "::1", family: 6 });

      const result = await validateLocalServerUrl("http://[::1]:8000");
      expect(result.ok).toBe(true);
      // The lookup must receive the bracket-stripped host (mirrors validateUrl).
      expect(mockLookup).toHaveBeenCalledWith("::1");
    });

    it("rejects the cloud-metadata IP (169.254.169.254) as defense-in-depth", async () => {
      mockLookup.mockResolvedValue({ address: "169.254.169.254", family: 4 });

      const result = await validateLocalServerUrl("http://169.254.169.254/latest/meta-data");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/cloud metadata/i);
      }
    });

    it("DENIES a private host (10.0.0.5) — the core inversion (private+public both denied unless explicitly allowed)", async () => {
      mockLookup.mockResolvedValue({ address: "10.0.0.5", family: 4 });

      const result = await validateLocalServerUrl("http://10.0.0.5:8000");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/not a loopback or explicitly-allowed/i);
      }
    });

    it("DENIES an arbitrary public host (example.com) by default (loopback-only)", async () => {
      mockLookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });

      const result = await validateLocalServerUrl("http://example.com:8000");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/not a loopback or explicitly-allowed/i);
      }
    });

    it("ALLOWS an explicitly-allowed host via the allowlist opt-in", async () => {
      mockLookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });

      const result = await validateLocalServerUrl("http://example.com:8000", ["example.com"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hostname).toBe("example.com");
      }
    });

    it("DENIES a non-http protocol (ftp) — protocol check reused from ALLOWED_PROTOCOLS", async () => {
      const result = await validateLocalServerUrl("ftp://127.0.0.1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Blocked protocol");
      }
    });

    it("returns err (never throws) on an invalid URL", async () => {
      const result = await validateLocalServerUrl("not a url");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid URL");
      }
    });

    it("returns err (never throws) on a DNS resolution failure", async () => {
      mockLookup.mockRejectedValue(new Error("getaddrinfo ENOTFOUND bad.invalid"));

      const result = await validateLocalServerUrl("http://bad.invalid");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("ENOTFOUND");
      }
    });
  });
});
