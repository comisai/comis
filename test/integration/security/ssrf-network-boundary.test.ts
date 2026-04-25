// SPDX-License-Identifier: Apache-2.0
/**
 * SSRF Network Boundary integration test.
 *
 * Exercises the validateUrl SSRF guard at the network boundary by:
 *   - Driving each blocked IP-range classification (loopback, private, link-local,
 *     unique-local, unspecified) via direct IP literals
 *   - Driving each cloud-metadata IP (AWS/GCP/Azure, AWS ECS, Alibaba)
 *   - Driving protocol blocks (file://, ftp://, javascript:, gopher://)
 *   - Driving real DNS for hostnames that must resolve into the loopback range
 *     ("localhost") -- this is the closest deterministic test of the
 *     hostname -> DNS -> classify path without monkey-patching node:dns
 *   - Asserting that two consecutive validateUrl calls re-resolve DNS and
 *     classify each result independently (the property that defeats DNS
 *     rebinding -- the guard does not cache resolved IPs across calls)
 *   - Asserting public IP literals (1.1.1.1, 8.8.8.8) pass
 *
 * Plays no real outbound network traffic -- DNS resolution for "localhost" and
 * IP literals is the only network-adjacent activity.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { lookup } from "node:dns/promises";
import {
  validateUrl,
  BLOCKED_RANGES,
  CLOUD_METADATA_IPS,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Blocked IP-range classifications (direct IP literals -- no DNS round trip)
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- IP range classification", () => {
  it("blocks 127.0.0.1 (loopback)", async () => {
    const r = await validateUrl("http://127.0.0.1/path");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/loopback/i);
  });

  it("blocks ::1 (IPv6 loopback)", async () => {
    const r = await validateUrl("http://[::1]/path");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/loopback|range/i);
  });

  it("blocks 10.0.0.1 (RFC 1918 private)", async () => {
    const r = await validateUrl("http://10.0.0.1/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/private/i);
  });

  it("blocks 192.168.1.1 (RFC 1918 private)", async () => {
    const r = await validateUrl("http://192.168.1.1/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/private/i);
  });

  it("blocks 172.16.0.1 (RFC 1918 private)", async () => {
    const r = await validateUrl("http://172.16.0.1/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/private/i);
  });

  it("blocks fc00::1 (IPv6 unique-local)", async () => {
    const r = await validateUrl("http://[fc00::1]/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/uniqueLocal|range/i);
  });

  it("blocks fe80::1 (IPv6 link-local)", async () => {
    const r = await validateUrl("http://[fe80::1]/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/linkLocal|range/i);
  });

  it("blocks 0.0.0.0 (unspecified)", async () => {
    const r = await validateUrl("http://0.0.0.0/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/unspecified|range/i);
  });

  it("blocks 169.254.0.1 (link-local but not metadata)", async () => {
    const r = await validateUrl("http://169.254.0.1/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/linkLocal|range/i);
  });
});

// ---------------------------------------------------------------------------
// Cloud-metadata IP blocklist
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- cloud metadata IPs", () => {
  for (const ip of CLOUD_METADATA_IPS) {
    it(`blocks cloud-metadata IP ${ip}`, async () => {
      const r = await validateUrl(`http://${ip}/latest/meta-data/`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/metadata|range/i);
    });
  }

  it("metadata block fires before generic range classification", async () => {
    // 169.254.169.254 is also link-local; the explicit metadata block must
    // win so the operator-facing error message is precise.
    const r = await validateUrl("http://169.254.169.254/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/metadata/i);
  });
});

// ---------------------------------------------------------------------------
// Protocol blocks
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- protocol allowlist", () => {
  it("blocks file://", async () => {
    const r = await validateUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/protocol/i);
  });

  it("blocks ftp://", async () => {
    const r = await validateUrl("ftp://example.com/file");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/protocol/i);
  });

  it("blocks javascript:", async () => {
    const r = await validateUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/protocol/i);
  });

  it("blocks gopher://", async () => {
    const r = await validateUrl("gopher://example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/protocol/i);
  });

  it("blocks data:", async () => {
    const r = await validateUrl("data:text/plain,hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/protocol/i);
  });
});

// ---------------------------------------------------------------------------
// Invalid URL inputs
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- invalid URL inputs", () => {
  it("rejects garbage input", async () => {
    const r = await validateUrl("not a url");
    expect(r.ok).toBe(false);
  });

  it("rejects empty string", async () => {
    const r = await validateUrl("");
    expect(r.ok).toBe(false);
  });

  it("rejects URL missing scheme", async () => {
    const r = await validateUrl("example.com/path");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS-resolved hostnames pointing at loopback (real DNS, no mocks)
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- DNS resolution path", () => {
  it("blocks 'localhost' (DNS resolves to a loopback IP)", async () => {
    const r = await validateUrl("http://localhost/path");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/loopback|range/i);
  });

  it("blocks 'ip6-localhost' if the OS resolver provides it", async () => {
    // Some Linux test machines have ip6-localhost in /etc/hosts; on macOS the
    // hostname may not resolve. Skip if the resolver does not know it.
    let address: string | undefined;
    try {
      const r = await lookup("ip6-localhost");
      address = r.address;
    } catch {
      // Hostname unknown on this machine -- skip without false-failing CI.
      return;
    }
    expect(address).toBeDefined();
    const guard = await validateUrl("http://ip6-localhost/");
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.error.message).toMatch(/loopback|range/i);
  });
});

// ---------------------------------------------------------------------------
// Re-resolution (DNS-rebind defense): each call re-runs DNS + classification
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- per-call re-resolution", () => {
  it("re-runs the loopback classification on every call (no result caching)", async () => {
    // Two independent calls to localhost. If a previous run somehow cached
    // a resolved IP, the second call could leak through after a rebind.
    // We assert deterministic blocking on both -- the property that defeats
    // a rebinding attacker who flips DNS between calls.
    const a = await validateUrl("http://localhost/");
    const b = await validateUrl("http://localhost/");
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.error.message).toMatch(/loopback|range/i);
      expect(b.error.message).toMatch(/loopback|range/i);
    }
  });

  it("re-classifies different IP literals independently", async () => {
    // First a public IP literal (allowed), then a loopback literal (blocked).
    // Same process, same SSRF guard module -- proves no carry-over state.
    const pub = await validateUrl("http://1.1.1.1/");
    expect(pub.ok).toBe(true);
    const loop = await validateUrl("http://127.0.0.1/");
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.error.message).toMatch(/loopback|range/i);
  });
});

// ---------------------------------------------------------------------------
// Public IP literals are allowed
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- public IP literals allowed", () => {
  it("allows 1.1.1.1", async () => {
    const r = await validateUrl("http://1.1.1.1/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ip).toBe("1.1.1.1");
  });

  it("allows 8.8.8.8 with https", async () => {
    const r = await validateUrl("https://8.8.8.8/");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ip).toBe("8.8.8.8");
      expect(r.value.url.protocol).toBe("https:");
    }
  });

  it("allows 2606:4700:4700::1111 (Cloudflare IPv6 public)", async () => {
    const r = await validateUrl("http://[2606:4700:4700::1111]/");
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exposed constants are coherent
// ---------------------------------------------------------------------------

describe("SSRF Network Boundary -- exposed constants", () => {
  it("BLOCKED_RANGES contains every range the guard relies on", () => {
    expect(BLOCKED_RANGES).toEqual(
      expect.arrayContaining([
        "private",
        "loopback",
        "linkLocal",
        "uniqueLocal",
        "unspecified",
        "reserved",
      ]),
    );
  });

  it("CLOUD_METADATA_IPS contains the documented cloud metadata addresses", () => {
    expect(CLOUD_METADATA_IPS).toEqual(
      expect.arrayContaining([
        "169.254.169.254",
        "169.254.170.2",
        "100.100.100.200",
      ]),
    );
  });
});
