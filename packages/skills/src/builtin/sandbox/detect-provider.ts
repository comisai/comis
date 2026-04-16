/**
 * detectSandboxProvider -- Platform sandbox provider detection factory.
 *
 * Called once at daemon startup to detect and return the best available
 * OS-level sandbox provider. Returns undefined if no supported sandbox
 * runtime is available.
 *
 * @module
 */

import type { SandboxProvider } from "./types.js";
import { BwrapProvider } from "./bwrap-provider.js";
import { SandboxExecProvider } from "./sandbox-exec-provider.js";

/** Minimal logger interface for sandbox detection. */
export interface DetectLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Detect and return the best available sandbox provider for this platform.
 * Returns undefined if no sandbox runtime is available -- caller decides
 * whether to proceed unsandboxed or abort.
 */
export function detectSandboxProvider(logger?: DetectLogger): SandboxProvider | undefined {
  if (process.platform === "linux") {
    const bwrap = new BwrapProvider();
    if (bwrap.available()) return bwrap;
    logger?.warn(
      {
        hint: "Install bubblewrap for OS-level exec sandboxing: apt install bubblewrap",
        errorKind: "config",
      },
      "bwrap not found -- exec tool will run without OS sandbox",
    );
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
