// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage Credential Validator: Verifies macOS platform and imsg binary
 * availability before adapter startup.
 *
 * Validation flow:
 * 1. Check process.platform === "darwin" (iMessage requires macOS)
 * 2. Probe for imsg binary using execFile + "which"
 * 3. Quick RPC ping via imsg rpc to verify responsiveness
 *
 * @module
 */

import { execFile } from "node:child_process";
import { ok, err, type Result } from "@comis/shared";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Bot identity information returned after successful validation. */
export interface ImsgBotInfo {
  /** Platform identifier (always "macos") */
  platform: "macos";
  /** imsg binary version string if available */
  binaryVersion?: string;
  /** Whether the imsg tool is available and responsive */
  available: boolean;
}

/** Options for iMessage connection validation. */
export interface ValidateIMessageOptions {
  /** Path to the imsg binary (defaults to "imsg"). */
  binaryPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a binary exists on PATH using `which`.
 */
function findBinary(binary: string): Promise<Result<string, Error>> {
  return new Promise((resolve) => {
    execFile("which", [binary], (error, stdout) => {
      if (error) {
        resolve(
          err(
            new Error(
              `imsg binary not found ("${binary}"). ` +
                "Install imsg from https://github.com/anthropics/imsg or ensure it is on your PATH.",
            ),
          ),
        );
        return;
      }
      const path = stdout.trim();
      if (!path) {
        resolve(err(new Error(`which returned empty path for "${binary}"`)));
        return;
      }
      resolve(ok(path));
    });
  });
}

/**
 * Run `imsg rpc --help` to verify the binary supports the rpc subcommand.
 */
function probeImsgRpc(binaryPath: string): Promise<Result<void, Error>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(err(new Error("imsg rpc probe timed out after 5 seconds")));
    }, 5_000);

    execFile(binaryPath, ["rpc", "--help"], (error, stdout, stderr) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.toLowerCase();
      if (combined.includes("unknown command") && combined.includes("rpc")) {
        resolve(
          err(
            new Error(
              'imsg CLI does not support the "rpc" subcommand. Update imsg to a newer version.',
            ),
          ),
        );
        return;
      }
      // Even non-zero exit is ok for --help (some CLIs exit 1 for help)
      if (error && !stdout && !stderr) {
        resolve(err(new Error(`imsg rpc probe failed: ${error.message}`)));
        return;
      }
      resolve(ok(undefined));
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate iMessage adapter prerequisites.
 *
 * Checks that we're running on macOS, that the imsg binary is available,
 * and that it supports the rpc subcommand needed for JSON-RPC communication.
 *
 * @param opts - Validation options
 * @returns ImsgBotInfo on success, descriptive Error on failure
 */
export const validateIMessageConnection: (opts?: ValidateIMessageOptions) => Promise<Result<ImsgBotInfo, Error>> =
  createCredentialValidator<ValidateIMessageOptions | undefined, ImsgBotInfo>({
    platform: "iMessage",
    validateInputs: () => {
      // Platform check is the "input validation" for iMessage
      if (process.platform !== "darwin") {
        return (
          `iMessage adapter requires macOS (process.platform="${process.platform}"). ` +
          "iMessage is only available on Apple platforms."
        );
      }
      return undefined;
    },
    callApi: async (opts) => {
      const binaryPath = opts?.binaryPath ?? "imsg";

      // Binary availability
      const binaryResult = await findBinary(binaryPath);
      if (!binaryResult.ok) {
        return err(binaryResult.error);
      }

      // RPC probe
      const probeResult = await probeImsgRpc(binaryPath);
      if (!probeResult.ok) {
        return err(probeResult.error);
      }

      return ok({
        platform: "macos",
        available: true,
      });
    },
  });
