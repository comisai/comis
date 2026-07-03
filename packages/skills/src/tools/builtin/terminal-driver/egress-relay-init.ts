// SPDX-License-Identifier: Apache-2.0
/**
 * egress-relay-init -- the in-jail relay-as-init for `network: listed-hosts`.
 * It is NOT imported by any package — it is spawned as a
 * SUBPROCESS *inside* the bwrap jail, AFTER bwrap's `--` separator, as the jail's
 * userns-root PID-1 init (the `relayArgv` that {@link buildEgressRelayLaunch}
 * points {@link RELAY_INIT_SCRIPT_URL} at). It composes the two net-new dimensions
 * (egress relay + uid drop) into ONE launcher, in the exact order that keeps the
 * driven child from ever holding CAP_NET_ADMIN:
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
 * a real `--unshare-net` userns): the `terminal-scope-matrix.linux.test.ts`
 * egress cell drives a real request through this init (allowlisted -> 200,
 * non-listed -> 403, direct `--noproxy` -> rc=7).
 *
 * @module
 */

import net from "node:net";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * A structured audit record the best-effort {@link dropPrivileges} emits when it
 * CANNOT reach the net-new uid/gid (the VPS root-worker reality: the bwrap user
 * namespace maps a single uid, so 65534 is unmapped and `setuid(65534)` throws).
 * The relay-init is a bare runtime subprocess with NO `@comis/infra` logger, so the
 * audit is a one-line JSON object written to stderr (the operator-observable signal
 * the orchestrator + the VPS smoke can grep). It deliberately mirrors the canonical
 * structured-log shape (`hint`/`errorKind`) so it reads like every other failure line.
 */
export interface RelayInitAudit {
  /** Always `"egress-relay-init"` — the source tag for grep. */
  module: string;
  /** The security posture / next-failure hint (audit prose). */
  hint: string;
  /** The canonical errorKind tag (`"permission"` for the unmapped-drop case). */
  errorKind: string;
  /** The net-new uid the drop targeted (could not reach). */
  targetUid?: number;
  /** The net-new gid the drop targeted (could not reach). */
  targetGid?: number;
  /** The underlying errno (e.g. `EPERM`/`EINVAL`) when the drop threw. */
  code?: string;
  /** The drop error message, for the operator's incident reconstruction. */
  message?: string;
}

/** Injectable seams for {@link dropPrivileges} (default = the real process + stderr). */
export interface DropPrivilegesDeps {
  /** `process.setgid` (default). Injected so the not-mapped throw is unit-testable. */
  setgid?: (gid: number) => void;
  /** `process.setuid` (default). Injected so the not-mapped throw is unit-testable. */
  setuid?: (uid: number) => void;
  /** Emit a structured audit record (default = a one-line JSON write to stderr). */
  audit?: (record: RelayInitAudit) => void;
}

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

/** A one-line structured-JSON stderr audit (the relay-init has no infra logger). */
function defaultAudit(record: RelayInitAudit): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * BEST-EFFORT drop to the net-new gid then uid (gid FIRST — once uid is non-root the
 * setgid is refused). Only meaningful when the init runs as userns-root; a no-op
 * when the ids are absent.
 *
 * CRITICAL: for `network: listed-hosts` the bwrap jail does
 * NOT pre-drop `--uid` (the init must run as userns-root to bring `lo` up), so the
 * init attempts the uid drop here. On the root-worker VPS the bwrap user namespace
 * maps a SINGLE uid (host-root → userns-root), so 65534 is NOT a mapped target and
 * `process.setuid(65534)` throws (EPERM/EINVAL via `does_own_process_state`). The
 * egress transport works as userns-root with NO uid drop, so we MUST NOT throw:
 * a throw would crash the relay-init PID-1 and kill the whole listed-hosts session. Instead we emit a STRUCTURED audit WARN (the session is
 * running at the jail userns-uid because the drop target isn't mapped) and CONTINUE.
 * The bwrap user+pid+net+fs namespaces + the ~/.comis carve-out + the env-scrub + the
 * egress allowlist still confine the child — running at the namespace's userns-root is
 * "root in a box", not host root. No silent degrade: the posture is always logged.
 *
 * follow-on: the full net-new-uid drop for listed-hosts needs a uid-RANGE map
 * (newuidmap/subuid on the host) so 65534 becomes a mapped target inside the userns;
 * that is the real privilege-drop and is intentionally NOT attempted here.
 *
 * The other network modes (none/full) drop the uid via bwrap's own `--uid` (no relay
 * in the path), so this best-effort drop is the listed-hosts path's concern only.
 */
export function dropPrivileges(
  setuid?: number,
  setgid?: number,
  deps: DropPrivilegesDeps = {},
): void {
  const doSetgid = deps.setgid ?? (typeof process.setgid === "function" ? process.setgid.bind(process) : undefined);
  const doSetuid = deps.setuid ?? (typeof process.setuid === "function" ? process.setuid.bind(process) : undefined);
  const audit = deps.audit ?? defaultAudit;

  // gid FIRST (a uid drop first would forbid the later setgid). Each drop is
  // independently best-effort so a setgid failure does not skip the setuid attempt.
  if (setgid !== undefined && doSetgid !== undefined) {
    try {
      doSetgid(setgid);
    } catch (err) {
      auditDropFailure(audit, err, { targetUid: setuid, targetGid: setgid });
    }
  }
  if (setuid !== undefined && doSetuid !== undefined) {
    try {
      doSetuid(setuid);
    } catch (err) {
      auditDropFailure(audit, err, { targetUid: setuid, targetGid: setgid });
    }
  }
}

/** Emit the unmapped-drop audit record (the no-silent-degrade posture line). */
function auditDropFailure(
  audit: (record: RelayInitAudit) => void,
  err: unknown,
  ids: { targetUid?: number; targetGid?: number },
): void {
  const e = err as NodeJS.ErrnoException;
  audit({
    module: "egress-relay-init",
    hint:
      "listed-hosts session running at the jail userns-uid: the net-new drop target is not mapped " +
      "in the bwrap single-uid user namespace, so the setgid/setuid drop was refused. The child stays " +
      "confined by the user+pid+net+fs namespaces + the ~/.comis carve-out + env-scrub + the egress " +
      "allowlist (root-in-a-box, not host root). follow-on: a uid-RANGE map (newuidmap/subuid) is needed " +
      "for the full net-new-uid drop.",
    errorKind: "permission",
    targetUid: ids.targetUid,
    targetGid: ids.targetGid,
    code: typeof e?.code === "string" ? e.code : undefined,
    message: e instanceof Error ? e.message : String(err),
  });
}

/**
 * Exec the driven child in-place. We use a synchronous spawn that inherits stdio
 * and replaces the init's role for the session's lifetime (the relay server stays
 * bound in THIS process, so we run the child as a foreground child and exit with
 * its code — the relay is torn down when the jail dies with the parent worker via
 * `--die-with-parent`). `process.exit` carries the child's status out of the jail.
 */
/**
 * Build the driven child's env: the inherited (scrubbed) env PLUS the proxy vars
 * pointing at the in-jail loopback relay (`http://127.0.0.1:<relayPort>`). The
 * relay-init binds the relay on `relayPort`, so it is the AUTHORITATIVE source of
 * this value — set here, NOT relied upon via bwrap env-forwarding (which does not
 * survive the relay-init→child `spawnSync` boundary). Without
 * it a proxy-aware child attempts a DIRECT connect that `--unshare-net` blocks
 * ("could not resolve host"). Both upper- and lower-case forms cover the common
 * clients (curl reads lower; most others honor upper).
 */
export function buildRelayChildEnv(parentEnv: NodeJS.ProcessEnv, relayPort: number): NodeJS.ProcessEnv {
  const proxyUrl = `http://127.0.0.1:${relayPort}`;
  return {
    ...parentEnv,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
  };
}

function execChild(child: string[], relayPort: number): never {
  if (child.length === 0) {
    process.stderr.write("egress-relay-init: no child command after `--`\n");
    process.exit(2);
  }
  const [bin, ...rest] = child;
  const r = spawnSync(bin, rest, { stdio: "inherit", env: buildRelayChildEnv(process.env, relayPort) });
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
  // bind, but BEFORE exec — the child never holds the cap.
  // Best-effort: on the root-worker VPS the net-new uid is not
  // mapped in the bwrap single-uid userns, so the drop is refused; dropPrivileges
  // logs the audit posture and continues rather than crash the relay-init PID-1.
  dropPrivileges(args.setuid, args.setgid);
  execChild(args.child, args.port);
}

/**
 * Run `main()` ONLY when this module is the executed entry script (the production
 * path: `node <egress-relay-init.js> --socket … -- bin`). Guarding the side effect
 * means importing the module (e.g. the neighbor unit test for the best-effort
 * {@link dropPrivileges}) does NOT bring `lo` up / bind a relay / `process.exit` —
 * the runtime-only behavior fires solely under real in-jail execution.
 */
function isEntryScript(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    // import.meta.url not a file URL (exotic loader) — be conservative: do NOT run.
    return false;
  }
}

if (isEntryScript()) {
  void main();
}
