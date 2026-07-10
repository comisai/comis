// Installer guard — the browser tool ships ENABLED by default (full capability
// out of the box), so the installer must PROVISION the browser runtime by
// default. Before this, the browser tool's config default was off AND the
// installer's Chromium provisioning was off (`--with-browser` opt-in) — consistent.
// Now the tool is default-ON (browser.enabled + skills.builtinTools.browser), so
// a fresh install must install Chromium + the headless shared libs by default,
// AND the Xvfb headed stack (so headless-detecting sites work), or the default-ON
// tool is crippled at first use for lack of a runtime.
//
// The contract under test:
//   1. WITH_BROWSER and WITH_XVFB both default to 1 (Chromium + headed stack
//      provisioned by default), overridable down via COMIS_WITH_BROWSER / _XVFB.
//   2. --without-browser opts out of the WHOLE stack (must also zero WITH_XVFB /
//      WITH_CLOAKBROWSER, else the pre-parse `WITH_XVFB=1 ⟹ WITH_BROWSER=1`
//      implication silently re-enables it); --without-xvfb keeps headless-only.
//   3. Provisioning stays STRICTLY best-effort — the install_browser_deps_linux
//      call sites guard with `|| true` and the render_xvfb_unit call guards with
//      `|| ...`, so a box where Chromium/Xvfb can't install (arm64 / locked-down
//      apt / rootless) still gets a fully working daemon (the browser tool then
//      fails honestly at use, never aborting the install).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installSh = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");

/** Body of a `case` branch: text between `<label>)` and the next `;;`. */
function caseBranch(label: string): string {
  const start = installSh.indexOf(`${label})`);
  if (start === -1) return "";
  const end = installSh.indexOf(";;", start);
  return end === -1 ? installSh.slice(start) : installSh.slice(start, end);
}

/** Extract one top-level `name() { … }` bash function (empty if absent). */
function fnBody(name: string): string {
  const lines = installSh.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}()`));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return end === -1 ? "" : lines.slice(start, end + 1).join("\n");
}

describe("install.sh browser + xvfb provisioning is on by default (full capability out of the box)", () => {
  it("WITH_BROWSER defaults to 1, overridable down via COMIS_WITH_BROWSER", () => {
    const m = installSh.match(/WITH_BROWSER="\$\{COMIS_WITH_BROWSER:-(\d)\}"/);
    expect(m, "WITH_BROWSER must read COMIS_WITH_BROWSER with a default").not.toBeNull();
    expect(m?.[1], "browser provisioning must default ON (matches the default-ON browser tool)").toBe("1");
  });

  it("WITH_XVFB defaults to 1 (headed stack on by default), overridable down via COMIS_WITH_XVFB", () => {
    const m = installSh.match(/WITH_XVFB="\$\{COMIS_WITH_XVFB:-(\d)\}"/);
    expect(m, "WITH_XVFB must read COMIS_WITH_XVFB with a default").not.toBeNull();
    expect(m?.[1], "xvfb headed provisioning must default ON").toBe("1");
  });

  it("--without-browser opts out of the WHOLE stack (zeroes browser + xvfb + cloakbrowser)", () => {
    const branch = caseBranch("--without-browser");
    expect(branch, "a --without-browser flag must exist").not.toBe("");
    expect(branch, "--without-browser must zero WITH_BROWSER").toMatch(/WITH_BROWSER=0/);
    // Must also zero the implication sources, else the pre-parse
    // `WITH_XVFB=1 ⟹ WITH_BROWSER=1` silently re-enables the stack.
    expect(branch, "--without-browser must also zero WITH_XVFB").toMatch(/WITH_XVFB=0/);
    expect(branch, "--without-browser must also zero WITH_CLOAKBROWSER").toMatch(/WITH_CLOAKBROWSER=0/);
  });

  it("--without-xvfb keeps the headless browser but drops the headed stack", () => {
    const branch = caseBranch("--without-xvfb");
    expect(branch, "a --without-xvfb flag must exist").not.toBe("");
    expect(branch, "--without-xvfb must zero WITH_XVFB").toMatch(/WITH_XVFB=0/);
    expect(branch, "--without-xvfb must NOT touch WITH_BROWSER (headless stays)").not.toMatch(/WITH_BROWSER=/);
  });

  it("every install_browser_deps_linux call site is best-effort (|| true) — never aborts the install", () => {
    const callSites = installSh
      .split("\n")
      .filter((l) => /\binstall_browser_deps_linux\b/.test(l) && !l.trim().startsWith("#") && !l.includes("()"));
    expect(callSites.length, "install_browser_deps_linux must be invoked at least once").toBeGreaterThan(0);
    for (const line of callSites) {
      expect(line, `browser-deps call must be best-effort: ${line.trim()}`).toMatch(/\|\|\s*true\s*$/);
    }
  });

  it("the render_xvfb_unit call site is best-effort (|| ...) — a failed unit never aborts the install", () => {
    const callSites = installSh
      .split("\n")
      .filter((l) => /\brender_xvfb_unit\b/.test(l) && !l.trim().startsWith("#") && !l.includes("()"));
    expect(callSites.length, "render_xvfb_unit must be invoked at least once").toBeGreaterThan(0);
    for (const line of callSites) {
      expect(line, `xvfb-unit call must be best-effort: ${line.trim()}`).toMatch(/\|\|/);
    }
  });

  it("install_browser_deps_linux short-circuits when WITH_BROWSER is not 1 (respects the opt-out)", () => {
    expect(installSh).toMatch(/install_browser_deps_linux\(\)\s*\{[\s\S]{0,160}WITH_BROWSER"\s*==\s*"1"\s*\]\]\s*\|\|\s*return 0/);
  });

  // Xvfb (headed) is a best-effort UPGRADE over headless Chromium — never a hard
  // requirement. If the Xvfb stack fails to install, the daemon must fall back to
  // the (already-installed) headless Chromium instead of a headed-but-broken tool.
  // The authoritative signal is GROUND TRUTH — is the Xvfb binary actually present
  // — not the WITH_XVFB intent flag, so the fallback holds across all install paths
  // regardless of ordering.
  it("defines an xvfb_present ground-truth check against the real Xvfb binary", () => {
    const body = fnBody("xvfb_present");
    expect(body, "an xvfb_present() ground-truth helper must exist").not.toBe("");
    expect(body, "xvfb_present must probe the actual Xvfb binary").toMatch(/\/usr\/bin\/Xvfb|command -v Xvfb/);
  });

  it("install_xvfb_pkg downshifts WITH_XVFB to headless when the Xvfb install fails", () => {
    const helper = fnBody("install_xvfb_pkg");
    expect(helper, "an install_xvfb_pkg() helper must exist").not.toBe("");
    expect(helper, "the Xvfb install must be verified against ground truth").toMatch(/xvfb_present/);
    expect(helper, "a failed Xvfb install must downshift WITH_XVFB=0 (headless fallback)").toMatch(/WITH_XVFB=0/);
    // browser-deps must route Xvfb installs through the downshifting helper.
    expect(installSh, "install_browser_deps_linux must install Xvfb via install_xvfb_pkg").toMatch(
      /install_xvfb_pkg \$sudo_cmd/,
    );
  });

  it("render_xvfb_unit refuses to register the companion unit when Xvfb is absent", () => {
    const body = fnBody("render_xvfb_unit");
    // Must consult the ground-truth helper — not merely reference the binary in
    // ExecStart (which it always does). A guarded early-return keeps a stale unit
    // off a box where the Xvfb package failed to install.
    expect(body, "render_xvfb_unit must gate on xvfb_present, not just WITH_XVFB").toMatch(/xvfb_present/);
  });

  it("grants Chrome's extra syscalls (pkey + landlock) in the systemd SystemCallFilter when the browser is provisioned", () => {
    // Chrome is SIGSYS-killed (status=31/SYS) before opening the CDP socket
    // under `SystemCallFilter=@system-service @mount setns` — it needs pkey_*
    // (V8 memory-protection keys, syscall 330) and landlock_* (its own
    // self-sandbox, syscall 444). Verified via seccomp audit on a clean install:
    // WITHOUT these, headless AND headed Chrome die and the browser tool's
    // navigate fails `connectOverCDP ECONNREFUSED`. Landlock is restriction-only
    // (Chrome can only ADD limits to itself) so allowing it is low-risk.
    // Gated on WITH_BROWSER so a --without-browser install keeps the tighter set.
    expect(installSh, "a browser-only SystemCallFilter line var must default empty").toMatch(
      /COMIS_BROWSER_SYSCALL_LINE=""/,
    );
    const m = installSh.match(/COMIS_BROWSER_SYSCALL_LINE="SystemCallFilter=([^"]+)"/);
    expect(m, "COMIS_BROWSER_SYSCALL_LINE must be assigned the Chrome syscalls").not.toBeNull();
    const syscalls = m?.[1] ?? "";
    // The converged set (SIGSYS-audit-iterated until Chrome launches + serves CDP
    // + renders a real page with zero denials): pkey + landlock + ptrace + seccomp.
    for (const sc of ["pkey_alloc", "pkey_free", "pkey_mprotect", "landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self", "ptrace", "seccomp"]) {
      expect(syscalls, `SystemCallFilter must grant ${sc}`).toContain(sc);
    }
    // The assignment must live inside the WITH_BROWSER conditional (so
    // --without-browser omits it): default-empty decl → WITH_BROWSER guard → assign.
    const iDefault = installSh.indexOf('COMIS_BROWSER_SYSCALL_LINE=""');
    const iGuard = installSh.indexOf('if [[ "$WITH_BROWSER" == "1" ]]; then', iDefault);
    const iAssign = installSh.indexOf('COMIS_BROWSER_SYSCALL_LINE="SystemCallFilter=');
    expect(iGuard, "a WITH_BROWSER guard must sit between the default and the assignment").toBeGreaterThan(iDefault);
    expect(iAssign, "the syscall assignment must be gated by WITH_BROWSER").toBeGreaterThan(iGuard);
    // The rendered unit must interpolate the line.
    expect(installSh, "the unit body must emit the browser syscall line").toContain("${COMIS_BROWSER_SYSCALL_LINE}");
  });

  it("maybe_seed_browser_config seeds headless:false ONLY when Xvfb is actually present", () => {
    const body = fnBody("maybe_seed_browser_config");
    expect(body, "config seed must exist").not.toBe("");
    // The headed (headless=false) decision must be gated on ground-truth Xvfb
    // presence, so a failed headed install doesn't leave the browser configured
    // headed with no display.
    expect(body, "headless:false must be gated on Xvfb ground-truth presence").toMatch(
      /headless_value="false"[\s\S]*/,
    );
    expect(body, "the headed decision must consult xvfb_present (ground truth)").toMatch(/xvfb_present/);
  });
});
