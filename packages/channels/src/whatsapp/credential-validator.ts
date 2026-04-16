/**
 * WhatsApp credential (auth state) validator.
 *
 * Validates that the Baileys multi-file auth state directory exists and
 * is writable. On first run, creates the directory and flags isFirstRun
 * so the adapter knows to expect QR code pairing.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { safePath } from "@comis/core";
import { constants } from "node:fs";
import { access, mkdir, writeFile, unlink, readdir } from "node:fs/promises";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for WhatsApp auth validation. */
interface WhatsAppValidateOpts {
  authDir: string;
  printQR?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate WhatsApp auth state directory for Baileys multi-file auth.
 *
 * @param opts.authDir - Path to the auth state directory
 * @param opts.printQR - Whether QR will be printed (used for first-run warning)
 * @returns ok with { authDir, isFirstRun } or err on validation failure
 */
export const validateWhatsAppAuth: (opts: WhatsAppValidateOpts) => Promise<Result<{ authDir: string; isFirstRun: boolean }, Error>> =
  createCredentialValidator<WhatsAppValidateOpts, { authDir: string; isFirstRun: boolean }>({
    platform: "WhatsApp",
    validateInputs: (opts) => {
      if (!opts.authDir || opts.authDir.trim() === "") {
        return "auth directory must not be empty";
      }
      return undefined;
    },
    callApi: async (opts) => {
      const { authDir, printQR } = opts;

      // Check if directory exists; create if not
      let dirCreated = false;
      try {
        await access(authDir, constants.F_OK);
      } catch {
        try {
          await mkdir(authDir, { recursive: true });
          dirCreated = true;
        } catch (mkdirErr) {
          const message = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
          return err(new Error(`Failed to create WhatsApp auth directory: ${message}`));
        }
      }

      // Check if directory is writable (create+delete a temp file)
      const probe = safePath(authDir, `.wa-probe-${Date.now()}`);
      try {
        await writeFile(probe, "");
        await unlink(probe);
      } catch {
        return err(new Error(`WhatsApp auth directory is not writable: ${authDir}`));
      }

      // Check if auth state files exist (creds.json is Baileys' primary file)
      let hasAuthState = false;
      if (!dirCreated) {
        try {
          const files = await readdir(authDir);
          hasAuthState = files.some(
            (f) => f === "creds.json" || f.startsWith("pre-key-") || f.startsWith("session-"),
          );
        } catch {
          // If we can't read the dir, treat as first run
          hasAuthState = false;
        }
      }

      const isFirstRun = !hasAuthState;

      // Warn if first run and QR printing is disabled
      if (isFirstRun && printQR === false) {
        // This is just informational -- the caller's logger will handle it
        // We return the result and let the adapter log the warning
      }

      return ok({ authDir, isFirstRun });
    },
  });
