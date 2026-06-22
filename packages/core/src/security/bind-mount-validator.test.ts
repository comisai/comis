// SPDX-License-Identifier: Apache-2.0
//
// JAIL-03 (Phase 211): validateBindMount is a PURE path validator that is the
// denylist backstop on top of the allow-list jail binds. It must reject:
//   (1) a bind whose resolved path IS or is UNDER a denylisted dir,
//   (2) a coarse PARENT bind that COVERS a blocked descendant,
//   (3) a SYMLINKED leaf whose realpath resolves INTO a blocked path
//       (resolve-through-ancestors, NOT a string-prefix check on the
//        unresolved path — a symlinked leaf must not smuggle a blocked path).
// It takes `home` as a PARAMETER (purity — never reads process.env) and is
// macOS-testable because the symlink-resolve branch is pure `fs` (no bwrap).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateBindMount } from "./bind-mount-validator.js";

describe("validateBindMount", () => {
  // A real temp HOME the credential-dir checks resolve against, plus a real
  // scratch dir for the symlink cases (so realpath actually resolves).
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "bmv-home-"));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bmv-scratch-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // ── Branch 1: direct denylist hit (system dirs) ──────────────────────────

  it("rejects a bind of the /etc system directory itself", () => {
    expect(validateBindMount("/etc", home).ok).toBe(false);
  });

  it("rejects a bind of a file located under /etc (e.g. /etc/shadow)", () => {
    expect(validateBindMount("/etc/shadow", home).ok).toBe(false);
  });

  it("rejects a bind of a path under the /proc pseudo-filesystem", () => {
    expect(validateBindMount("/proc/1", home).ok).toBe(false);
  });

  it("rejects a bind of each remaining system dir (/sys /dev /root /run)", () => {
    for (const dir of ["/sys", "/dev", "/root", "/run"]) {
      expect(validateBindMount(dir, home).ok).toBe(false);
    }
  });

  // ── Branch 1: direct denylist hit (credential dirs under HOME) ────────────

  it("rejects a bind of the ~/.ssh credential directory", () => {
    expect(validateBindMount(path.join(home, ".ssh"), home).ok).toBe(false);
  });

  it("rejects a bind of an ~/.aws credential file under the dir", () => {
    expect(validateBindMount(path.join(home, ".aws", "credentials"), home).ok).toBe(false);
  });

  it("rejects a bind of each remaining credential dir (.gnupg .config .npm .netrc)", () => {
    for (const name of [".gnupg", ".config", ".npm", ".netrc"]) {
      expect(validateBindMount(path.join(home, name), home).ok).toBe(false);
    }
  });

  // ── Branch 2: parent-cover (a coarse bind covering a blocked descendant) ──

  it("rejects binding / because it is a parent covering /etc and friends", () => {
    const res = validateBindMount("/", home);
    expect(res.ok).toBe(false);
  });

  it("rejects binding the HOME dir because it covers ~/.ssh and credentials", () => {
    const res = validateBindMount(home, home);
    expect(res.ok).toBe(false);
  });

  // ── Branch 3: symlink-escape (realpath resolves into a blocked path) ──────

  it("rejects a symlinked leaf whose realpath resolves into /etc", () => {
    const link = path.join(scratch, "sneaky-link");
    fs.symlinkSync("/etc", link);
    expect(validateBindMount(link, home).ok).toBe(false);
  });

  it("rejects a symlinked leaf whose realpath resolves into ~/.ssh", () => {
    const sshDir = path.join(home, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    const link = path.join(scratch, "ssh-link");
    fs.symlinkSync(sshDir, link);
    expect(validateBindMount(link, home).ok).toBe(false);
  });

  it("allows a symlink that resolves to a non-blocked sibling path", () => {
    const realsub = path.join(scratch, "realsub");
    fs.mkdirSync(realsub, { recursive: true });
    const safe = path.join(scratch, "safe-link");
    fs.symlinkSync(realsub, safe);
    expect(validateBindMount(safe, home).ok).toBe(true);
  });

  // ── Allow: workspace / tmpdir / non-credential dotfiles ───────────────────

  it("allows a bind of a non-credential dotfile such as ~/.gitconfig", () => {
    expect(validateBindMount(path.join(home, ".gitconfig"), home).ok).toBe(true);
  });

  it("allows a bind of a workspace path inside a temp directory", () => {
    const workspace = path.join(scratch, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    expect(validateBindMount(workspace, home).ok).toBe(true);
  });

  it("allows a bind of the non-credential ~/.nvm node-version directory", () => {
    expect(validateBindMount(path.join(home, ".nvm"), home).ok).toBe(true);
  });

  // ── A rejection carries a human-readable reason (content-free diagnostics) ─

  it("returns a descriptive reason string when a bind is rejected", () => {
    const res = validateBindMount("/etc/shadow", home);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(typeof res.reason).toBe("string");
      expect(res.reason.length).toBeGreaterThan(0);
    }
  });
});
