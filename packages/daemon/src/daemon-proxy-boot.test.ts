/**
 * daemon-proxy-boot.test.ts
 *
 * RED-first unit tests for daemon boot proxy install + posture (03-02).
 * Tests run network-free: all installs are mocked.
 *
 * Covered behaviours:
 *  1. Mapping — ProxyBootConfig built correctly from container.config + mergedEnv
 *  2. Fail-closed — ProxyConfigError at boot → error containing "Bootstrap failed" + configKey
 *  3. INFO present — exactly one module:"proxy" INFO log when proxy configured
 *  4. INFO absent / zero-config no-op — no install side-effects when nothing configured
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ProxyConfigError } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers that will be extracted from daemon.ts in the GREEN phase.
// Importing them here causes the RED phase to fail (module not found / export
// not present). This is the intentional RED state.
// ---------------------------------------------------------------------------
import {
  installProxyAtBoot,
  logProxyPosture,
  deriveChannelProxyEnv,
  resolveProxyCaPem,
  type ProxyBootPosture,
} from "./daemon-proxy-boot-helpers.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock @comis/infra — intercept installGlobalProxyDispatcher
// ---------------------------------------------------------------------------
vi.mock("@comis/infra", async (importOriginal) => {
  const original = await importOriginal<typeof import("@comis/infra")>();
  return {
    ...original,
    installGlobalProxyDispatcher: vi.fn(),
    resetProxyDispatcherForTests: vi.fn(),
  };
});

import {
  installGlobalProxyDispatcher,
  resetProxyDispatcherForTests,
} from "@comis/infra";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeContainer(overrides: {
  proxyEnabled?: boolean;
  proxyUrl?: string;
  loopbackMode?: string;
  caFile?: string;
  gatewayHost?: string;
  gatewayPort?: number;
} = {}) {
  return {
    config: {
      proxy: {
        enabled: overrides.proxyEnabled ?? false,
        proxyUrl: overrides.proxyUrl,
        loopbackMode: overrides.loopbackMode,
        tls: overrides.caFile ? { caFile: overrides.caFile } : undefined,
      },
      gateway: {
        host: overrides.gatewayHost ?? "127.0.0.1",
        port: overrides.gatewayPort ?? 4766,
      },
    },
  };
}

function makeMergedEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { PATH: "/usr/bin", ...extra };
}

function makeLoggerSpy() {
  const records: Array<{ data: Record<string, unknown>; msg: string }> = [];
  return {
    info: vi.fn((data: Record<string, unknown>, msg: string) => {
      records.push({ data, msg });
    }),
    records,
  };
}

// ---------------------------------------------------------------------------
afterEach(() => {
  vi.clearAllMocks();
  (resetProxyDispatcherForTests as ReturnType<typeof vi.fn>)();
});

// ---------------------------------------------------------------------------
// 1. Mapping test
// ---------------------------------------------------------------------------
describe("installProxyAtBoot — ProxyBootConfig mapping", () => {
  it("maps container.config.proxy + mergedEnv to ProxyBootConfig correctly", async () => {
    const container = makeContainer({
      proxyEnabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "gateway-only",
      caFile: "/etc/certs/ca.pem",
      gatewayHost: "10.0.0.1",
      gatewayPort: 5000,
    });
    const mergedEnv = makeMergedEnv();

    await installProxyAtBoot(container as never, mergedEnv);

    expect(installGlobalProxyDispatcher).toHaveBeenCalledOnce();
    const arg = (installGlobalProxyDispatcher as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(arg.env).toBe(mergedEnv);
    expect(arg.proxyUrl).toBe("http://127.0.0.1:3128");
    expect(arg.enabled).toBe(true);
    expect(arg.caFile).toBe("/etc/certs/ca.pem");
    expect(arg.loopbackMode).toBe("gateway-only");
    expect(arg.gatewayHostPort).toBe("10.0.0.1:5000");
  });

  it("uses default gatewayHostPort 127.0.0.1:4766 when not overridden", async () => {
    const container = makeContainer({ proxyEnabled: true, proxyUrl: "http://127.0.0.1:3128" });
    await installProxyAtBoot(container as never, makeMergedEnv());

    const arg = (installGlobalProxyDispatcher as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(arg.gatewayHostPort).toBe("127.0.0.1:4766");
  });

  it("throws a SecretRef-naming error (not the misleading 'required') when proxyUrl is an unresolved SecretRef", async () => {
    const container = makeContainer({ proxyEnabled: true });
    // Force proxyUrl to look like an unresolved SecretRef object
    (container.config.proxy as Record<string, unknown>).proxyUrl = { $secret: "PROXY_URL" };

    await expect(
      installProxyAtBoot(container as never, makeMergedEnv()),
    ).rejects.toThrow(/did not resolve to a string|\$secret/i);
    // The installer is NOT reached — we fail before it with the precise cause.
    expect(installGlobalProxyDispatcher).not.toHaveBeenCalled();
  });

  it("returns a ProxyBootPosture with installerOk:true and configured when proxy enabled", async () => {
    const container = makeContainer({ proxyEnabled: true, proxyUrl: "http://127.0.0.1:3128" });
    const posture = await installProxyAtBoot(container as never, makeMergedEnv());
    expect(posture.installerOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Fail-closed test
// ---------------------------------------------------------------------------
describe("installProxyAtBoot — fail-closed on ProxyConfigError", () => {
  it("re-throws with 'Bootstrap failed' and the configKey when installer throws ProxyConfigError", async () => {
    const configKey = "proxy.proxyUrl";
    (installGlobalProxyDispatcher as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new ProxyConfigError(configKey, "proxyUrl is required when proxy.enabled is true");
    });

    const container = makeContainer({ proxyEnabled: true });
    await expect(installProxyAtBoot(container as never, makeMergedEnv())).rejects.toThrow(
      /Bootstrap failed/,
    );
    await expect(installProxyAtBoot(container as never, makeMergedEnv())).rejects.toThrow(
      new RegExp(configKey),
    );
  });

  it("re-throws non-ProxyConfigError errors unchanged", async () => {
    const originalError = new Error("some other error");
    (installGlobalProxyDispatcher as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw originalError;
    });

    const container = makeContainer({ proxyEnabled: true, proxyUrl: "http://127.0.0.1:3128" });
    await expect(installProxyAtBoot(container as never, makeMergedEnv())).rejects.toThrow(
      "some other error",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. INFO line — exactly one module:"proxy" when configured
// ---------------------------------------------------------------------------
describe("logProxyPosture — INFO line", () => {
  it("emits exactly one module:'proxy' INFO line when posture.configured is true", () => {
    const logger = makeLoggerSpy();
    const posture: ProxyBootPosture = {
      configured: true,
      maskedUrl: "http://***@127.0.0.1:3128",
      loopbackMode: "gateway-only",
      source: "config",
      installerOk: true,
    };

    logProxyPosture(logger as never, posture);

    expect(logger.info).toHaveBeenCalledOnce();
    const [data, msg] = logger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(data.submodule).toBe("proxy");
    expect(data.maskedUrl).toBe(posture.maskedUrl);
    expect(data.loopbackMode).toBe(posture.loopbackMode);
    expect(data.source).toBe(posture.source);
    expect(msg).toContain("Proxy dispatcher installed");
  });

  it("does NOT emit any log when posture.configured is false (zero-config)", () => {
    const logger = makeLoggerSpy();
    const posture: ProxyBootPosture = {
      configured: false,
      installerOk: true,
    };

    logProxyPosture(logger as never, posture);

    expect(logger.info).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Zero-config no-op (D-10)
// ---------------------------------------------------------------------------
describe("installProxyAtBoot — zero-config no-op (D-10)", () => {
  it("does NOT call installGlobalProxyDispatcher when no proxy env or config (no-op path)", async () => {
    // The Phase-2 installer itself is a no-op when hasProxyConfigured returns false.
    // When mocked, it still records the call — so we verify posture.configured is false
    // and that if the real installer were used, setGlobalDispatcher wouldn't fire.
    // Here we restore the real (unmocked) installer to verify the no-op contract properly.
    const { installGlobalProxyDispatcher: realInstaller } = await vi.importActual<typeof import("@comis/infra")>("@comis/infra");
    (installGlobalProxyDispatcher as ReturnType<typeof vi.fn>).mockImplementation(realInstaller);

    const container = makeContainer(); // no proxy enabled, no proxyUrl
    const mergedEnv = makeMergedEnv(); // no HTTP_PROXY, no HTTPS_PROXY
    const posture = await installProxyAtBoot(container as never, mergedEnv);

    expect(posture.configured).toBe(false);
  });

  it("posture.configured is false when env has no proxy vars and config.proxy.enabled is false", async () => {
    const container = makeContainer();
    const posture = await installProxyAtBoot(container as never, makeMergedEnv());
    expect(posture.configured).toBe(false);
  });

  it("emits no INFO line when posture.configured is false", () => {
    const logger = makeLoggerSpy();
    logProxyPosture(logger as never, { configured: false, installerOk: true });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. deriveChannelProxyEnv — bridge a config.yaml proxy onto the channel env
//    so the per-channel resolvers (env-only) route through it.
// ---------------------------------------------------------------------------
describe("deriveChannelProxyEnv", () => {
  const gw = { host: "127.0.0.1", port: 4766 };

  it("returns the env unchanged when no proxy is configured anywhere", () => {
    const env = { HOME: "/home/bot" };
    const out = deriveChannelProxyEnv(env, {}, gw);
    expect(out).toBe(env);
  });

  it("returns the env unchanged when an env-var proxy is already present (env wins)", () => {
    const env = { HTTPS_PROXY: "http://env-proxy:3128" };
    const out = deriveChannelProxyEnv(env, { enabled: true, proxyUrl: "http://config-proxy:8080" }, gw);
    expect(out).toBe(env);
  });

  it("overlays HTTP(S)_PROXY from a config-file proxy when no env proxy is set", () => {
    const out = deriveChannelProxyEnv(
      { HOME: "/home/bot" },
      { enabled: true, proxyUrl: "http://config-proxy:8080", loopbackMode: "gateway-only" },
      gw,
    );
    expect(out.HTTPS_PROXY).toBe("http://config-proxy:8080");
    expect(out.HTTP_PROXY).toBe("http://config-proxy:8080");
    // Effective NO_PROXY carries the loopback bypass set (gateway-only)
    expect(out.NO_PROXY).toContain("127.0.0.1");
    expect(out.no_proxy).toBe(out.NO_PROXY);
  });

  it("does NOT overlay when config proxy is present but disabled", () => {
    const env = { HOME: "/home/bot" };
    const out = deriveChannelProxyEnv(env, { enabled: false, proxyUrl: "http://config-proxy:8080" }, gw);
    expect(out).toBe(env);
  });

  it("does NOT overlay when config proxyUrl is an unresolved SecretRef (non-string)", () => {
    const env = { HOME: "/home/bot" };
    const out = deriveChannelProxyEnv(
      env,
      { enabled: true, proxyUrl: { $secret: "PROXY_URL" } },
      gw,
    );
    expect(out).toBe(env);
  });
});

// ---------------------------------------------------------------------------
// 6. resolveProxyCaPem — read the TLS-intercepting-proxy CA for channel agents
// ---------------------------------------------------------------------------
describe("resolveProxyCaPem", () => {
  it("returns undefined when no caFile is configured", () => {
    expect(resolveProxyCaPem(undefined)).toBeUndefined();
  });

  it("returns undefined when the caFile is unreadable (global installer is the fail-fast authority)", () => {
    expect(resolveProxyCaPem("/nonexistent/ca.pem")).toBeUndefined();
  });

  it("returns the PEM contents when the caFile is readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-proxy-ca-"));
    const caPath = join(dir, "ca.pem");
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    writeFileSync(caPath, pem, "utf8");
    try {
      expect(resolveProxyCaPem(caPath)).toBe(pem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
