// Installer guard — repair_comisai_bundled_deps must detect EVERY bundled-deps prune shape,
// not just the two sentinel files it greps for.
//
// `npm install -g comisai(.tgz)` over an existing global prefix prunes transitive deps of
// non-bundled direct deps. The repair in website/public/install.sh keyed off two SENTINELS
// (an empty node_modules/bindings, a missing glob for pi-coding-agent) — so a prune that
// leaves both intact while breaking another module (live VPS reinstall: @earendil-works/pi-tui
// pruned → `comis --version` died with ERR_MODULE_NOT_FOUND while both sentinels were green)
// sailed past the repair and shipped a broken CLI. The fix is a BEHAVIORAL canary: actually
// load the installed CLI entry (`node dist/cli-entry.js --version`) and reify on any failure.
//
// This test runs the REAL bash function (extracted from install.sh) against a simulated
// installed tree, with `npm` stubbed to record invocation:
//   1. load-broken tree + clean sentinels  → the repair MUST fire (the live incident shape);
//   2. healthy tree                        → the repair MUST NOT fire (stays cheap/idempotent).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installSh = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");

/** Extract one top-level `name() { … }` bash function from install.sh (empty if absent). */
function extractFn(name: string): string {
  const lines = installSh.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}()`));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

interface Scenario {
  cliExitCode: number;
}

/** Build a fake installed comisai dir with CLEAN sentinels and run the real repair function. */
function runRepair({ cliExitCode }: Scenario): { npmInvoked: boolean } {
  const work = mkdtempSync(join(tmpdir(), "comis-installer-repair-"));
  cleanups.push(work);
  const pkgDir = join(work, "comisai");

  // Clean sentinels: a non-empty bindings/ and a present glob for pi-coding-agent.
  mkdirSync(join(pkgDir, "node_modules", "bindings"), { recursive: true });
  writeFileSync(join(pkgDir, "node_modules", "bindings", "bindings.js"), "module.exports = {};\n");
  mkdirSync(join(pkgDir, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
  mkdirSync(join(pkgDir, "node_modules", "glob"), { recursive: true });
  writeFileSync(join(pkgDir, "node_modules", "glob", "package.json"), "{}\n");

  // The CLI entry the `comis` bin points at — exit code simulates loadable vs ERR_MODULE_NOT_FOUND.
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "dist", "cli-entry.js"), `process.exit(${cliExitCode});\n`);

  // Stub npm: record the invocation, then "fix" the tree like the reify would.
  const binDir = join(work, "bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(work, "npm-invoked");
  writeFileSync(
    join(binDir, "npm"),
    `#!/usr/bin/env bash\ntouch "${marker}"\nprintf 'process.exit(0);\\n' > "${pkgDir}/dist/cli-entry.js"\nexit 0\n`,
  );
  chmodSync(join(binDir, "npm"), 0o755);

  const harness = [
    "#!/usr/bin/env bash",
    "set -u",
    // UI + helpers the function calls, stubbed to no-ops / the fake dir.
    "ui_info() { :; }",
    "ui_success() { :; }",
    "ui_warn() { :; }",
    `resolve_comisai_install_dir() { echo "${pkgDir}"; }`,
    extractFn("comisai_cli_loads"),
    extractFn("repair_comisai_bundled_deps"),
    "repair_comisai_bundled_deps",
  ].join("\n");
  const harnessPath = join(work, "harness.sh");
  writeFileSync(harnessPath, harness);

  execFileSync("bash", [harnessPath], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    stdio: "pipe",
  });
  return { npmInvoked: existsSync(marker) };
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("install.sh repair_comisai_bundled_deps", () => {
  it("fires on a load-broken tree even when both sentinels are clean (the pi-tui prune shape)", () => {
    expect(runRepair({ cliExitCode: 1 }).npmInvoked).toBe(true);
  });

  it("stays a no-op on a healthy tree (no reify on every install)", () => {
    expect(runRepair({ cliExitCode: 0 }).npmInvoked).toBe(false);
  });
});

describe("install.sh systemd unit template", () => {
  // The UNIT/XVFB/HDR heredocs are UNQUOTED so ${COMIS_*} placeholders expand — which means a
  // backtick (or $() ) anywhere in the template EXECUTES during render. Live install hit exactly
  // that: a template comment said `filesystem: home` in backticks → bash ran `filesystem: home`
  // → "line 3865: filesystem:: command not found" on every install, and the rendered unit's
  // comment was silently mangled. Guard the whole class: expansion-heredoc bodies may expand
  // variables but must never carry command substitution.
  const heredocBodies = (): Array<{ tag: string; line: number; text: string }> => {
    const lines = installSh.split("\n");
    const bodies: Array<{ tag: string; line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/<<(UNIT|XVFB|HDR|ENV|YAML)\b/);
      if (!open) continue;
      const tag = open[1];
      const end = lines.findIndex((l, j) => j > i && l === tag);
      bodies.push({ tag, line: i + 1, text: lines.slice(i + 1, end === -1 ? undefined : end).join("\n") });
      if (end !== -1) i = end;
    }
    return bodies;
  };

  it("expansion heredocs carry no command substitution (backticks / $() execute at render)", () => {
    const offenders = heredocBodies()
      .filter((b) => b.text.includes("`") || b.text.includes("$("))
      .map((b) => `${b.tag} heredoc at install.sh:${b.line}`);
    expect(offenders).toEqual([]);
  });
});
