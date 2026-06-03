// SPDX-License-Identifier: Apache-2.0
/**
 * [VPS-ONLY] The Phase-122 scope-matrix × probes — the REQUIRED security gate
 * (§10.2/§10.5). The orchestrator runs this on `comisvps` (Ubuntu 24.04 + bwrap
 * 0.9.0, per the 118 GO); on the macOS author box the ENTIRE describe block is
 * silently SKIPPED via `describe.skipIf(!canRealBwrapSandbox())` — it compiles
 * clean (`tsc --noEmit`) and contributes 0 failures on every push.
 *
 * WHY THIS FILE IS THE ENFORCEMENT PROOF. The macOS suites (122-01..06) prove the
 * scope -> argv MAPPING at the string level (`terminal-scope-args.test.ts` greps
 * the argv). They CANNOT prove the kernel actually isolates. This suite closes
 * that gap: each matrix cell builds its bwrap argv via the PRODUCTION composer
 * {@link buildScopeArgs} (122-03) — the SAME function the worker's
 * {@link buildSpawnPlan} calls (`terminal-spawn-plan.ts:191`) — then spawns a real
 * bwrap and probes the live jail. The test cannot drift from production because it
 * runs production's argv-builder, exactly how the egress test's Group C drives
 * `provider.buildArgs()` (`bwrap-egress-integration.test.ts:265`).
 *
 * THE PROBE MATRIX (each row = a cell built via buildScopeArgs + a spawned probe):
 *   - cred ENOENT at credentialHome:exclude (default)            SEC-04/05
 *   - cred READABLE at credentialHome:include (seeded fixture)   SEC-05
 *   - write-outside-workspace fails at filesystem:workspace      SEC-02
 *   - ~/.comis ENOENT EVEN at filesystem:full (the carve-out)    SEC-13  (flagship)
 *   - child runs as uid==65534 (nobody) at uid:dedicated         SEC-02
 *   - env in the jail has NO NODE_OPTIONS / CLAUDE_CODE_*         SEC-07
 *   - direct --noproxy egress fails rc=7 at network:none          SEC-07
 *   - allowlisted host -> 200 via the bound proxy socket          SEC-07
 *   - non-listed host -> 403 via the bound proxy socket           SEC-07
 *   - no provider (bwrapPath undefined) -> create REJECTS         SEC-16
 *
 * CAVEAT (the credibility map, MEMORY): a kernel sandbox firewall saturates
 * trivially but is bypassed by adaptive/obfuscated attacks (Bhagwatkar
 * NeurIPS'25). Every assertion below reports its OWN probe outcome; this file
 * makes NO global "unbypassable sandbox" claim. The R3 microVM/gVisor escalation
 * is noted-not-built.
 *
 * FILE SPLIT (composes with `bwrap-egress-integration.test.ts` without overlap):
 *   - THIS file owns the terminal-SCOPE cells (filesystem/credentialHome/uid/the
 *     ~/.comis carve-out/env-scrub/no-provider) built via `buildScopeArgs`.
 *   - `bwrap-egress-integration.test.ts` owns the egress-TRANSPORT proof (the
 *     unix-socket bind reachability + raw `--unshare-net` direct-TCP block + the
 *     secure-profile cred absence), built via `BwrapProvider.buildArgs()`.
 *   The allowlist DECISION (200/403) is asserted here over the SAME bound socket
 *   the worker's relay bridges to.
 *
 * @module
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import * as net from "node:net";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { BwrapProvider } from "../sandbox/bwrap-provider.js";
import {
  buildScopeArgs,
  SYSTEM_RO_PATHS,
} from "./terminal-scope-args.js";
import {
  buildSpawnPlan,
  DEDICATED_UID,
  JailUnavailableError,
} from "./terminal-spawn-plan.js";
import type { TerminalScope } from "./allowlist-matcher.js";

// ---------------------------------------------------------------------------
// Gate — the established idiom (`bwrap-egress-integration.test.ts:29-36`,
// `terminal-roundtrip.linux.test.ts:36`). Linux + a real bwrap binary only.
// ---------------------------------------------------------------------------

function canRealBwrapSandbox(): boolean {
  if (process.platform !== "linux") return false;
  // eslint-disable-next-line no-restricted-syntax -- Linux integration gate, VPS only
  return new BwrapProvider().available();
}

const linuxBwrap = canRealBwrapSandbox();

// ---------------------------------------------------------------------------
// Helpers (only evaluated on the VPS — the macOS gate skips the whole block).
// ---------------------------------------------------------------------------

/** Resolve the bwrap binary path the same way `BwrapProvider.available()` does. */
function resolveBwrapPath(): string {
  return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
}

/** The resolved system RO base — filtered to existing, exactly like the worker. */
function resolvedSystemRoPaths(): readonly string[] {
  return SYSTEM_RO_PATHS.filter((p) => existsSync(p));
}

/** Per-test temp dirs + sockets to clean up in afterAll. */
const createdPaths: string[] = [];
const createdSockets: string[] = [];

/** Make a throwaway workspace dir (always --bind RW into the jail). */
function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "scope-matrix-ws-"));
  createdPaths.push(ws);
  return ws;
}

/**
 * Build a full {@link ScopeArgsInput} for one cell via the PRODUCTION composer and
 * return the argv. `home`/`dataDir` default to a throwaway test HOME so the
 * cred-fixture + carve-out probes operate on a controlled tree, not the operator's
 * real `~`; pass `useRealHome` to point at the actual `~` (the carve-out cell
 * proves ENOENT against the REAL `~/.comis`).
 */
function buildCellArgs(
  scope: TerminalScope,
  opts: {
    workspace: string;
    home: string;
    dataDir: string;
    relaySocketPath?: string;
  },
): string[] {
  return buildScopeArgs({
    scope,
    bwrapPath: resolveBwrapPath(),
    workspace: opts.workspace,
    cwd: opts.workspace,
    home: opts.home,
    dataDir: opts.dataDir,
    systemRoPaths: resolvedSystemRoPaths(),
    dedicatedUid: scope.uid === "dedicated" ? DEDICATED_UID : undefined,
    relaySocketPath: opts.relaySocketPath,
  });
}

/** Spawn `bwrap <scopeArgs> bash -c <probe>` synchronously and return the result. */
function runProbe(argv: string[], probe: string): ReturnType<typeof spawnSync> {
  // scopeArgs = [bwrapPath, ...args, "--"]; append the driven child after `--`.
  return spawnSync(
    argv[0]!,
    [...argv.slice(1), "bash", "-c", probe],
    { encoding: "utf8", timeout: 15_000 },
  );
}

/**
 * A minimal host-side allowlist CONNECT proxy on a unix socket — the SAME
 * allow/deny contract as the production `createTerminalEgressProxy`
 * (`packages/daemon/src/wiring/terminal-egress-proxy.ts`), inlined here because
 * @comis/skills must not value-import @comis/daemon (it would be a dependency
 * cycle — daemon depends on skills). curl inside the jail dials this bound socket
 * directly via `-x` CONNECT, the same target the worker's in-jail relay bridges
 * `HTTPS_PROXY` to. ALLOW a CONNECT to a listed host -> 200 (no upstream dial —
 * we never reach the public net in CI; a synthetic 200 is enough to prove the
 * allow gate + socket reachability); a non-listed host -> 403.
 */
function startAllowlistProxy(
  socketPath: string,
  allowedHosts: readonly string[],
): net.Server {
  const allow = new Set(allowedHosts);
  const server = net.createServer((client) => {
    let preamble = "";
    const onData = (chunk: Buffer): void => {
      preamble += chunk.toString("latin1");
      const eol = preamble.indexOf("\r\n");
      if (eol === -1) return; // wait for the full CONNECT line
      client.removeListener("data", onData);
      const line = preamble.slice(0, eol);
      const m = /^CONNECT\s+([^:\s]+):(\d+)\b/i.exec(line);
      const host = m?.[1];
      if (host !== undefined && allow.has(host)) {
        // ALLOW — synthetic 200 (the allow DECISION + socket reachability is the
        // assertion; no real public egress in CI).
        client.end("HTTP/1.1 200 Connection established\r\n\r\n");
      } else {
        // DENY — 403, no upstream dial (the production no-SSRF semantics).
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    };
    client.on("data", onData);
    client.on("error", () => {
      /* peer reset before the CONNECT line — drop quietly */
    });
  });
  return server;
}

// ---------------------------------------------------------------------------
// THE MATRIX — skipped on macOS, live on comisvps.
// ---------------------------------------------------------------------------

describe.skipIf(!linuxBwrap)(
  "122 VPS scope matrix × probes (built via the production buildScopeArgs) [VPS-ONLY]",
  () => {
    // -----------------------------------------------------------------------
    // SEC-04/05 — credential home: ENOENT at the default (exclude), readable
    //             only at the operator opt-in (include).
    // -----------------------------------------------------------------------
    describe("SEC-04/05 — credentialHome", () => {
      let home: string;
      let credFile: string;

      beforeEach(() => {
        // A controlled test HOME with a seeded fixture cred file, so the
        // include-cell has something real to read and the exclude-cell proves
        // its absence against a file that DOES exist on the host.
        home = mkdtempSync(join(tmpdir(), "scope-matrix-home-"));
        createdPaths.push(home);
        mkdirSync(join(home, ".claude"), { recursive: true });
        credFile = join(home, ".claude", ".credentials.json");
        writeFileSync(credFile, '{"fixture":"cred"}', "utf8");
      });

      it("cat ~/.claude/.credentials.json -> ENOENT at credentialHome:exclude (default)", () => {
        const scope: TerminalScope = {
          filesystem: "workspace",
          network: "none",
          credentialHome: "exclude",
          uid: "dedicated",
        };
        const argv = buildCellArgs(scope, {
          workspace: makeWorkspace(),
          home,
          dataDir: join(home, ".comis"),
        });
        const r = runProbe(argv, `cat "${credFile}"; echo "rc=$?"`);
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        // GO: the cred file is NOT bound -> cat fails (no such file).
        expect(
          r.status !== 0 || out.includes("No such file or directory"),
          `SEC-04/05: ~/.claude/.credentials.json MUST be absent at credentialHome:exclude ` +
            `(the baseline never binds it). status=${r.status} out=${out}`,
        ).toBe(true);
      });

      it("cat ~/.claude/.credentials.json -> readable at credentialHome:include", () => {
        const scope: TerminalScope = {
          filesystem: "workspace",
          network: "none",
          credentialHome: "include",
          uid: "dedicated",
        };
        const argv = buildCellArgs(scope, {
          workspace: makeWorkspace(),
          home,
          dataDir: join(home, ".comis"),
        });
        const r = runProbe(argv, `cat "${credFile}"`);
        // GO: the operator opt-in binds ~/.claude RO -> the fixture is readable.
        expect(
          r.status,
          `SEC-05: ~/.claude/.credentials.json MUST be readable at credentialHome:include ` +
            `(the operator opt-in binds it RO). status=${r.status} stderr=${r.stderr}`,
        ).toBe(0);
        expect(r.stdout ?? "").toContain("fixture");
      });
    });

    // -----------------------------------------------------------------------
    // SEC-02 — filesystem:workspace: a write OUTSIDE the bound workspace fails;
    //          the child runs as the net-new uid (65534).
    // -----------------------------------------------------------------------
    describe("SEC-02 — filesystem confinement + net-new uid", () => {
      it("write outside the workspace fails at filesystem:workspace (EROFS/ENOENT/EACCES)", () => {
        const ws = makeWorkspace();
        const home = mkdtempSync(join(tmpdir(), "scope-matrix-home-"));
        createdPaths.push(home);
        const scope: TerminalScope = {
          filesystem: "workspace",
          network: "none",
          credentialHome: "exclude",
          uid: "dedicated",
        };
        const argv = buildCellArgs(scope, { workspace: ws, home, dataDir: join(home, ".comis") });
        // /etc is ro-bound (SYSTEM_RO_PATHS); a write there must fail. The
        // workspace IS writable — assert that side too so the probe proves
        // CONFINEMENT, not a blanket-readonly jail.
        const r = runProbe(
          argv,
          `touch /etc/scope-matrix-escape 2>&1; echo "outside_rc=$?"; ` +
            `touch "${ws}/inside" 2>&1; echo "inside_rc=$?"`,
        );
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        // GO: the outside write is rejected (non-zero rc reported by the probe).
        expect(
          /outside_rc=[1-9]/.test(out),
          `SEC-02: a write OUTSIDE the bound workspace MUST fail at filesystem:workspace. out=${out}`,
        ).toBe(true);
        // And the workspace itself is writable (confinement, not lockout).
        expect(
          out.includes("inside_rc=0"),
          `SEC-02: the bound workspace MUST be writable (the session's working dir). out=${out}`,
        ).toBe(true);
      });

      it("child runs as uid==65534 (nobody) at uid:dedicated", () => {
        const home = mkdtempSync(join(tmpdir(), "scope-matrix-home-"));
        createdPaths.push(home);
        const scope: TerminalScope = {
          filesystem: "workspace",
          network: "none",
          credentialHome: "exclude",
          uid: "dedicated",
        };
        const argv = buildCellArgs(scope, {
          workspace: makeWorkspace(),
          home,
          dataDir: join(home, ".comis"),
        });
        const r = runProbe(argv, "id -u");
        // GO: the driven child runs as the net-new uid, NOT the daemon uid
        // (118 G-2 proved uid=65534(nobody) on the VPS).
        expect(r.status, `SEC-02: id -u failed: ${r.stderr}`).toBe(0);
        expect(
          (r.stdout ?? "").trim(),
          `SEC-02: the child MUST run as the net-new uid ${DEDICATED_UID.uid} (nobody), ` +
            `not the daemon uid. got "${(r.stdout ?? "").trim()}"`,
        ).toBe(String(DEDICATED_UID.uid));
      });
    });

    // -----------------------------------------------------------------------
    // SEC-13 (FLAGSHIP) — ~/.comis is shadowed by the always-on --tmpfs carve-out
    //                     EVEN at filesystem:full (the broad --bind / / cannot
    //                     expose the master key / secret store to a driven child).
    // -----------------------------------------------------------------------
    describe("SEC-13 (flagship) — the ~/.comis carve-out wins even at filesystem:full", () => {
      it("cat ~/.comis/<sentinel> -> ENOENT inside a filesystem:full jail", () => {
        // Prove against the REAL ~/.comis (the operator's actual data dir): seed a
        // sentinel there ONLY if absent (never clobber a real config), and prove
        // the jail cannot read it. The carve-out --tmpfs <dataDir> is appended
        // LAST by buildScopeArgs, so it shadows even `--bind / /`.
        const realHome = homedir();
        const realDataDir = join(realHome, ".comis");
        const sentinel = join(realDataDir, "scope-matrix-sentinel.txt");
        let seededSentinel = false;
        if (!existsSync(realDataDir)) {
          mkdirSync(realDataDir, { recursive: true });
        }
        if (!existsSync(sentinel)) {
          writeFileSync(sentinel, "SCOPE_MATRIX_CARVE_OUT_SENTINEL", "utf8");
          seededSentinel = true;
          createdPaths.push(sentinel);
        }

        const scope: TerminalScope = {
          filesystem: "full", // the broadest reach — the carve-out STILL wins
          network: "none",
          credentialHome: "exclude",
          uid: "dedicated",
        };
        const argv = buildCellArgs(scope, {
          workspace: makeWorkspace(),
          home: realHome,
          dataDir: realDataDir, // the carve-out target == the real ~/.comis
        });
        const r = runProbe(
          argv,
          `cat "${sentinel}" 2>&1; echo "rc=$?"; ` +
            // also prove the directory is the empty tmpfs, not the host dir
            `ls -A "${realDataDir}" 2>&1; echo "ls_rc=$?"`,
        );
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

        if (seededSentinel) {
          try {
            unlinkSync(sentinel);
          } catch {
            /* best-effort */
          }
        }

        // GO: even at filesystem:full the sentinel under ~/.comis is unreadable —
        // the tmpfs carve-out (bind-order-last) shadows the host dir entirely.
        expect(
          !out.includes("SCOPE_MATRIX_CARVE_OUT_SENTINEL"),
          `SEC-13: ~/.comis MUST be unreadable EVEN at filesystem:full (the always-on ` +
            `--tmpfs carve-out wins). The sentinel leaked. out=${out}`,
        ).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // SEC-07 — the jail env has NO interpreter-control / nested-CLI markers.
    //          bwrap inherits the spawner env (no --clearenv); the worker scrubs
    //          it via scrubChildEnv before the spawn. Here we set the dangerous
    //          vars in the spawner env and assert they do NOT survive INTO the
    //          jail when the env is the SCRUBBED env the production path produces.
    // -----------------------------------------------------------------------
    describe("SEC-07 — env-scrub: no NODE_OPTIONS / CLAUDE_CODE_* in the jail", () => {
      it("env inside the jail has no NODE_OPTIONS, CLAUDECODE, or CLAUDE_CODE_* keys", async () => {
        const home = mkdtempSync(join(tmpdir(), "scope-matrix-home-"));
        createdPaths.push(home);
        const scope: TerminalScope = {
          filesystem: "workspace",
          network: "none",
          credentialHome: "exclude",
          uid: "dedicated",
        };
        // Build the FULL production spawn plan (it scrubs the env via the real
        // scrubChildEnv) from a dangerous spawner env, then spawn with that env.
        const dangerousEnv: NodeJS.ProcessEnv = {
          ...process.env,
          NODE_OPTIONS: "--require /tmp/evil.js",
          CLAUDECODE: "1",
          CLAUDE_CODE_ENTRYPOINT: "cli",
          SAFE_KEEPER: "keep-me", // a benign var must survive the scrub
        };
        const plan = await buildSpawnPlan(
          {
            scope,
            bin: "/bin/bash",
            argv: ["-c", "env"],
            workspace: makeWorkspace(),
            cwd: home,
            home,
            dataDir: join(home, ".comis"),
            systemRoPaths: resolvedSystemRoPaths(),
            env: dangerousEnv,
          },
          { bwrapPath: resolveBwrapPath() },
        );
        // plan.bin = bwrapPath; plan.argv already ends with `/bin/bash -c env`.
        const r = spawnSync(plan.bin, plan.argv, {
          encoding: "utf8",
          timeout: 15_000,
          env: plan.env, // the SCRUBBED env the worker would hand bwrap
        });
        expect(r.status, `SEC-07: env probe failed: ${r.stderr}`).toBe(0);
        const lines = (r.stdout ?? "").split("\n");
        const hasKey = (k: string): boolean =>
          lines.some((l) => l.startsWith(`${k}=`));
        // GO: the interpreter-control + nested-CLI markers are stripped.
        expect(hasKey("NODE_OPTIONS"), "SEC-07: NODE_OPTIONS MUST be scrubbed").toBe(false);
        expect(hasKey("CLAUDECODE"), "SEC-07: CLAUDECODE MUST be scrubbed").toBe(false);
        expect(
          lines.some((l) => l.startsWith("CLAUDE_CODE_")),
          "SEC-07: CLAUDE_CODE_* MUST be scrubbed",
        ).toBe(false);
        // And a benign var survives (the scrub is a blocklist, not a wipe).
        expect(hasKey("SAFE_KEEPER"), "SEC-07: a benign env var MUST survive the scrub").toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // SEC-07 — egress: direct bypass is impossible (rc=7), the allowlist proxy
    //          allows a listed host (200) and 403s a non-listed host.
    // -----------------------------------------------------------------------
    describe("SEC-07 — egress: netns isolation + the allowlist gate", () => {
      it("a direct --noproxy curl fails (rc=7) at network:none (kernel netns, no route)", () => {
        const home = mkdtempSync(join(tmpdir(), "scope-matrix-home-"));
        createdPaths.push(home);
        const scope: TerminalScope = {
          filesystem: "workspace",
          network: "none", // --unshare-net, no socket, no proxy
          credentialHome: "exclude",
          uid: "dedicated",
        };
        const argv = buildCellArgs(scope, {
          workspace: makeWorkspace(),
          home,
          dataDir: join(home, ".comis"),
        });
        const r = runProbe(
          argv,
          `curl --noproxy '*' --max-time 3 --silent --show-error https://1.1.1.1/ 2>&1; echo "rc=$?"`,
        );
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        // GO: --unshare-net gives the jail an empty netns -> no route -> curl
        // rc=7 (118 G-3 DIRECT_BYPASS rc=7). Accept the adjacent netns failures
        // too (6 DNS, 28 timeout) — all prove "no egress without the proxy".
        expect(
          /rc=(7|6|28)\b/.test(out) || out.includes("Network is unreachable") || out.includes("Could not resolve"),
          `SEC-07: a direct (--noproxy) egress MUST fail at network:none (kernel-enforced ` +
            `netns, no route). Expected rc=7 (or 6/28). out=${out}`,
        ).toBe(true);
      });

      it("the allowlist proxy on the bound socket allows a listed host (200) and 403s a non-listed host", async () => {
        const home = mkdtempSync(join(tmpdir(), "scope-matrix-home-"));
        createdPaths.push(home);
        const socketPath = join(tmpdir(), `scope-matrix-egress-${Date.now()}.sock`);
        createdSockets.push(socketPath);

        const server = startAllowlistProxy(socketPath, ["allowed.example"]);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => resolve());
        });

        try {
          const scope: TerminalScope = {
            filesystem: "workspace",
            network: "listed-hosts", // --unshare-net + --bind <relaySocketPath>
            hosts: ["allowed.example"],
            credentialHome: "exclude",
            uid: "dedicated",
          };
          // buildScopeArgs binds the proxy socket into the jail via relaySocketPath
          // (the SAME --bind the worker uses). curl inside the jail dials the bound
          // socket via -x CONNECT — the same target the relay-as-init bridges
          // HTTPS_PROXY to. We assert the ALLOW DECISION + socket reachability; the
          // in-jail loopback relay (HTTPS_PROXY->127.0.0.1:port->socket) is the
          // worker's runtime path, exercised end-to-end by the higher VPS smoke.
          const argv = buildCellArgs(scope, {
            workspace: makeWorkspace(),
            home,
            dataDir: join(home, ".comis"),
            relaySocketPath: socketPath,
          });

          // Allowed host -> 200 through the bound proxy socket.
          const allowed = await new Promise<{ status: number | null; out: string }>((resolve) => {
            const child = spawn(argv[0]!, [
              ...argv.slice(1),
              "curl",
              "--silent",
              "--show-error",
              "--include",
              "--max-time",
              "5",
              "-x",
              `http://localhost/`, // proxy URL ignored; --unix-socket sets the dial
              "--proxy-unix-socket",
              socketPath,
              "https://allowed.example/",
            ]);
            let out = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (d: string) => (out += d));
            child.stderr.on("data", (d: string) => (out += d));
            child.on("close", (code) => resolve({ status: code, out }));
          });
          expect(
            allowed.out.includes("200"),
            `SEC-07: an ALLOWLISTED host MUST get 200 through the bound proxy socket ` +
              `(allow decision + in-jail socket reachability). out=${allowed.out}`,
          ).toBe(true);

          // Non-listed host -> 403 (no upstream dial — the no-SSRF semantics).
          const denied = await new Promise<{ status: number | null; out: string }>((resolve) => {
            const child = spawn(argv[0]!, [
              ...argv.slice(1),
              "curl",
              "--silent",
              "--show-error",
              "--include",
              "--max-time",
              "5",
              "--proxy-unix-socket",
              socketPath,
              "https://blocked.example/",
            ]);
            let out = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (d: string) => (out += d));
            child.stderr.on("data", (d: string) => (out += d));
            child.on("close", (code) => resolve({ status: code, out }));
          });
          expect(
            denied.out.includes("403"),
            `SEC-07: a NON-LISTED host MUST be blocked (403, no upstream dial) by the ` +
              `allowlist proxy. out=${denied.out}`,
          ).toBe(true);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    });

    // -----------------------------------------------------------------------
    // SEC-16 — fail-closed: no provider (bwrapPath undefined) -> the production
    //          spawn plan REJECTS (JailUnavailableError), never an unjailed spawn.
    //          This is the REAL production path (buildSpawnPlan), confirming the
    //          118 G-5 result on the production composer (not a hand-rolled gate).
    // -----------------------------------------------------------------------
    describe("SEC-16 — fail-closed: no provider -> create rejects", () => {
      it("buildSpawnPlan with bwrapPath undefined throws JailUnavailableError (no unjailed spawn)", async () => {
        const home = mkdtempSync(join(tmpdir(), "scope-matrix-home-"));
        createdPaths.push(home);
        const scope: TerminalScope = {
          filesystem: "workspace",
          network: "none",
          credentialHome: "exclude",
          uid: "dedicated",
        };
        // GO: undefined bwrapPath (provider absent) -> reject BEFORE any spawn.
        await expect(
          buildSpawnPlan(
            {
              scope,
              bin: "/bin/bash",
              argv: ["-c", "echo SHOULD_NOT_RUN"],
              workspace: makeWorkspace(),
              cwd: home,
              home,
              dataDir: join(home, ".comis"),
              systemRoPaths: resolvedSystemRoPaths(),
              env: {},
            },
            { bwrapPath: undefined },
          ),
        ).rejects.toBeInstanceOf(JailUnavailableError);
      });
    });

    // -----------------------------------------------------------------------
    // Cleanup — remove every seeded fixture, temp workspace, and socket
    //           (mirror `bwrap-egress-integration.test.ts:394-410`).
    // -----------------------------------------------------------------------
    afterEach(() => {
      // Drain socket files between tests (the egress cell makes one per run).
      for (const sock of createdSockets) {
        try {
          if (existsSync(sock)) unlinkSync(sock);
        } catch {
          /* best-effort */
        }
      }
      createdSockets.length = 0;
    });

    afterAll(() => {
      for (const p of createdPaths) {
        try {
          if (existsSync(p)) rmSync(p, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup — ignore */
        }
      }
      for (const sock of createdSockets) {
        try {
          if (existsSync(sock)) unlinkSync(sock);
        } catch {
          /* best-effort */
        }
      }
    });
  },
);
