// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// -- Mocks (verbatim from bwrap-provider.test.ts) --

vi.mock(import("node:fs"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, existsSync: vi.fn().mockReturnValue(false) },
    existsSync: vi.fn().mockReturnValue(false),
  };
});

vi.mock(import("node:child_process"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock(import("node:os"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: vi.fn().mockReturnValue("/home/testuser") },
    homedir: vi.fn().mockReturnValue("/home/testuser"),
  };
});

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { BwrapProvider } from "./bwrap-provider.js";
import type { SandboxOptions } from "./types.js";

function makeOpts(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workspacePath: "/home/agent/workspace",
    sharedPaths: [],
    readOnlyPaths: [],
    cwd: "/home/agent/workspace",
    tempDir: "/home/agent/workspace/.tmp",
    ...overrides,
  };
}

function createAvailableProvider(): BwrapProvider {
  vi.mocked(execFileSync).mockReturnValue("/usr/bin/bwrap\n");
  const provider = new BwrapProvider();
  provider.available();
  return provider;
}

/** Check that args contain a --bind or --ro-bind triple: flag src dest */
const hasBind = (args: string[], flag: string, src: string, dest?: string): boolean => {
  const d = dest ?? src;
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag && args[i + 1] === src && args[i + 2] === d) return true;
  }
  return false;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bwrap secure profile — network mode + credential home gating (EGRESS-01/02/03)", () => {
  it("default profile (no network field) → --share-net present, --unshare-net absent (EGRESS-03 regression guard)", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const provider = createAvailableProvider();
    const args = provider.buildArgs(makeOpts());

    expect(args).toContain("--share-net");
    expect(args).not.toContain("--unshare-net");
  });

  it("broker-only profile emits --unshare-net, not --share-net (EGRESS-01)", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const provider = createAvailableProvider();
    const args = provider.buildArgs(
      makeOpts({
        network: { mode: "broker-only", brokerSocketPath: "/run/comis/broker-test.sock" },
      }),
    );

    expect(args).toContain("--unshare-net");
    expect(args).not.toContain("--share-net");
  });

  it("broker-only profile → --bind triple for brokerSocketPath (EGRESS-01 socket bind)", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const provider = createAvailableProvider();
    const args = provider.buildArgs(
      makeOpts({
        network: { mode: "broker-only", brokerSocketPath: "/run/comis/broker-test.sock" },
      }),
    );

    expect(
      hasBind(args, "--bind", "/run/comis/broker-test.sock", "/run/comis/broker-test.sock"),
    ).toBe(true);
  });

  it("secureCredentialHome:true → ~/.claude absent from args (EGRESS-02)", () => {
    // existsSync returns true for all paths to exercise the "path exists but is gated" path
    vi.mocked(existsSync).mockReturnValue(true);

    const provider = createAvailableProvider();
    const args = provider.buildArgs(makeOpts({ secureCredentialHome: true }));

    // ~/.claude must not appear as a bind target in any position
    expect(args).not.toContain("/home/testuser/.claude");
  });

  it("secureCredentialHome:true → ~/.claude.json absent from args (EGRESS-02 Pitfall 2 guard)", () => {
    // existsSync returns true for all paths
    vi.mocked(existsSync).mockReturnValue(true);

    const provider = createAvailableProvider();
    const args = provider.buildArgs(makeOpts({ secureCredentialHome: true }));

    // ~/.claude.json must not appear as a bind target (not --ro-bind, not --bind)
    expect(args).not.toContain("/home/testuser/.claude.json");
  });

  it("secureCredentialHome:true → ~/.local/share/claude absent from args (EGRESS-02)", () => {
    // existsSync returns true for all paths
    vi.mocked(existsSync).mockReturnValue(true);

    const provider = createAvailableProvider();
    const args = provider.buildArgs(makeOpts({ secureCredentialHome: true }));

    // ~/.local/share/claude must not appear as a bind target
    expect(args).not.toContain("/home/testuser/.local/share/claude");
  });

  it("secureCredentialHome:true → ~/.local/share parent NOT RW-bound OR masked with tmpfs at claude subpath (CR-01 parent-bind bypass)", () => {
    // existsSync returns true for ALL paths (worst-case: ~/.local/share/claude exists on disk)
    vi.mocked(existsSync).mockReturnValue(true);

    const provider = createAvailableProvider();
    const args = provider.buildArgs(makeOpts({ secureCredentialHome: true }));

    // The credential subpath ~/.local/share/claude must NOT be reachable.
    // Either the parent ~/.local/share must NOT be RW-bound, OR a tmpfs/empty
    // mask must exist at the claude subpath AFTER the parent bind.
    const parentBound = hasBind(args, "--bind", "/home/testuser/.local/share", "/home/testuser/.local/share");
    const claudeMasked = (() => {
      // A --tmpfs <path> mask anywhere after the parent bind closes the hole.
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "--tmpfs" && args[i + 1] === "/home/testuser/.local/share/claude") return true;
      }
      return false;
    })();

    // Pass if: parent is not bound (safest) OR parent is bound but masked
    const credentialSubpathIsolated = !parentBound || claudeMasked;
    expect(credentialSubpathIsolated).toBe(true);
  });

  it("secureCredentialHome:false (default) → ~/.claude present when path exists (no-regression)", () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const existing = [
        "/home/testuser/.claude",
        "/home/testuser/.claude.json",
        "/home/testuser/.local/share/claude",
      ];
      return existing.includes(String(p));
    });

    const provider = createAvailableProvider();
    const args = provider.buildArgs(makeOpts({ secureCredentialHome: false }));

    // ~/.claude must be rw-bound when secureCredentialHome is false and path exists
    expect(hasBind(args, "--bind", "/home/testuser/.claude", "/home/testuser/.claude")).toBe(true);
  });
});
