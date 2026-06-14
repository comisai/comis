// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the in-jail relay-as-init runtime (`egress-relay-init.ts`)
 * — specifically the BEST-EFFORT privilege drop.
 *
 * The relay-init runs INSIDE the bwrap jail as userns-root (for `listed-hosts`
 * the jail does NOT pre-drop `--uid` — `lo`-up needs CAP_NET_ADMIN), then attempts
 * `setgid`/`setuid` to the net-new uid (65534). On the root-worker VPS the bwrap
 * user namespace maps a SINGLE uid (host-root → userns-root), so 65534 is NOT a
 * mapped target and `process.setuid(65534)` throws EINVAL/EPERM. The egress transport
 * spike PROVED the egress transport working as userns-root with NO uid drop.
 *
 * The fix makes {@link dropPrivileges} best-effort: it attempts the drop, and on a
 * failure (the not-mapped EPERM/EINVAL case) it emits a STRUCTURED audit WARN and
 * CONTINUES — it MUST NOT throw (a throw would crash the relay-init PID-1 and kill
 * the whole listed-hosts session; the bwrap user+pid+net+fs namespaces + env-scrub
 * + the egress allowlist still confine the child at userns-root — "root in a box").
 *
 * These tests import the PURE functions WITHOUT triggering the module's top-level
 * `main()` side effect (it is guarded so it runs only when executed as the entry
 * script, never on import). They assert the no-throw + structured-audit contract on
 * macOS (the LIVE not-mapped drop is VPS-only); the side-effect-free `main()` guard
 * is what makes the runtime module importable here at all.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { dropPrivileges, buildRelayChildEnv, type RelayInitAudit } from "./egress-relay-init.js";

describe("egress-relay-init dropPrivileges — best-effort under the unmapped userns-root", () => {
  it("does NOT throw when setuid throws the not-mapped EPERM/EINVAL (the VPS root-worker reality)", () => {
    const audit: RelayInitAudit[] = [];
    // Simulate the VPS root-worker: 65534 is not a mapped uid in the single-uid
    // bwrap userns, so setuid throws EINVAL — the live `does_own_process_state`
    // throw the gap describes. dropPrivileges MUST swallow it and continue.
    const setgid = (): never => {
      const err = new Error("EPERM: operation not permitted, uv_setgid");
      (err as NodeJS.ErrnoException).code = "EPERM";
      throw err;
    };
    const setuid = (): never => {
      const err = new Error("EINVAL: invalid argument, uv_setuid");
      (err as NodeJS.ErrnoException).code = "EINVAL";
      throw err;
    };
    expect(() =>
      dropPrivileges(65534, 65534, { setgid, setuid, audit: (rec) => audit.push(rec) }),
    ).not.toThrow();
  });

  it("emits a STRUCTURED audit WARN recording the unmapped-drop posture (no silent degrade)", () => {
    const audit: RelayInitAudit[] = [];
    const setgid = (): never => {
      const err = new Error("EPERM");
      (err as NodeJS.ErrnoException).code = "EPERM";
      throw err;
    };
    const setuid = (): never => {
      const err = new Error("EINVAL");
      (err as NodeJS.ErrnoException).code = "EINVAL";
      throw err;
    };
    dropPrivileges(65534, 65534, { setgid, setuid, audit: (rec) => audit.push(rec) });
    // The drop failure MUST be observable — a structured record naming the
    // listed-hosts-running-at-userns-uid posture + the net-new target it could not
    // reach. (Both setgid and setuid fail here → at least one audit record.)
    expect(audit.length).toBeGreaterThan(0);
    const joined = JSON.stringify(audit);
    expect(joined).toContain("65534");
    // The audit names the security posture (running at the jail userns uid because
    // the drop target is not mapped) — the no-silent-degrade requirement.
    expect(joined.toLowerCase()).toContain("listed-hosts");
    expect(joined.toLowerCase()).toMatch(/not\s*mapped|unmapped|userns/);
    // It carries an errorKind for the §2.7 log matrix.
    expect(audit.some((r) => typeof r.errorKind === "string")).toBe(true);
  });

  it("applies the drop cleanly when the ids ARE mapped (none/full path, no audit warn)", () => {
    const audit: RelayInitAudit[] = [];
    const calls: Array<[string, number]> = [];
    const setgid = (g: number): void => {
      calls.push(["setgid", g]);
    };
    const setuid = (u: number): void => {
      calls.push(["setuid", u]);
    };
    dropPrivileges(65534, 65534, { setgid, setuid, audit: (rec) => audit.push(rec) });
    // gid BEFORE uid (a uid drop first would forbid the later setgid).
    expect(calls).toEqual([
      ["setgid", 65534],
      ["setuid", 65534],
    ]);
    // A successful drop emits NO warn audit (the happy none/full path stays quiet).
    expect(audit.length).toBe(0);
  });

  it("is a no-op when no ids are supplied (the init exec's the child at the jail uid)", () => {
    const audit: RelayInitAudit[] = [];
    let called = false;
    const setgid = (): void => {
      called = true;
    };
    const setuid = (): void => {
      called = true;
    };
    dropPrivileges(undefined, undefined, { setgid, setuid, audit: (rec) => audit.push(rec) });
    expect(called).toBe(false);
    expect(audit.length).toBe(0);
  });
});

describe("egress-relay-init buildRelayChildEnv — points the driven child at the in-jail relay", () => {
  it("sets HTTPS_PROXY/HTTP_PROXY (+ lowercase) to http://127.0.0.1:<relayPort> so the child egresses through the allowlist", () => {
    // The bug this guards (live VPS 2026-06-14): the relay materialized + bound the
    // loopback relay, but execChild spawned the driven CLI with NO proxy env, so
    // curl/claude tried a DIRECT connection that --unshare-net blocks ("could not
    // resolve host" / claude hangs). The relay-init KNOWS the bound port, so it must
    // authoritatively set the proxy env on the child (independent of bwrap env-forwarding).
    const env = buildRelayChildEnv({ PATH: "/usr/bin", HOME: "/home/comis" }, 41234);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:41234");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:41234");
    expect(env.https_proxy).toBe("http://127.0.0.1:41234");
    expect(env.http_proxy).toBe("http://127.0.0.1:41234");
    // Inherited env is preserved (the scrubbed env + the bound paths still reach the child).
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/comis");
  });
});
