// SPDX-License-Identifier: Apache-2.0
/**
 * buildScopeArgs — the TerminalScope -> bwrap argv composer.
 *
 * Pure-function argv-assertion tests (the `bwrap-secure-profile.test.ts` idiom):
 * NO bwrap spawn — the full scope->argv matrix is macOS-testable by asserting the
 * emitted argv array. The real jail enforcement (does `cat ~/.comis` ENOENT at
 * filesystem:full?) is the VPS suite, which builds the argv via THIS
 * composer so the test proves the real mapping.
 */
import { describe, it, expect } from "vitest";

import type { TerminalScope } from "./allowlist-matcher.js";
import { buildScopeArgs, type ScopeArgsInput } from "./terminal-scope-args.js";

// -- least-privilege default scope (workspace / none / [] creds / dedicated) --
function makeScope(overrides: Partial<TerminalScope> = {}): TerminalScope {
  return {
    filesystem: "workspace",
    network: "none",
    credentialPaths: [],
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

describe("buildScopeArgs — least-privilege default scope", () => {
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

describe("buildScopeArgs — filesystem dimension", () => {
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

describe("buildScopeArgs — network dimension (the transport seam)", () => {
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
    // VPS bug (live T5 drive): bwrap processes namespace flags SEQUENTIALLY — each
    // flag mutates the unshare set in arg order, so `--share-net` BEFORE
    // `--unshare-all` is re-clobbered by the later unshare-all and the jail gets NO
    // network even at scope network:"full" (proven on the VPS by flag order alone:
    // curl 000 vs 404). The share refinement must come AFTER the namespace base.
    expect(args.indexOf("--share-net")).toBeGreaterThan(args.indexOf("--unshare-all"));
  });

  // VPS bug: the in-jail relay-as-init script itself must be RO-bound into
  // the jail. The worker spawns `bwrap [scope] -- node <relayInit> --socket … -- bin`,
  // so node inside the jail must be able to READ its own init script (the file exists
  // on the HOST but is not bound by default → `Cannot find module …/egress-relay-init.js`).
  // Bind it ONLY for listed-hosts (none/full never run the relay).
  it("listed-hosts ro-binds the relay-init script path into the jail (so in-jail node can read it)", () => {
    const args = buildScopeArgs(
      makeInput({
        scope: makeScope({ network: "listed-hosts", hosts: ["example.com"] }),
        relaySocketPath: "/tmp/egress.sock",
        relayInitScriptPath: "/opt/comis/dist/tools/builtin/terminal-driver/egress-relay-init.js",
      }),
    );
    expect(
      hasBind(
        args,
        "--ro-bind",
        "/opt/comis/dist/tools/builtin/terminal-driver/egress-relay-init.js",
        "/opt/comis/dist/tools/builtin/terminal-driver/egress-relay-init.js",
      ),
    ).toBe(true);
  });

  it("none does NOT ro-bind a relay-init script (no relay in the path)", () => {
    const args = buildScopeArgs(
      makeInput({
        scope: makeScope({ network: "none" }),
        relayInitScriptPath: "/opt/comis/dist/tools/builtin/terminal-driver/egress-relay-init.js",
      }),
    );
    expect(args).not.toContain("/opt/comis/dist/tools/builtin/terminal-driver/egress-relay-init.js");
  });

  it("full does NOT ro-bind a relay-init script (host net, no relay)", () => {
    const args = buildScopeArgs(
      makeInput({
        scope: makeScope({ network: "full" }),
        relayInitScriptPath: "/opt/comis/dist/tools/builtin/terminal-driver/egress-relay-init.js",
      }),
    );
    expect(args).not.toContain("/opt/comis/dist/tools/builtin/terminal-driver/egress-relay-init.js");
  });
});

describe("buildScopeArgs — credentialPaths dimension (tool-agnostic)", () => {
  it("RO-binds each listed credential path, expanding ~ to home (--ro-bind-try)", () => {
    const args = buildScopeArgs(
      makeInput({ scope: makeScope({ credentialPaths: ["~/.claude", "~/.claude.json"] }) }),
    );
    expect(hasBind(args, "--ro-bind-try", "/home/u/.claude", "/home/u/.claude")).toBe(true);
    expect(hasBind(args, "--ro-bind-try", "/home/u/.claude.json", "/home/u/.claude.json")).toBe(true);
  });

  it("binds an absolute path verbatim (no ~ expansion)", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialPaths: ["/etc/codex/creds"] }) }));
    expect(hasBind(args, "--ro-bind-try", "/etc/codex/creds", "/etc/codex/creds")).toBe(true);
  });

  it("is TOOL-AGNOSTIC — binds a non-Claude CLI's creds (~/.codex) the same way", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialPaths: ["~/.codex"] }) }));
    expect(hasBind(args, "--ro-bind-try", "/home/u/.codex", "/home/u/.codex")).toBe(true);
  });

  it("empty list (the default) binds nothing — no .claude, no --ro-bind-try (least-privilege)", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialPaths: [] }) }));
    expect(args).not.toContain("/home/u/.claude");
    expect(args).not.toContain("--ro-bind-try");
  });

  // Read-only-filesystem vs credentialPaths conflict (live-reproduced on the VPS): when an
  // operator RO-binds ~/.claude (or an ancestor), bwrap cannot mkdir the
  // session-env tmpfs mountpoint inside the now-read-only subtree and the WHOLE
  // jail fails to launch ("Can't mkdir …/.claude/session-env: Read-only file
  // system"). The carve-out must be dropped in that case.
  it("OMITS the session-env carve-out tmpfs when a credentialPath RO-binds ~/.claude (its parent)", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialPaths: ["~/.claude"] }) }));
    expect(indexOfPair(args, "--tmpfs", "/home/u/.claude/session-env")).toBe(-1);
    // the cred RO-bind itself is still emitted (the operator opt-in still works).
    expect(hasBind(args, "--ro-bind-try", "/home/u/.claude", "/home/u/.claude")).toBe(true);
  });

  it("OMITS the carve-out when ~ (the whole home, an ancestor of .claude) is RO-bound", () => {
    const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialPaths: ["~"] }) }));
    expect(indexOfPair(args, "--tmpfs", "/home/u/.claude/session-env")).toBe(-1);
  });

  it("KEEPS the session-env carve-out for the default ([]) and unrelated creds (~/.codex, ~/.claude.json file)", () => {
    for (const credentialPaths of [[], ["~/.codex"], ["~/.claude.json"]]) {
      const args = buildScopeArgs(makeInput({ scope: makeScope({ credentialPaths }) }));
      expect(
        indexOfPair(args, "--tmpfs", "/home/u/.claude/session-env"),
        `carve-out must remain for credentialPaths=${JSON.stringify(credentialPaths)}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildScopeArgs — uid dimension", () => {
  it("daemon omits --uid and --gid entirely", () => {
    const args = buildScopeArgs(
      makeInput({ scope: makeScope({ uid: "daemon" }), dedicatedUid: undefined }),
    );
    expect(args).not.toContain("--uid");
    expect(args).not.toContain("--gid");
  });
});

describe("buildScopeArgs — the always-on ~/.comis carve-out", () => {
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

  it("flagship: at filesystem:full the carve-out index is AFTER the broad host bind", () => {
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

  // -- agent-workspace persistence: re-expose the workspace AFTER the carve-out --
  //
  // When the session workspace is the agent's OWN workspace (default `~/.comis/
  // workspace/<agent>`, the same dir the agent's read/write/exec tools use), it
  // lives UNDER the carved-out data dir — so the `--tmpfs <dataDir>` mask would
  // shadow it and the driven child could not write there (its work would not
  // persist). buildScopeArgs must re-bind ONLY that subpath RW after the carve-out
  // so the agent's workspace is writable + persistent in the jail while the
  // secrets at sibling `~/.comis` paths (secret.db, .env, config.yaml, memory.db)
  // stay masked. (`/ws` in the other tests is OUTSIDE the data dir, so they keep
  // asserting the carve-out is last — this branch is workspace-under-dataDir only.)
  const AGENT_WS = "/home/u/.comis/workspace/agent-a";

  it("re-binds the workspace RW AFTER the carve-out when it lives UNDER the data dir (agent-workspace persistence)", () => {
    const args = buildScopeArgs(makeInput({ workspace: AGENT_WS, cwd: AGENT_WS, dataDir: "/home/u/.comis" }));
    const carveOut = lastIndexOfPair(args, "--tmpfs", "/home/u/.comis");
    const reBind = lastIndexOfPair(args, "--bind", AGENT_WS);
    expect(carveOut).toBeGreaterThanOrEqual(0);
    // the re-mount of the agent workspace wins over the mask (later mount wins)
    expect(reBind).toBeGreaterThan(carveOut);
    // it is a RW --bind (not --ro-bind) of the workspace onto itself
    expect(hasBind(args, "--bind", AGENT_WS, AGENT_WS)).toBe(true);
  });

  it("re-exposes ONLY the workspace subpath — sibling ~/.comis secret paths are NOT bound after the carve-out", () => {
    const args = buildScopeArgs(makeInput({ workspace: AGENT_WS, cwd: AGENT_WS, dataDir: "/home/u/.comis" }));
    const carveOut = lastIndexOfPair(args, "--tmpfs", "/home/u/.comis");
    // Nothing under ~/.comis OTHER than the workspace may appear after the carve-out.
    const after = args.slice(carveOut + 2);
    const reExposesSecret = after.some(
      (a) =>
        a.startsWith("/home/u/.comis") &&
        !a.startsWith(AGENT_WS) &&
        a !== "/home/u/.comis", // the tmpfs target arg itself is consumed by slice(+2)
    );
    expect(reExposesSecret).toBe(false);
  });

  it("the agent-workspace re-bind is the LAST mount before the terminator (wins over the carve-out)", () => {
    const args = buildScopeArgs(makeInput({ workspace: AGENT_WS, cwd: AGENT_WS, dataDir: "/home/u/.comis" }));
    const reBind = lastIndexOfPair(args, "--bind", AGENT_WS);
    // `--bind src dest` is a TRIPLE, so the terminator sits at reBind + 3.
    expect(reBind + 3).toBe(args.lastIndexOf("--"));
  });
});
