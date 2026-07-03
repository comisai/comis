// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-coverage tests for doctor/checks/oauth-health.ts — covers paths
 * not exercised by the existing oauth-health.test.ts (mostly distro install
 * hints, refresh-test error paths, encrypted-mode + store-open-failure, and
 * the readOsRelease null-return path).
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { OAuthProfile, OAuthCredentialStorePort } from "@comis/core";
import type { DoctorContext, DoctorFinding } from "../types.js";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, stat: vi.fn(), readFile: vi.fn() };
});

vi.mock("@comis/core", async () => {
  const actual =
    await vi.importActual<typeof import("@comis/core")>("@comis/core");
  return {
    ...actual,
    selectOAuthCredentialStore: vi.fn(),
    runOAuthTlsPreflight: vi.fn(),
  };
});

// Encrypted-mode oauth check routes through the daemon auth.list RPC.
// Mock the daemon probe to false here (deterministic encrypted daemon-DOWN skip).
vi.mock("../../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(async () => false),
}));
vi.mock("../../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  callTyped: vi.fn(async () => ({ profiles: [] })),
}));

const fs = await import("node:fs/promises");
const agent = await import("@comis/core");
const { oauthHealthCheck } = await import("./oauth-health.js");

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

function buildProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: "openai-codex",
    profileId: "openai-codex:user_a@example.com",
    access: "test-access-token",
    refresh: "test-refresh-token",
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    accountId: "acct_test_a",
    email: "user_a@example.com",
    displayName: "User A",
    version: 1,
    ...overrides,
  };
}

interface FakeStoreOptions {
  list?: () => Promise<Result<OAuthProfile[], Error>>;
}

function buildStoreMock(opts: FakeStoreOptions = {}): OAuthCredentialStorePort {
  const list =
    opts.list ?? (async () => ok<OAuthProfile[], Error>([]));
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(list),
    has: vi.fn(),
  } as unknown as OAuthCredentialStorePort;
}

beforeEach(() => {
  vi.mocked(fs.stat).mockReset();
  vi.mocked(fs.readFile).mockReset();
  vi.mocked(agent.selectOAuthCredentialStore).mockReset();
  vi.mocked(agent.runOAuthTlsPreflight).mockReset();
  // Default mocks: bundle missing forces readOsRelease + hint path
  vi.mocked(fs.stat).mockRejectedValue(
    Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
  );
  vi.mocked(agent.runOAuthTlsPreflight).mockResolvedValue({ ok: true });
  vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(buildStoreMock());
});

const ORIGINAL_HTTPS_PROXY = process.env["HTTPS_PROXY"];
const ORIGINAL_HTTPS_PROXY_LC = process.env["https_proxy"];
beforeEach(() => {
  delete process.env["HTTPS_PROXY"];
  delete process.env["https_proxy"];
});
afterEach(() => {
  if (ORIGINAL_HTTPS_PROXY === undefined) {
    delete process.env["HTTPS_PROXY"];
  } else {
    process.env["HTTPS_PROXY"] = ORIGINAL_HTTPS_PROXY;
  }
  if (ORIGINAL_HTTPS_PROXY_LC === undefined) {
    delete process.env["https_proxy"];
  } else {
    process.env["https_proxy"] = ORIGINAL_HTTPS_PROXY_LC;
  }
});

// ---------------------------------------------------------------------------
// readOsRelease + caCertificatesInstallHint distro branches
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — ca-certificates install hints per distro identifier", () => {
  it("returns fedora dnf hint when /etc/os-release ID=fedora and no CA bundle is present", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("ID=fedora\nID_LIKE=\n");
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("dnf install");
    expect(caFinding!.suggestion).toContain("ca-certificates");
  });

  it("returns rhel dnf hint when /etc/os-release ID_LIKE includes rhel and no CA bundle is present", async () => {
    vi.mocked(fs.readFile).mockResolvedValue('ID=rocky\nID_LIKE="rhel centos fedora"\n');
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("dnf install");
  });

  it("returns arch pacman hint when /etc/os-release ID=arch and no CA bundle is present", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("ID=arch\nID_LIKE=\n");
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("pacman");
    expect(caFinding!.suggestion).toContain("trust extract-compat");
  });

  it("returns suse zypper hint when /etc/os-release ID_LIKE contains suse", async () => {
    vi.mocked(fs.readFile).mockResolvedValue('ID=opensuse-leap\nID_LIKE="suse opensuse"\n');
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("zypper install");
    expect(caFinding!.suggestion).toContain("ca-certificates");
  });

  it("returns generic install hint when /etc/os-release ID is an unknown distro identifier", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("ID=somerare\nID_LIKE=\n");
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("distro's package manager");
  });

  it("returns generic install hint when readOsRelease throws (cannot read /etc/os-release)", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("EACCES"));
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("distro's package manager");
  });

  it("returns generic hint when /etc/os-release exists but has no ID line at all", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("VERSION=12\nPRETTY_NAME=\"unknown\"\n");
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("distro's package manager");
  });
});

// ---------------------------------------------------------------------------
// HTTPS_PROXY lowercase variant branch
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — HTTPS_PROXY lowercase variant detection", () => {
  it("warns when only the lowercase https_proxy env var is set (uppercase unset)", async () => {
    process.env["https_proxy"] = "http://lowercase-proxy.example.com:3128";
    const findings = await oauthHealthCheck.run(baseContext);
    const proxyFinding = findings.find((f) => f.check === "HTTPS_PROXY");
    expect(proxyFinding!.status).toBe("warn");
    expect(proxyFinding!.message).toContain("ignores it by default");
  });
});

// ---------------------------------------------------------------------------
// store-open failure path
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — store-open failure", () => {
  it("emits fail finding when selectOAuthCredentialStore throws synchronously during file-store open", async () => {
    vi.mocked(agent.selectOAuthCredentialStore).mockImplementation(() => {
      throw new Error("EACCES: cannot read profile store");
    });
    const findings = await oauthHealthCheck.run(baseContext);
    const profileStore = findings.find((f) => f.check === "Profile store");
    expect(profileStore!.status).toBe("fail");
    expect(profileStore!.message).toContain("Failed to open OAuth store");
    expect(profileStore!.message).toContain("EACCES");
  });

  it("wraps a non-Error throw value via String() coercion in the open-failure message", async () => {
    vi.mocked(agent.selectOAuthCredentialStore).mockImplementation(() => {
      // Throwing a string (non-Error) to exercise the String() coercion branch
      throw "raw string error";
    });
    const findings = await oauthHealthCheck.run(baseContext);
    const profileStore = findings.find((f) => f.check === "Profile store");
    expect(profileStore!.status).toBe("fail");
    expect(profileStore!.message).toContain("raw string error");
  });
});

// ---------------------------------------------------------------------------
// list() failure surfaces verbatim
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — store.list() schema-mismatch surfacing", () => {
  it("surfaces store.list() error verbatim in Profile schema finding when version mismatch is detected", async () => {
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({
        list: async () =>
          err(
            new Error(
              "version mismatch: file has schema 2 but CLI expects 1. Hint: delete ~/.comis/oauth/profiles.json and re-run comis auth login",
            ),
          ),
      }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    const schemaFinding = findings.find((f) => f.check === "Profile schema");
    expect(schemaFinding!.status).toBe("fail");
    expect(schemaFinding!.message).toContain("version mismatch");
    expect(schemaFinding!.message).toContain("Hint:");
    // Per-profile findings are NOT emitted after schema mismatch
    const profileFindings = findings.filter((f) => f.check.startsWith("Profile openai-codex"));
    expect(profileFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Encrypted storage skip branch
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — encrypted storage skips CLI-side profile reading", () => {
  it("returns a skip pointing at the daemon when encrypted + daemon DOWN", async () => {
    const findings = await oauthHealthCheck.run({
      ...baseContext,
      config: { security: { storage: "encrypted" } } as never,
    });
    const skipFinding = findings.find(
      (f) => f.check === "Profile store" && f.status === "skip",
    );
    expect(skipFinding).toBeDefined();
    expect(skipFinding!.message).toContain("encrypted");
    // Encrypted-mode reads via the daemon RPC; the daemon-DOWN skip
    // tells the operator to start the daemon (the RPC source) rather than
    // a "run on the daemon host" hint.
    expect(skipFinding!.suggestion).toMatch(/start the daemon|security\.storage/i);
  });
});

// ---------------------------------------------------------------------------
// refreshTest error paths (non-JSON body, fetch throws, HTTP non-ok with no error description)
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — refreshTest error paths", () => {
  it("falls back to HTTP status code when refresh response body is not parseable JSON", async () => {
    const profile = buildProfile();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not-json-text-body", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    try {
      const findings = await oauthHealthCheck.run({
        ...baseContext,
        refreshTest: true,
      });
      const refreshFinding = findings.find((f) => f.check.includes("refresh test"));
      expect(refreshFinding!.status).toBe("fail");
      // The message should mention HTTP status when JSON parse fails
      expect(refreshFinding!.message.toLowerCase()).toMatch(/refresh|http|500/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("surfaces network error when fetch itself throws (DNS / firewall / connection refused)", async () => {
    const profile = buildProfile();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ENOTFOUND auth.openai.com"),
    );
    try {
      const findings = await oauthHealthCheck.run({
        ...baseContext,
        refreshTest: true,
      });
      const refreshFinding = findings.find((f) => f.check.includes("refresh test"));
      expect(refreshFinding!.status).toBe("fail");
      expect(refreshFinding!.message).toContain("ENOTFOUND");
      expect(refreshFinding!.suggestion).toContain("auth.openai.com");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("surfaces fetch-throw non-Error value via String() coercion in refresh test", async () => {
    const profile = buildProfile();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      // Throwing a plain object (non-Error) to exercise the String() branch
      { custom: "non-error throw" },
    );
    try {
      const findings = await oauthHealthCheck.run({
        ...baseContext,
        refreshTest: true,
      });
      const refreshFinding = findings.find((f) => f.check.includes("refresh test"));
      expect(refreshFinding!.status).toBe("fail");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Profile-expiry near boundary
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — profile expiry redacted-email fallback", () => {
  it("uses profileId as identityLabel when redactEmailForLog returns undefined for missing email", async () => {
    const profile = buildProfile({ email: undefined as unknown as string });
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    const profileFinding = findings.find((f) =>
      f.check.startsWith("Profile openai-codex"),
    );
    expect(profileFinding).toBeDefined();
    // The identityLabel falls back to profileId when email is absent
    expect(profileFinding!.message).toContain("openai-codex:user_a@example.com");
  });
});
