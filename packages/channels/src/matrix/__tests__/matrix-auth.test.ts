// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import type { MatrixClient, ICreateClientOpts } from "matrix-js-sdk";
import { createMatrixAuth } from "../matrix-auth.js";
import type { MatrixState, MatrixStateStore } from "../matrix-state.js";

/** A recording state store: load() returns the seed, save() records its arg. */
function makeStateStore(seed: Partial<MatrixState> = {}): {
  store: MatrixStateStore;
  saves: MatrixState[];
} {
  const saves: MatrixState[] = [];
  const current: MatrixState = { watermarks: {}, ...seed };
  const store: MatrixStateStore = {
    load: async () => ok({ ...current }),
    save: async (state: MatrixState) => {
      saves.push(state);
      return ok(undefined);
    },
  };
  return { store, saves };
}

/** A minimal logger whose `warn` calls the test inspects for errorKind + leaks. */
function makeLogger(): ComisLogger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as ComisLogger;
}

/** Build an Error carrying Matrix `errcode`/`httpStatus`, like the SDK's MatrixError. */
function matrixError(errcode: string, httpStatus: number, message: string): Error {
  const e = new Error(message) as Error & { errcode: string; httpStatus: number };
  e.errcode = errcode;
  e.httpStatus = httpStatus;
  return e;
}

interface FakeClientBehavior {
  loginResponse?: { access_token: string; device_id: string; user_id: string };
  whoamiResponse?: { user_id: string; device_id?: string };
  loginError?: unknown;
  whoamiError?: unknown;
  /**
   * Reject `whoami` for a client that was built with THIS exact access token —
   * models a revoked/expired stored token, so the auth path can prove it fell
   * back to a password login (the fresh pre-login client carries no token).
   */
  failWhoamiForToken?: string;
}

interface ClientRecord {
  createOpts?: ICreateClientOpts;
  /** Every createClient opts in order — proves which tokens were attempted. */
  createOptsHistory: ICreateClientOpts[];
  loginCalls: Array<{ type: string; data: Record<string, unknown> }>;
  whoamiCalls: number;
  client?: MatrixClient;
}

/** A createClient seam that records its opts and yields a stubbed client. */
function makeCreateClientImpl(
  behavior: FakeClientBehavior,
  rec: ClientRecord,
): (opts: ICreateClientOpts) => MatrixClient {
  return (opts: ICreateClientOpts): MatrixClient => {
    rec.createOpts = opts;
    rec.createOptsHistory.push(opts);
    // Capture per-client so whoami's stale-token check keys on the token THIS
    // client was built with, not a later client's opts.
    const capturedToken = opts.accessToken;
    const client = {
      login: async (type: string, data: Record<string, unknown>) => {
        rec.loginCalls.push({ type, data });
        if (behavior.loginError !== undefined) throw behavior.loginError;
        return (
          behavior.loginResponse ?? {
            access_token: "srv-token",
            device_id: "SRVDEVICE",
            user_id: "@bot:hs",
          }
        );
      },
      whoami: async () => {
        rec.whoamiCalls += 1;
        if (behavior.whoamiError !== undefined) throw behavior.whoamiError;
        if (behavior.failWhoamiForToken !== undefined && capturedToken === behavior.failWhoamiForToken) {
          throw matrixError("M_UNKNOWN_TOKEN", 401, "stored token revoked");
        }
        return behavior.whoamiResponse ?? { user_id: "@bot:hs", device_id: "SRVDEVICE" };
      },
    };
    const cast = client as unknown as MatrixClient;
    rec.client = cast;
    return cast;
  };
}

function newRecord(): ClientRecord {
  return { createOptsHistory: [], loginCalls: [], whoamiCalls: 0 };
}

describe("createMatrixAuth", () => {
  it("builds a token client with the configured access token and validates via whoami", async () => {
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl(
      { whoamiResponse: { user_id: "@bot:hs", device_id: "DEV1" } },
      rec,
    );
    const { store } = makeStateStore();

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      accessToken: "token-abc",
      deviceId: "DEV1",
      stateStore: store,
      logger: makeLogger(),
      createClientImpl,
    });

    const result = await auth.authenticate();

    expect(result.ok).toBe(true);
    expect(rec.createOpts?.accessToken).toBe("token-abc");
    expect(rec.createOpts?.baseUrl).toBe("https://hs.example");
    expect(rec.whoamiCalls).toBe(1);
    expect(rec.loginCalls).toHaveLength(0);
    if (result.ok) {
      expect(result.value.userId).toBe("@bot:hs");
      expect(result.value.deviceId).toBe("DEV1");
      expect(result.value.client).toBe(rec.client);
    }
  });

  it("persists the server-returned access token and device id on a password login", async () => {
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl(
      {
        loginResponse: { access_token: "srv-token-xyz", device_id: "SRVDEV", user_id: "@bot:hs" },
        whoamiResponse: { user_id: "@bot:hs", device_id: "SRVDEV" },
      },
      rec,
    );
    const { store, saves } = makeStateStore();

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      password: "pw-secret",
      stateStore: store,
      logger: makeLogger(),
      createClientImpl,
    });

    const result = await auth.authenticate();

    expect(result.ok).toBe(true);
    // Pre-login client carries NO access token.
    expect(rec.createOpts?.accessToken).toBeUndefined();
    // Login was driven with the password flow and user identifier.
    expect(rec.loginCalls).toHaveLength(1);
    expect(rec.loginCalls[0]?.type).toBe("m.login.password");
    expect(rec.loginCalls[0]?.data.user).toBe("@bot:hs");
    // The RETURNED token + device id are persisted (identity survives restart).
    expect(saves).toHaveLength(1);
    expect(saves[0]?.accessToken).toBe("srv-token-xyz");
    expect(saves[0]?.deviceId).toBe("SRVDEV");
    if (result.ok) {
      expect(result.value.userId).toBe("@bot:hs");
      expect(result.value.deviceId).toBe("SRVDEV");
    }
  });

  it("preserves an existing sync token and watermarks when persisting a password login", async () => {
    // A blind overwrite would reset the watermarks and drop the sync token,
    // forcing a full re-sync and replaying the backlog past the guard.
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl(
      {
        loginResponse: { access_token: "srv-token-xyz", device_id: "SRVDEV", user_id: "@bot:hs" },
        whoamiResponse: { user_id: "@bot:hs", device_id: "SRVDEV" },
      },
      rec,
    );
    const { store, saves } = makeStateStore({ syncToken: "prev-since", watermarks: { "!r:hs": 99 } });

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      password: "pw-secret",
      stateStore: store,
      logger: makeLogger(),
      createClientImpl,
    });

    await auth.authenticate();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.syncToken).toBe("prev-since");
    expect(saves[0]?.watermarks?.["!r:hs"]).toBe(99);
    expect(saves[0]?.accessToken).toBe("srv-token-xyz");
    expect(saves[0]?.deviceId).toBe("SRVDEV");
  });

  it("classifies a whoami failure as an auth error and never leaks the token", async () => {
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl(
      { whoamiError: matrixError("M_UNKNOWN_TOKEN", 401, "rejected token super-secret-token") },
      rec,
    );
    const { store } = makeStateStore();
    const logger = makeLogger();

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      accessToken: "super-secret-token",
      stateStore: store,
      logger,
      createClientImpl,
    });

    const result = await auth.authenticate();

    expect(result.ok).toBe(false);
    const warn = vi.mocked(logger.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] ?? [];
    expect((fields as { errorKind?: string }).errorKind).toBe("auth");
    // The secret never appears in the returned error nor the log fields.
    if (!result.ok) {
      expect(result.error.message).not.toContain("super-secret-token");
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-token");
  });

  it("classifies a password login failure without leaking the password and does not persist", async () => {
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl(
      { loginError: matrixError("M_FORBIDDEN", 403, "bad password hunter2-secret") },
      rec,
    );
    const { store, saves } = makeStateStore();
    const logger = makeLogger();

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      password: "hunter2-secret",
      stateStore: store,
      logger,
      createClientImpl,
    });

    const result = await auth.authenticate();

    expect(result.ok).toBe(false);
    expect(saves).toHaveLength(0); // login failed before any persist
    const warn = vi.mocked(logger.warn);
    const [fields] = warn.mock.calls[0] ?? [];
    expect((fields as { errorKind?: string }).errorKind).toBe("auth");
    if (!result.ok) {
      expect(result.error.message).not.toContain("hunter2-secret");
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2-secret");
  });

  it("errors when neither an access token nor a password is provided", async () => {
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl({}, rec);
    const { store } = makeStateStore();

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      stateStore: store,
      logger: makeLogger(),
      createClientImpl,
    });

    const result = await auth.authenticate();

    expect(result.ok).toBe(false);
    expect(rec.createOpts).toBeUndefined();
  });

  it("reuses a persisted access token + device id on a later boot instead of re-running password login", async () => {
    // A password deployment persists the server-returned token + device id on its
    // FIRST login. On a later boot the auth path must AUTHENTICATE with that
    // persisted token + device id (whoami validates it) rather than re-running
    // m.login.password — otherwise the homeserver mints a brand-new device every
    // restart and (once E2EE lands) orphans that device's Megolm keys.
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl(
      { whoamiResponse: { user_id: "@bot:hs", device_id: "PERSISTDEV" } },
      rec,
    );
    const { store, saves } = makeStateStore({ accessToken: "persisted-tok", deviceId: "PERSISTDEV" });

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      // A password IS configured (this is a password deployment), but it must NOT
      // be used on a boot where a valid persisted token is available.
      password: "pw-secret",
      stateStore: store,
      logger: makeLogger(),
      createClientImpl,
    });

    const result = await auth.authenticate();

    expect(result.ok).toBe(true);
    // The token path ran with the PERSISTED token + device id — no fresh login.
    expect(rec.loginCalls).toHaveLength(0);
    expect(rec.createOpts?.accessToken).toBe("persisted-tok");
    expect(rec.createOpts?.deviceId).toBe("PERSISTDEV");
    expect(rec.whoamiCalls).toBe(1);
    // Nothing changed → no state re-written, and the device id is unchanged.
    expect(saves).toHaveLength(0);
    if (result.ok) {
      expect(result.value.deviceId).toBe("PERSISTDEV");
      expect(result.value.accessToken).toBe("persisted-tok");
    }
  });

  it("falls back to password login when the persisted token is rejected, reusing the persisted device id", async () => {
    // If the stored token was revoked while the bot was offline, whoami rejects
    // it. A password deployment must then recover by re-logging in — reusing the
    // persisted device id so the identity is still preserved — rather than
    // failing to start.
    const rec = newRecord();
    const createClientImpl = makeCreateClientImpl(
      {
        failWhoamiForToken: "stale-tok",
        loginResponse: {
          access_token: "fresh-after-fallback",
          device_id: "PERSISTDEV",
          user_id: "@bot:hs",
        },
        whoamiResponse: { user_id: "@bot:hs", device_id: "PERSISTDEV" },
      },
      rec,
    );
    const { store, saves } = makeStateStore({ accessToken: "stale-tok", deviceId: "PERSISTDEV" });

    const auth = createMatrixAuth({
      homeserverUrl: "https://hs.example",
      userId: "@bot:hs",
      password: "pw-secret",
      stateStore: store,
      logger: makeLogger(),
      createClientImpl,
    });

    const result = await auth.authenticate();

    expect(result.ok).toBe(true);
    // The persisted token WAS attempted (a client was built with it) before falling back.
    expect(rec.createOptsHistory.some((o) => o.accessToken === "stale-tok")).toBe(true);
    // Then a password re-login ran, reusing the persisted device id.
    expect(rec.loginCalls).toHaveLength(1);
    expect(rec.loginCalls[0]?.data.device_id).toBe("PERSISTDEV");
    // The fresh token was persisted for the next boot.
    expect(saves.some((s) => s.accessToken === "fresh-after-fallback")).toBe(true);
  });
});
