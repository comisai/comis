// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the boot-time OAuth TLS preflight wiring helper (SC-10-1).
 *
 * Two exported helpers under test:
 *   1. `hasAnyOAuthAgent(agents)` — boolean gate; true iff any agent's
 *      `provider` field is recognised by pi-ai's `getOAuthProvider`.
 *   2. `emitOAuthTlsPreflightWarn(logger)` — fire-and-forget; runs
 *      `runOAuthTlsPreflight({ timeoutMs: 4000 })` and on
 *      `kind: "tls-cert"` emits exactly one structured WARN with a
 *      distro-aware install hint; on `kind: "network"` emits a single
 *      DEBUG (no WARN); on success emits nothing.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PerAgentConfig } from "@comis/core";
import type { TlsPreflightResult } from "@comis/agent";

// ---------------------------------------------------------------------------
// Hoisted module mocks — must be defined before the import-under-test so the
// vi.mock factories see them.
// ---------------------------------------------------------------------------

const {
  mockReadFile,
  mockRunOAuthTlsPreflight,
  mockGetOAuthProvider,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockRunOAuthTlsPreflight: vi.fn(),
  mockGetOAuthProvider: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("@comis/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/agent")>();
  return {
    ...actual,
    runOAuthTlsPreflight: mockRunOAuthTlsPreflight,
  };
});

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProvider: mockGetOAuthProvider,
}));

// Import after mocks are registered.
import { hasAnyOAuthAgent, emitOAuthTlsPreflightWarn } from "./oauth-preflight.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedLog {
  level: "warn" | "debug";
  payload: Record<string, unknown>;
  message: string;
}

function makeMockLogger(): { logger: unknown; calls: CapturedLog[] } {
  const calls: CapturedLog[] = [];
  const logger = {
    trace: vi.fn(),
    debug: vi.fn((payload: Record<string, unknown>, message: string) => {
      calls.push({ level: "debug", payload, message });
    }),
    info: vi.fn(),
    warn: vi.fn((payload: Record<string, unknown>, message: string) => {
      calls.push({ level: "warn", payload, message });
    }),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return { logger, calls };
}

/** Minimal PerAgentConfig stub with a typed `provider` field. */
function makeAgent(provider: string): PerAgentConfig {
  return { provider } as unknown as PerAgentConfig;
}

// ---------------------------------------------------------------------------
// hasAnyOAuthAgent
// ---------------------------------------------------------------------------

describe("hasAnyOAuthAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for an empty agents map (Test 7)", () => {
    expect(hasAnyOAuthAgent({})).toBe(false);
    expect(mockGetOAuthProvider).not.toHaveBeenCalled();
  });

  it("returns false when no agent's provider is recognised by pi-ai (Test 8)", () => {
    mockGetOAuthProvider.mockReturnValue(undefined);
    const agents: Record<string, PerAgentConfig> = {
      a: makeAgent("anthropic"),
      b: makeAgent("default"),
    };
    expect(hasAnyOAuthAgent(agents)).toBe(false);
    expect(mockGetOAuthProvider).toHaveBeenCalledWith("anthropic");
    expect(mockGetOAuthProvider).toHaveBeenCalledWith("default");
  });

  it("returns true when at least one agent uses an OAuth-recognised provider (Test 9)", () => {
    mockGetOAuthProvider.mockImplementation((p: string) =>
      p === "openai-codex" ? { id: "openai-codex" } : undefined,
    );
    const agents: Record<string, PerAgentConfig> = {
      a: makeAgent("anthropic"),
      b: makeAgent("openai-codex"),
    };
    expect(hasAnyOAuthAgent(agents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// emitOAuthTlsPreflightWarn
// ---------------------------------------------------------------------------

describe("emitOAuthTlsPreflightWarn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test 1: emits exactly one WARN with alpine hint on tls-cert failure", async () => {
    const certResult: TlsPreflightResult = {
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    };
    mockRunOAuthTlsPreflight.mockResolvedValue(certResult);
    mockReadFile.mockResolvedValue("ID=alpine\nID_LIKE=");

    const { logger, calls } = makeMockLogger();
    await emitOAuthTlsPreflightWarn(logger as never);

    const warns = calls.filter((c) => c.level === "warn");
    const debugs = calls.filter((c) => c.level === "debug");
    expect(warns).toHaveLength(1);
    expect(debugs).toHaveLength(0);

    expect(warns[0]!.payload).toMatchObject({
      module: "oauth-tls-preflight",
      errorKind: "oauth_tls_cert",
      hint: "apk add ca-certificates && update-ca-certificates",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
  });

  it("Test 2: emits debian/ubuntu hint on tls-cert failure with ID=ubuntu", async () => {
    mockRunOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    } as TlsPreflightResult);
    mockReadFile.mockResolvedValue("ID=ubuntu\nID_LIKE=debian");

    const { logger, calls } = makeMockLogger();
    await emitOAuthTlsPreflightWarn(logger as never);

    const warns = calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.payload.hint).toBe(
      "sudo apt-get install -y ca-certificates && sudo update-ca-certificates",
    );
  });

  it("Test 3: falls back to generic hint for an unknown distro", async () => {
    mockRunOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "tls-cert",
      code: "CERT_HAS_EXPIRED",
      message: "certificate has expired",
    } as TlsPreflightResult);
    mockReadFile.mockResolvedValue("ID=unknownos\nID_LIKE=");

    const { logger, calls } = makeMockLogger();
    await emitOAuthTlsPreflightWarn(logger as never);

    const warns = calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.payload.hint).toBe(
      "Install ca-certificates via your distro's package manager and retry",
    );
  });

  it("Test 4: falls back to generic hint when /etc/os-release is missing", async () => {
    mockRunOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      message: "unable to verify the first certificate",
    } as TlsPreflightResult);
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReadFile.mockRejectedValue(enoent);

    const { logger, calls } = makeMockLogger();
    await emitOAuthTlsPreflightWarn(logger as never);

    const warns = calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.payload.hint).toBe(
      "Install ca-certificates via your distro's package manager and retry",
    );
  });

  it("Test 5: emits exactly one DEBUG (no WARN) on network failure", async () => {
    mockRunOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "network",
      message: "ECONNREFUSED",
    } as TlsPreflightResult);

    const { logger, calls } = makeMockLogger();
    await emitOAuthTlsPreflightWarn(logger as never);

    const warns = calls.filter((c) => c.level === "warn");
    const debugs = calls.filter((c) => c.level === "debug");
    expect(warns).toHaveLength(0);
    expect(debugs).toHaveLength(1);
    expect(debugs[0]!.payload).toMatchObject({
      module: "oauth-tls-preflight",
      errorKind: "oauth_tls_network",
      message: "ECONNREFUSED",
    });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("Test 6: emits nothing when the preflight succeeds", async () => {
    mockRunOAuthTlsPreflight.mockResolvedValue({ ok: true } as TlsPreflightResult);

    const { logger, calls } = makeMockLogger();
    await emitOAuthTlsPreflightWarn(logger as never);

    expect(calls).toHaveLength(0);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("Test 10: passes timeoutMs: 4000 (boot-tighter than the doctor's 5000)", async () => {
    mockRunOAuthTlsPreflight.mockResolvedValue({ ok: true } as TlsPreflightResult);

    const { logger } = makeMockLogger();
    await emitOAuthTlsPreflightWarn(logger as never);

    expect(mockRunOAuthTlsPreflight).toHaveBeenCalledTimes(1);
    expect(mockRunOAuthTlsPreflight).toHaveBeenCalledWith({ timeoutMs: 4000 });
  });
});
