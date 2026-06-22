/**
 * install-wizard-proxy.test.ts
 *
 * Unit tests for the CLI init env-only proxy installer. undici is mocked so the
 * test never mutates the real global dispatcher.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({
  setGlobalDispatcher: vi.fn(),
  EnvHttpProxyAgent: vi.fn(),
}));

import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { installWizardProxyFromEnv } from "./install-wizard-proxy.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installWizardProxyFromEnv", () => {
  it("returns false and installs nothing when no proxy env is set (default path)", () => {
    expect(installWizardProxyFromEnv({})).toBe(false);
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(EnvHttpProxyAgent).not.toHaveBeenCalled();
  });

  it("installs an EnvHttpProxyAgent and keeps loopback OUT of the proxy when HTTPS_PROXY is set", () => {
    const ok = installWizardProxyFromEnv({
      HTTPS_PROXY: "http://proxy.example:8080",
    });

    expect(ok).toBe(true);
    expect(setGlobalDispatcher).toHaveBeenCalledOnce();

    const agentOpts = (EnvHttpProxyAgent as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { httpsProxy?: string; noProxy?: string };
    expect(agentOpts.httpsProxy).toBe("http://proxy.example:8080");
    // The gateway loopback address must be bypassed so the post-setup daemon
    // health check on localhost:4766 is not misrouted through the proxy.
    expect(agentOpts.noProxy).toContain("127.0.0.1");
  });

  it("is best-effort — returns false instead of throwing when the install fails", () => {
    (setGlobalDispatcher as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new Error("undici boom");
      },
    );

    expect(installWizardProxyFromEnv({ HTTPS_PROXY: "http://proxy.example:8080" })).toBe(
      false,
    );
  });
});
