// SPDX-License-Identifier: Apache-2.0
/**
 * buildScopeArgs — the TerminalScope -> bwrap argv composer (SEC-02/05/13).
 *
 * Pure-function argv-assertion tests (the `bwrap-secure-profile.test.ts` idiom):
 * NO bwrap spawn — the full scope->argv matrix is macOS-testable by asserting the
 * emitted argv array. The real jail enforcement (does `cat ~/.comis` ENOENT at
 * filesystem:full?) is the VPS suite (122-07), which builds the argv via THIS
 * composer so the test proves the real mapping.
 */
import { describe, it, expect } from "vitest";

import type { TerminalScope } from "./allowlist-matcher.js";
import { buildScopeArgs, type ScopeArgsInput } from "./terminal-scope-args.js";

// -- least-privilege default scope (workspace / none / exclude / dedicated) --
function makeScope(overrides: Partial<TerminalScope> = {}): TerminalScope {
  return {
    filesystem: "workspace",
    network: "none",
    credentialHome: "exclude",
    uid: "dedicated",
    ...overrides,
  };
}

function makeInput(overrides: Partial<ScopeArgsInput> = {}): ScopeArgsInput {
  return {
    scope: makeScope(),
    bwrapPath: "/usr/bin/bwrap",
    workspace: "/ws",
    cwd: "/ws",
    home: "/home/u",
    dataDir: "/home/u/.comis",
    systemRoPaths: ["/usr", "/bin"],
    dedicatedUid: { uid: 65534, gid: 65534 },
    ...overrides,
  };
}

/** Check that args contain a flag/src/dest triple: `flag src dest`. */
function hasBind(args: string[], flag: string, src: string, dest?: string): boolean {
  const d = dest ?? src;
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag && args[i + 1] === src && args[i + 2] === d) return true;
  }
  return false;
}

/** Index of the first `flag src` pair (the position of `flag`), or -1. */
function indexOfPair(args: string[], flag: string, src: string): number {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === src) return i;
  }
  return -1;
}

/** Index of the LAST `flag src` pair (the position of `flag`), or -1. */
function lastIndexOfPair(args: string[], flag: string, src: string): number {
  for (let i = args.length - 2; i >= 0; i--) {
    if (args[i] === flag && args[i + 1] === src) return i;
  }
  return -1;
}

describe("buildScopeArgs — least-privilege default scope (SEC-02)", () => {
  it("default scope emits workspace bind, --unshare-net (no socket), no ~/.claude bind, --uid, isolation flags", () => {
    const args = buildScopeArgs(makeInput());

    // starts with the bwrap binary
    expect(args[0]).toBe("/usr/bin/bwrap");
    // system RO base reused verbatim
    expect(hasBind(args, "--ro-bind", "/usr", "/usr")).toBe(true);
    expect(hasBind(args, "--ro-bind", "/bin", "/bin")).toBe(true);
    // workspace RW bind
    expect(hasBind(args, "--bind", "/ws", "/ws")).toBe(true);
    // deny-all egress: --unshare-net, NOT --share-net
    expect(args).toContain("--unshare-net");
    expect(args).not.toContain("--share-net");
    // net-new uid/gid
    expect(indexOfPair(args, "--uid", "65534")).toBeGreaterThanOrEqual(0);
    expect(indexOfPair(args, "--gid", "65534")).toBeGreaterThanOrEqual(0);
    // isolation flags
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--new-session");
    expect(args).toContain("--die-with-parent");
    expect(indexOfPair(args, "--chdir", "/ws")).toBeGreaterThanOrEqual(0);
    // NO credential-home bind at the default (exclude)
    expect(args).not.toContain("/home/u/.claude");
    // does NOT bind daemon dotfiles (the exec profile)
    expect(args).not.toContain("/home/u/.gitconfig");
    expect(args).not.toContain("/home/u/.nvm");
    expect(args).not.toContain("/home/u/.local");
    // ends with the "--" terminator (caller appends bin + argv after)
    expect(args[args.length - 1]).toBe("--");
  });

  it("emits the special filesystems --proc /proc, --dev /dev, --dev-bind /dev/pts, --tmpfs /tmp", () => {
    const args = buildScopeArgs(makeInput());
    expect(indexOfPair(args, "--proc", "/proc")).toBeGreaterThanOrEqual(0);
    expect(indexOfPair(args, "--dev", "/dev")).toBeGreaterThanOrEqual(0);
    expect(hasBind(args, "--dev-bind", "/dev/pts", "/dev/pts")).toBe(true);
    expect(indexOfPair(args, "--tmpfs", "/tmp")).toBeGreaterThanOrEqual(0);
  });
});

describe("buildScopeArgs — filesystem dimension (SEC-02)", () => {
  it("listed-paths binds the workspace plus each scope.paths entry", () => {
    const args = buildScopeArgs(
      makeInput({ scope: makeScope({ filesystem: "listed-paths", paths: ["/data", "/opt/x"] }) }),
    );
    expect(hasBind(args, "--bind", "/ws", "/ws")).toBe(true);
    expect(hasBind(args, "--bind", "/data", "/data")).toBe(true);
    expect(hasBind(args, "--bind", "/opt/x", "/opt/x")).toBe(true);
  });

  it("home binds the whole home directory (in addition to the workspace)", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ filesystem: "home" }) }));
    expect(hasBind(args, "--bind", "/home/u", "/home/u")).toBe(true);
  });
});

describe("buildScopeArgs — network dimension (SEC-02 / SEC-07 transport seam)", () => {
  it("listed-hosts emits --unshare-net plus the relay socket bind, never --share-net", () => {
    const args = buildScopeArgs(
      makeInput({
        scope: makeScope({ network: "listed-hosts", hosts: ["example.com"] }),
        relaySocketPath: "/tmp/egress.sock",
      }),
    );
    expect(args).toContain("--unshare-net");
    expect(args).not.toContain("--share-net");
    expect(hasBind(args, "--bind", "/tmp/egress.sock", "/tmp/egress.sock")).toBe(true);
  });

  it("full emits --share-net, never --unshare-net", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ network: "full" }) }));
    expect(args).toContain("--share-net");
    expect(args).not.toContain("--unshare-net");
  });
});

describe("buildScopeArgs — credentialHome dimension (SEC-05)", () => {
  it("include emits the ~/.claude ro-bind", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialHome: "include" }) }));
    expect(hasBind(args, "--ro-bind", "/home/u/.claude", "/home/u/.claude")).toBe(true);
  });

  it("exclude emits no ~/.claude bind at all", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialHome: "exclude" }) }));
    expect(args).not.toContain("/home/u/.claude");
  });
});

describe("buildScopeArgs — uid dimension (SEC-02)", () => {
  it("daemon omits --uid and --gid entirely", () => {
    const args = buildScopeArgs(
      makeInput({ scope: makeScope({ uid: "daemon" }), dedicatedUid: undefined }),
    );
    expect(args).not.toContain("--uid");
    expect(args).not.toContain("--gid");
  });
});

describe("buildScopeArgs — the always-on ~/.comis carve-out (SEC-13)", () => {
  const FS_VALUES: TerminalScope["filesystem"][] = ["workspace", "listed-paths", "home", "full"];

  it.each(FS_VALUES)("emits the --tmpfs <dataDir> carve-out for filesystem:%s (non-configurable)", (fs) => {
    const args = buildScopeArgs(
      makeInput({ scope: makeScope({ filesystem: fs, paths: fs === "listed-paths" ? ["/data"] : undefined }) }),
    );
    expect(indexOfPair(args, "--tmpfs", "/home/u/.comis")).toBeGreaterThanOrEqual(0);
  });

  it("targets the injected dataDir, not a hardcoded ~/.comis string", () => {
    const args = buildScopeArgs(makeInput({ dataDir: "/var/lib/comis-data" }));
    expect(indexOfPair(args, "--tmpfs", "/var/lib/comis-data")).toBeGreaterThanOrEqual(0);
    expect(args).not.toContain("/home/u/.comis");
  });

  it("the carve-out is the LAST mount before the -- terminator", () => {
    const args = buildScopeArgs(makeInput());
    const carveOut = lastIndexOfPair(args, "--tmpfs", "/home/u/.comis");
    const terminator = args.lastIndexOf("--");
    expect(carveOut).toBeGreaterThanOrEqual(0);
    // the carve-out tmpfs + its arg sit immediately before "--"
    expect(carveOut + 2).toBe(terminator);
  });

  it("SEC-13 flagship: at filesystem:full the carve-out index is AFTER the broad host bind", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ filesystem: "full" }) }));
    // the full host bind (--bind / / or --bind <home> <home>) WOULD expose <home>/.comis
    const rootBind = indexOfPair(args, "--bind", "/");
    const homeBind = indexOfPair(args, "--bind", "/home/u");
    const hostBind = Math.max(rootBind, homeBind);
    expect(hostBind).toBeGreaterThanOrEqual(0);
    const carveOut = lastIndexOfPair(args, "--tmpfs", "/home/u/.comis");
    // later mount wins: the carve-out must come AFTER the host bind
    expect(carveOut).toBeGreaterThan(hostBind);
  });

  it("filesystem:full re-emits --proc/--dev/--tmpfs /tmp AFTER the broad host bind, carve-out still last", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ filesystem: "full" }) }));
    const rootBind = indexOfPair(args, "--bind", "/");
    const homeBind = indexOfPair(args, "--bind", "/home/u");
    const hostBind = Math.max(rootBind, homeBind);
    expect(hostBind).toBeGreaterThanOrEqual(0);
    // the special filesystems are re-mounted AFTER the broad host bind so it cannot clobber them
    expect(lastIndexOfPair(args, "--proc", "/proc")).toBeGreaterThan(hostBind);
    expect(lastIndexOfPair(args, "--dev", "/dev")).toBeGreaterThan(hostBind);
    expect(lastIndexOfPair(args, "--tmpfs", "/tmp")).toBeGreaterThan(hostBind);
    // and the carve-out is STILL the last mount
    const carveOut = lastIndexOfPair(args, "--tmpfs", "/home/u/.comis");
    expect(carveOut + 2).toBe(args.lastIndexOf("--"));
  });
});
