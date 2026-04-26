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
import { BwrapProvider } from "./bwrap-provider.js";
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
 * Smoke-test the bwrap binary against the isolation flags BwrapProvider
 * actually uses (--unshare-pid + --proc /proc). On Docker Desktop's linuxkit
 * kernel and similar restricted environments this combo EPERMs at the
 * procfs mount step, even with apparmor/seccomp unconfined — every later
 * exec call would silently fail. `available()` only checks if `bwrap` is on
 * PATH, so without this probe the daemon would log "provider: bwrap" even
 * when bwrap is non-functional. ~50ms one-shot at startup.
 */
function bwrapSmokeTest(): boolean {
  const r = spawnSync(
    "bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--proc", "/proc",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--tmpfs", "/tmp",
      "/bin/true",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  return r.status === 0;
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
      if (!bwrapSmokeTest()) {
        // bwrap is on PATH but the kernel rejects the isolation flags
        // (typically Docker Desktop's linuxkit on macOS/Windows). The daemon
        // returns the provider regardless so exec calls fail loudly via
        // bwrap's stderr rather than silently running unsandboxed.
        logger?.warn(
          {
            hint: "Kernel rejected --unshare-pid + --proc /proc (typically Docker Desktop linuxkit on macOS/Windows). Agent `exec` calls will fail at runtime — see docs/operations/docker.mdx → Platform Support. For production, deploy to a real Linux host.",
            errorKind: "config",
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
          errorKind: "config",
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
      { hint: "sandbox-exec not found -- unexpected on macOS", errorKind: "config" },
      "sandbox-exec not found -- exec tool will run without OS sandbox",
    );
    return undefined;
  }

  logger?.warn(
    {
      hint: `Platform "${process.platform}" has no supported sandbox runtime`,
      errorKind: "config",
    },
    "Unsupported platform -- exec tool will run without OS sandbox",
  );
  return undefined;
}
