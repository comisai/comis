// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the OFF-BY-DEFAULT Google Chat inbound-verify wiring seam.
 *
 * `resolveTestGoogleChatVerifier` builds the `validateInboundJwt` closure the
 * gateway ingress consumes. It is gated on `COMIS_GOOGLECHAT_TEST_JWKS`, which is
 * UNSET in production — with the env unset the daemon behaves byte-identically to
 * today (the live remote-JWKS verifier). When the env names a JWKS file the seam
 * swaps in a LOCAL-JWKS verifier that STILL fully verifies (signature + issuer +
 * audience, plus the app-url sender-binding email claim) — it only changes the
 * key source, never relaxes a control, so it is never an auth bypass. Env is read
 * through the injected getter (never `process.env`); the file is read through an
 * injected `readFileImpl`.
 *
 * @module
 */

import { describe, expect, it, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { resolveTestGoogleChatVerifier } from "./googlechat-test-seams.js";

/** A ComisLogger whose warn spy records every argument for content-free asserts. */
function makeLoggerSpy(): {
  logger: ComisLogger;
  warn: ReturnType<typeof vi.fn>;
  serialized: () => string;
} {
  const warn = vi.fn();
  const noop = vi.fn();
  const logger = {
    level: "debug",
    trace: noop,
    debug: noop,
    info: noop,
    warn,
    error: noop,
    fatal: noop,
    audit: noop,
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
  const serialized = (): string => JSON.stringify(warn.mock.calls);
  return { logger, warn, serialized };
}

describe("resolveTestGoogleChatVerifier — default (production remote-JWKS) path", () => {
  it("env unset ⇒ returns the production verifier; reads no file, logs no WARN (project-number)", async () => {
    const readFileImpl = vi.fn((_p: string): string => {
      throw new Error("readFileImpl must not be called on the default path");
    });
    const { logger, warn } = makeLoggerSpy();
    const getEnv = (_k: string): string | undefined => undefined;

    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "project-number", audience: "1234567890" },
      getEnv,
      { readFileImpl, logger },
    );

    expect(typeof verify).toBe("function");
    // The default path forwards to the live remote-JWKS verifier — no seam work.
    expect(readFileImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // The production verifier's cheap pre-gate rejects a missing bearer with no
    // network — proof the default (not the local-JWKS) path is wired.
    expect((await verify(undefined)).ok).toBe(false);
  });

  it("env unset ⇒ works for the app-url audience type too (no file read, no WARN)", async () => {
    const readFileImpl = vi.fn((_p: string): string => {
      throw new Error("readFileImpl must not be called on the default path");
    });
    const { logger, warn } = makeLoggerSpy();
    const getEnv = (_k: string): string | undefined => undefined;

    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "app-url", audience: "https://example.com/app/" },
      getEnv,
      { readFileImpl, logger },
    );

    expect(readFileImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect((await verify(undefined)).ok).toBe(false);
  });

  it("env unset ⇒ resolves with no deps bag at all (logger + readFileImpl optional)", async () => {
    const getEnv = (_k: string): string | undefined => undefined;
    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "project-number", audience: "1234567890" },
      getEnv,
    );
    expect((await verify(undefined)).ok).toBe(false);
  });
});
