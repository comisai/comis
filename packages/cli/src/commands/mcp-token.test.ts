// SPDX-License-Identifier: Apache-2.0
/**
 * `ensureGatewayToken` — the pre-client bearer-token resolution and, critically,
 * what it tells an operator when it cannot resolve one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureGatewayToken } from "./mcp-token.js";

const KEY = "COMIS_GATEWAY_TOKEN";

describe("ensureGatewayToken", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("threads an explicit --token through to the environment", () => {
    ensureGatewayToken("literal-token-value-at-least-32-chars-x");
    expect(process.env[KEY]).toBe("literal-token-value-at-least-32-chars-x");
  });

  it("accepts an already-present environment value", () => {
    process.env[KEY] = "already-set-token-value";
    expect(() => ensureGatewayToken(undefined)).not.toThrow();
  });

  describe("the miss message", () => {
    // Live friction: on a healthy box running `security.storage: encrypted`,
    // `comis mcp list` failed with "Missing COMIS_GATEWAY_TOKEN — set in
    // ~/.comis/.env … Hint: run `comis init` to generate a gateway token" — while
    // the token was present in secrets.db and the daemon was serving with it.
    // Following that hint would have ROTATED the live token.
    function missMessage(): string {
      // Guarantee a miss regardless of the developer's own ~/.comis/.env by
      // asserting only on the thrown text when the env var is absent.
      try {
        ensureGatewayToken(undefined);
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }

    it("does NOT lead with `comis init` as the fix", () => {
      const msg = missMessage();
      if (msg === "") return; // developer box has a token in ~/.comis/.env
      const initIdx = msg.indexOf("comis init");
      const secretsIdx = msg.indexOf("comis secrets get");
      expect(secretsIdx, "the read-only recovery must be present").toBeGreaterThanOrEqual(0);
      expect(initIdx, "`comis init` must come AFTER the safe recovery").toBeGreaterThan(secretsIdx);
    });

    it("warns that `comis init` is destructive on a serving box", () => {
      const msg = missMessage();
      if (msg === "") return;
      expect(msg).toMatch(/NEW token|break a daemon/i);
    });

    it("names the encrypted store as the place the token actually lives", () => {
      const msg = missMessage();
      if (msg === "") return;
      expect(msg).toContain("secrets.db");
      expect(msg).toContain("security.storage: encrypted");
    });

    // Live friction, second round: the recovery command the hint printed was
    // `comis --token "$(comis secrets get COMIS_GATEWAY_TOKEN)" <command>`.
    // `--token` is registered per-SUBCOMMAND (`mcp list`, `mcp connect`, …), never
    // on the root program, so following the hint verbatim fails with
    // `error: unknown option '--token'` — the operator is handed a command that
    // cannot work, in the exact failure path this message exists to resolve.
    it("does not suggest --token as a ROOT-level option", () => {
      const msg = missMessage();
      if (msg === "") return;
      expect(
        msg,
        "`comis --token …` is not a valid invocation — --token is a subcommand option",
      ).not.toMatch(/comis\s+--token/);
    });

    it("keeps the resolved token out of argv, matching the --token flag's own warning", () => {
      const msg = missMessage();
      if (msg === "") return;
      // The --token option description itself says a token on the command line is
      // visible via ps/proc and shell history and prefers the env var. The hint
      // must not recommend the very thing the flag warns against.
      expect(msg).toMatch(/COMIS_GATEWAY_TOKEN="\$\(comis secrets get COMIS_GATEWAY_TOKEN\)"/);
    });
  });
});
