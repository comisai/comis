// SPDX-License-Identifier: Apache-2.0
/**
 * egress-relay-init -- the in-jail relay-as-init for `network: listed-hosts`
 * (SEC-07, §3.5). It is NOT imported by any package — it is spawned as a
 * SUBPROCESS *inside* the bwrap jail, AFTER bwrap's `--` separator, as the jail's
 * userns-root PID-1 init (the `relayArgv` that {@link buildEgressRelayLaunch}
 * points {@link RELAY_INIT_SCRIPT_URL} at). It composes the two net-new dimensions
 * (egress relay + uid drop) into ONE launcher, in the exact order the 118 G-3 GO
 * proved on the VPS (`118-SPIKE-GO.md` §3, the `g3-relay.mjs` transport):
 *
 *   1. Bring loopback (`lo`) UP. The jail owns its netns (`--unshare-net`) and the
 *      init runs as userns-root, so it holds CAP_NET_ADMIN over that netns — `ip
 *      link set lo up` succeeds. WITHOUT this the loopback proxy is unreachable.
 *   2. Start a TCP listener on `127.0.0.1:<port>` that forwards every connection to
 *      the bind-mounted host unix socket (`socketPath` — the host allowlist CONNECT
 *      proxy). This is the TCP->unix bridge the child reaches via `HTTPS_PROXY`.
 *   3. DROP to the net-new uid/gid (`--setgid`/`--setuid`) BEFORE exec — the driven
 *      child must NEVER run with CAP_NET_ADMIN held (privilege-drop-before-exec).
 *      gid is dropped first (a uid drop first would forbid the later setgid).
 *   4. `exec` the driven child (everything after the init's own `--`). The child
 *      inherits the listening relay + `HTTPS_PROXY=http://127.0.0.1:<port>` (set by
 *      the worker via {@link buildEgressRelayLaunch}'s `proxyEnv`), so curl / node /
 *      claude egress is bridged host-allowlist-proxy -> socket -> relay -> child.
 *
 * Because the listed-hosts uid drop is the init's job (step 3), the bwrap jail for
 * listed-hosts is composed WITHOUT bwrap's own `--uid`/`--gid` (the init runs as
 * userns-root so it can bring `lo` up, then drops itself) — see `buildSpawnPlan`.
 *
 * RUNTIME-ONLY MODULE: it has a top-level side effect (`void main()`), imports only
 * node builtins (`node:net`, `node:child_process`), and is excluded from the worker
 * import graph (worker ↛ this; it is exec'd, never required). It carries NO secret
 * and injects NOTHING into the stream (the host proxy enforces the allowlist).
 *
 * Live enforcement is VPS-only (the loopback-up + TCP->unix bridge + uid drop need
 * a real `--unshare-net` userns): the 122-07 `terminal-scope-matrix.linux.test.ts`
 * egress cell drives a real request through this init (allowlisted -> 200,
 * non-listed -> 403, direct `--noproxy` -> rc=7), mirroring 118 G-3.
 *
 * @module
 */

import net from "node:net";
import { spawnSync, execFileSync } from "node:child_process";

/** Parsed relay-init arguments. */
interface RelayInitArgs {
  socketPath: string;
  port: number;
  setuid?: number;
  setgid?: number;
  /** The driven child argv (everything after the init's own `--`). */
  child: string[];
}

/**
 * Parse `--socket <path> --port <n> [--setuid <u>] [--setgid <g>] -- <bin> <argv…>`.
 * The first bare `--` terminates the init flags; everything after is the child.
 */
function parseArgs(argv: readonly string[]): RelayInitArgs {
  let socketPath = "";
  let port = 0;
  let setuid: number | undefined;
  let setgid: number | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--socket") {
      socketPath = argv[++i] ?? "";
    } else if (a === "--port") {
      port = Number.parseInt(argv[++i] ?? "0", 10);
    } else if (a === "--setuid") {
      setuid = Number.parseInt(argv[++i] ?? "", 10);
    } else if (a === "--setgid") {
      setgid = Number.parseInt(argv[++i] ?? "", 10);
    }
  }
  return { socketPath, port, setuid, setgid, child: argv.slice(i) };
}

/**
 * Bring loopback up inside the OWNED netns (userns-root holds CAP_NET_ADMIN here).
 * Best-effort: if `ip` is unavailable, the loopback may already be up on some
 * kernels — we log to stderr but still try to serve the relay (the egress cell
 * asserts the end-to-end outcome, not this step in isolation).
 */
function bringLoopbackUp(): void {
  try {
    execFileSync("ip", ["link", "set", "lo", "up"], { stdio: "ignore" });
  } catch {
    // Some images lack iproute2 or `lo` is already up — proceed; the relay listen
    // on 127.0.0.1 is the real signal. A genuine no-loopback host fails the egress
    // cell loudly (which is the correct, observable failure).
    process.stderr.write("egress-relay-init: `ip link set lo up` unavailable; continuing\n");
  }
}

/**
 * Start the TCP->unix bridge on `127.0.0.1:<port>`. Each accepted TCP connection is
 * piped to a fresh connection to the bind-mounted host unix `socketPath` (the host
 * allowlist CONNECT proxy). Resolves once the listener is bound so the child is
 * exec'd only after the relay can accept (no first-CONNECT race).
 */
function startRelay(socketPath: string, port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((tcp) => {
      const upstream = net.connect(socketPath, () => {
        upstream.pipe(tcp);
        tcp.pipe(upstream);
      });
      upstream.on("error", () => {
        tcp.destroy();
      });
      tcp.on("error", () => {
        upstream.destroy();
      });
    });
    server.once("error", reject);
    // Bind to loopback only — the bridge is reachable solely from inside the jail.
    server.listen(port, "127.0.0.1", () => {
      server.unref(); // never hold the loop open on the init's own account
      resolve(server);
    });
  });
}

/**
 * Drop privileges to the net-new gid then uid (gid FIRST — once uid is non-root the
 * setgid is refused). Only meaningful when the init runs as userns-root; a no-op
 * when the ids are absent. After this the relay keeps serving (it is already bound)
 * but the process — and the exec'd child — no longer hold CAP_NET_ADMIN.
 */
function dropPrivileges(setuid?: number, setgid?: number): void {
  if (setgid !== undefined && typeof process.setgid === "function") {
    process.setgid(setgid);
  }
  if (setuid !== undefined && typeof process.setuid === "function") {
    process.setuid(setuid);
  }
}

/**
 * Exec the driven child in-place. We use a synchronous spawn that inherits stdio
 * and replaces the init's role for the session's lifetime (the relay server stays
 * bound in THIS process, so we run the child as a foreground child and exit with
 * its code — the relay is torn down when the jail dies with the parent worker via
 * `--die-with-parent`). `process.exit` carries the child's status out of the jail.
 */
function execChild(child: string[]): never {
  if (child.length === 0) {
    process.stderr.write("egress-relay-init: no child command after `--`\n");
    process.exit(2);
  }
  const [bin, ...rest] = child;
  const r = spawnSync(bin, rest, { stdio: "inherit" });
  if (typeof r.status === "number") {
    process.exit(r.status);
  }
  // Killed by signal (or failed to spawn) — surface a non-zero status.
  process.exit(r.error !== undefined ? 127 : 1);
}

async function main(): Promise<void> {
  // argv: [node, thisScript, ...relayInitArgs]
  const args = parseArgs(process.argv.slice(2));
  bringLoopbackUp();
  await startRelay(args.socketPath, args.port);
  // Privilege drop happens AFTER the privileged netns setup (lo up) + the relay
  // bind, but BEFORE exec — the child never holds the cap (118 §3 composition).
  dropPrivileges(args.setuid, args.setgid);
  execChild(args.child);
}

void main();
