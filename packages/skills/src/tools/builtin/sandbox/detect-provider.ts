// SPDX-License-Identifier: Apache-2.0
/**
 * detectSandboxProvider -- Platform sandbox provider detection factory.
 *
 * Called once at daemon startup to detect and return the best available
 * OS-level sandbox provider. Returns undefined if no supported sandbox
 * runtime is available.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { SandboxProvider } from "./types.js";
import { BwrapProvider, SYSTEM_RO_PATHS } from "./bwrap-provider.js";
import { SandboxExecProvider } from "./sandbox-exec-provider.js";

/** Minimal logger interface for sandbox detection. */
export interface DetectLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * True when the daemon is running inside a Linux container. Docker writes
 * `/.dockerenv` on container creation; Podman writes `/run/.containerenv`.
 * One sync stat per daemon boot — runs once at sandbox detection.
 */
function isContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

/**
 * Smoke-test bwrap against the same SYSTEM_RO_PATHS BwrapProvider.buildArgs()
 * uses, plus --unshare-pid + --proc /proc — the kernel-feature combo we
 * actually need to detect. Reusing the production bind list prevents drift
 * (e.g. /lib64 must be present on usrmerge x86-64 hosts where /bin/true's
 * dynamic linker lives there; without it the smoke spawn EPERMs at execvp
 * even though the production sandbox itself runs fine).
 *
 * On Docker Desktop's linuxkit kernel and similar restricted environments
 * --unshare-pid + --proc /proc EPERMs at the procfs mount step, even with
 * apparmor/seccomp unconfined — every later exec call would silently fail.
 * `available()` only checks if `bwrap` is on PATH, so without this probe the
 * daemon would log "provider: bwrap" even when bwrap is non-functional.
 * ~50ms one-shot at startup.
 *
 * Returns the raw `stderr` and `signal` from bwrap so the caller can include
 * them in the warn payload — operators reading the log see the actual bwrap
 * error message (e.g. "Creating new namespace failed: Operation not
 * permitted") without having to enable DEBUG logging.
 */
/**
 * Spawn `bwrap … /bin/true` against the production SYSTEM_RO_PATHS bind list with
 * the given isolation flags + `extraArgs`, returning whether the namespace
 * construction succeeded plus the raw bwrap stderr/signal. The single, DRY probe
 * body shared by {@link bwrapSmokeTest} (the boot-time provider detection) and
 * {@link namespacePreflight} (the JAIL-03 autonomy preflight) — they differ only
 * in the isolation flags passed, so the bind list + spawn options never drift.
 *
 * The base flags `--unshare-user --unshare-pid --proc /proc` are the kernel-
 * feature combo every jail needs; callers ADD to them (the preflight adds
 * `--unshare-net`). LINUX-ONLY: callers must gate on `process.platform` (bwrap
 * does not exist on macOS); this helper assumes a Linux host.
 */
function bwrapNamespaceProbe(
  extraArgs: readonly string[],
): { ok: boolean; stderr: string; signal: NodeJS.Signals | null } {
  const sysBinds = SYSTEM_RO_PATHS
    .filter((p) => existsSync(p))
    .flatMap((p) => ["--ro-bind", p, p]);
  const r = spawnSync(
    "bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      ...extraArgs,
      "--proc", "/proc",
      ...sysBinds,
      "--tmpfs", "/tmp",
      "/bin/true",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  return {
    ok: r.status === 0,
    stderr: (r.stderr ?? "").trim(),
    signal: r.signal ?? null,
  };
}

function bwrapSmokeTest(): { ok: boolean; stderr: string; signal: NodeJS.Signals | null } {
  // No extra isolation flags — the original smoke-test combo, byte-identical.
  return bwrapNamespaceProbe([]);
}

/**
 * Result of the JAIL-03 namespace preflight. The `namespacePreflightOk` field is
 * structurally assignable to `@comis/core`'s `AutonomyPreflightResult` — feed
 * this straight into the SHIPPED `degradeAutonomy` (PROFILE-03, Phase 210) with
 * no adapter. The extra `stderr`/`signal` carry the bwrap error onto the boot
 * signal so an operator sees WHY the jail could not be built without enabling
 * DEBUG (matching the {@link detectSandboxProvider} warn-with-stderr pattern).
 */
export interface NamespacePreflightResult {
  /** Whether the unprivileged user namespace + `--unshare-net` jail could be built. */
  readonly namespacePreflightOk: boolean;
  /** The raw bwrap stderr (or the non-Linux explanation) — non-empty on failure. */
  readonly stderr: string;
  /** The signal bwrap died on, if any. */
  readonly signal: NodeJS.Signals | null;
}

/**
 * JAIL-03 namespace preflight — PRODUCE the `namespacePreflightOk` boolean the
 * SHIPPED `degradeAutonomy` (PROFILE-03) consumes. Extends the boot smoke test
 * with `--unshare-net` (the net-new isolation the `orchestrate` jail requires)
 * + the unprivileged-user-namespace availability check.
 *
 * On a non-Linux host the jail cannot be built at all, so this is HONEST: it
 * returns `namespacePreflightOk: false` with an explanatory `stderr` (never a
 * silent `true`). The daemon boot path then calls `degradeAutonomy`, which
 * downshifts any autonomy-bearing posture to `assistant` and SURFACES a WARN +
 * `doctor` finding — never a silent unjailed fallback.
 *
 * 211 ONLY PRODUCES the boolean — it NEVER re-implements the downshift (that is
 * PROFILE-03 in `@comis/core`). The daemon-side wiring that calls this at boot
 * then feeds `degradeAutonomy` per agent (the `emit-autonomy-boot-log` hook
 * already accepts a `namespacePreflightOk` input) lands in 211-06.
 *
 * @returns the preflight result (`namespacePreflightOk` + the bwrap stderr/signal).
 */
export function namespacePreflight(): NamespacePreflightResult {
  if (process.platform !== "linux") {
    return {
      namespacePreflightOk: false,
      stderr: "namespace preflight requires Linux (unprivileged user namespaces)",
      signal: null,
    };
  }
  // Linux: the net-new `--unshare-net` on top of the smoke-test combo — the
  // orchestrate jail isolates the network namespace, so the preflight must
  // prove the host can create one.
  const r = bwrapNamespaceProbe(["--unshare-net"]);
  return {
    namespacePreflightOk: r.ok,
    stderr: r.stderr,
    signal: r.signal,
  };
}

/**
 * Detect and return the best available sandbox provider for this platform.
 * Returns undefined if no sandbox runtime is available -- caller decides
 * whether to proceed unsandboxed or abort.
 */
export function detectSandboxProvider(logger?: DetectLogger): SandboxProvider | undefined {
  if (process.platform === "linux") {
    const bwrap = new BwrapProvider();
    if (bwrap.available()) {
      const smoke = bwrapSmokeTest();
      if (!smoke.ok) {
        // bwrap is on PATH but the kernel rejects the isolation flags
        // (typically Docker Desktop's linuxkit on macOS/Windows). Behaviour
        // diverges by environment:
        //
        //  - Inside a container: the project already declares macOS/Windows
        //    Docker Desktop as dev/testing only (CLAUDE.md, README, docs).
        //    Returning bwrap would just make every exec call fail and
        //    leave the agent useless for local testing. We disable the
        //    sandbox so exec runs unsandboxed inside the container,
        //    accepting the documented trust-boundary trade-off, and warn
        //    loudly. /data and /etc/comis are reachable from agent exec
        //    in this mode — never use it in production.
        //
        //  - Bare metal: a non-functional bwrap is a real misconfiguration
        //    (rare on stock Linux). Surface it loudly and return the
        //    provider so exec fails via bwrap's stderr until the operator
        //    fixes the kernel/userns config — never silently degrade
        //    sandboxing on a bare-metal host. The warn payload now includes
        //    `stderr` (the actual bwrap error) and `signal` so operators
        //    don't have to enable DEBUG logging to diagnose; the hint
        //    points at stderr first and demotes kernel sysctls to a
        //    secondary fallback.
        if (isContainer()) {
          logger?.warn(
            {
              hint: "Kernel rejected --unshare-pid + --proc /proc (typically Docker Desktop linuxkit on macOS/Windows). Sandbox auto-disabled so agent exec is functional for development. PRODUCTION DEPLOYMENTS MUST USE A REAL LINUX HOST — see docs/operations/docker.mdx → Platform Support.",
              errorKind: "config" as const,
              stderr: smoke.stderr,
              signal: smoke.signal,
            },
            "Exec sandbox DISABLED (kernel limitation; container host) -- shell commands will run UNSANDBOXED. Dev/testing only.",
          );
          return undefined;
        }
        logger?.warn(
          {
            hint: "Check the `stderr` field above for the actual bwrap error — that's the primary signal. If stderr mentions namespaces or 'Operation not permitted' on a bare-metal host, then as a secondary diagnostic verify `sysctl kernel.unprivileged_userns_clone=1` and AppArmor's `apparmor_restrict_unprivileged_userns=0` (Ubuntu 23.10+). Exec calls will fail until bwrap can run.",
            errorKind: "config" as const,
            stderr: smoke.stderr,
            signal: smoke.signal,
          },
          "bwrap installed but smoke test failed -- exec sandbox is non-functional on this kernel",
        );
      }
      return bwrap;
    }
    if (isContainer()) {
      // Container deployments treat the container itself as the trust boundary;
      // bwrap is intentionally absent. See docs/operations/docker.mdx → Trust boundary.
      logger?.info(
        {
          hint: "Container runtime detected; intra-container exec sandboxing is opt-in. To enable, install bubblewrap and run with security_opt: apparmor=unconfined / seccomp=unconfined.",
        },
        "Exec OS sandbox not present (container runtime) -- relying on container isolation",
      );
    } else {
      logger?.warn(
        {
          hint: "Install bubblewrap for OS-level exec sandboxing: apt install bubblewrap",
          errorKind: "config" as const,
        },
        "bwrap not found -- exec tool will run without OS sandbox",
      );
    }
    return undefined;
  }

  if (process.platform === "darwin") {
    const sbexec = new SandboxExecProvider();
    if (sbexec.available()) return sbexec;
    logger?.warn(
      { hint: "sandbox-exec not found -- unexpected on macOS", errorKind: "config" as const },
      "sandbox-exec not found -- exec tool will run without OS sandbox",
    );
    return undefined;
  }

  logger?.warn(
    {
      hint: `Platform "${process.platform}" has no supported sandbox runtime`,
      errorKind: "config" as const,
    },
    "Unsupported platform -- exec tool will run without OS sandbox",
  );
  return undefined;
}
