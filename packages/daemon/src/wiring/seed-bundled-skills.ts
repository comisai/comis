// SPDX-License-Identifier: Apache-2.0
/**
 * Seed EVERY bundled skill into the user data dir, version-aware.
 *
 * Generalizes the former single-`skill-creator` boot IIFE (daemon.ts) to AUTO-SCAN
 * `packages/daemon/bundled-skills/<name>/` and seed each into `<dataDir>/skills/<name>`.
 * So shipping a new bundled skill (claude-code, codex, …) is ZERO engine code — drop the
 * dir, it seeds at next boot (matching the CLI-agnostic / "add a skill = no code" direction).
 *
 * Seed decision per skill (same semantics as the old skill-creator logic): seed when the
 * skill is NOT installed, OR the bundled `version:` differs from the installed one. Idempotent
 * boot: identical disk state in ⇒ no copies. The pure {@link seedBundledSkills} takes injected
 * fs seams so the decision is unit-provable without a real disk; {@link defaultSeedBundledSkillsDeps}
 * wires the production `node:fs` + `safePath` confinement.
 *
 * @module
 */
import {
  readdirSync as nodeReaddirSync,
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  mkdirSync as nodeMkdirSync,
  cpSync as nodeCpSync,
} from "node:fs";
import { safePath } from "@comis/core";
import { parse as parseYaml } from "yaml";

/** Injected seams for {@link seedBundledSkills} (defaulted to real fs by {@link defaultSeedBundledSkillsDeps}). */
export interface SeedBundledSkillsDeps {
  /** `packages/daemon/bundled-skills` (the source root). */
  readonly bundledRoot: string;
  /** `<dataDir>/skills` (the install target). */
  readonly skillsTarget: string;
  /** The bundled skill names = subdirs of `bundledRoot` that contain a SKILL.md. */
  listSkillNames: (bundledRoot: string) => string[];
  /** The `version:` in `<bundledRoot>/<name>/SKILL.md`, or undefined. */
  bundledVersion: (bundledRoot: string, name: string) => string | undefined;
  /** The `version:` in `<skillsTarget>/<name>/SKILL.md`, or undefined when NOT installed. */
  installedVersion: (skillsTarget: string, name: string) => string | undefined;
  /** Copy `<bundledRoot>/<name>` → `<skillsTarget>/<name>` (recursive). */
  seed: (name: string) => void;
  readonly logger?: { info: (obj: Record<string, unknown>, msg: string) => void };
}

/**
 * Decide + seed. Returns the names seeded vs skipped (for logging/tests). PURE over its injected
 * seams; TOTAL within the loop (a single skill's fault should not abort the rest — the production
 * `seed` swallows its own fs faults). Never throws on an empty scan.
 */
export function seedBundledSkills(deps: SeedBundledSkillsDeps): { seeded: string[]; skipped: string[] } {
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const name of deps.listSkillNames(deps.bundledRoot)) {
    const installed = deps.installedVersion(deps.skillsTarget, name);
    const bundled = deps.bundledVersion(deps.bundledRoot, name);
    // Seed when not installed, or the bundled version differs (any change → re-seed; the old
    // skill-creator semantics). A missing bundled version with an install present ⇒ skip (no churn).
    const shouldSeed = installed === undefined || (bundled !== undefined && bundled !== installed);
    if (shouldSeed) {
      deps.seed(name);
      seeded.push(name);
      deps.logger?.info(
        { skill: name, installedVersion: installed ?? "none", bundledVersion: bundled ?? "unknown" },
        "Bundled skill seeded into data directory",
      );
    } else {
      skipped.push(name);
    }
  }
  return { seeded, skipped };
}

/**
 * Read the manifest version from a SKILL.md frontmatter block: `metadata.version`
 * (the spec-pure home), or a top-level `version` as a fallback. Parses the FULL
 * leading frontmatter block — a version that follows a long `description` is
 * still found. Returns undefined when there is no frontmatter block, no version,
 * or the block is not valid YAML (the yaml parser can throw on malformed input).
 */
export function extractVersion(path: string, readFile: (p: string) => string): string | undefined {
  try {
    const block = readFile(path).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!block) return undefined;
    const parsed = parseYaml(block[1]) as Record<string, unknown> | null | undefined;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const meta = parsed["metadata"];
    const nested =
      meta !== null && typeof meta === "object"
        ? (meta as Record<string, unknown>)["version"]
        : undefined;
    const raw = nested ?? parsed["version"];
    if (raw === undefined || raw === null) return undefined;
    const value = String(raw).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wire the production deps: real `node:fs`, `safePath`-confined, best-effort (a faulting copy of one
 * skill is swallowed so it never aborts boot — the in-tree bundled skill is still readable next boot).
 */
export function defaultSeedBundledSkillsDeps(
  bundledRoot: string,
  skillsTarget: string,
  logger?: { info: (obj: Record<string, unknown>, msg: string) => void },
): SeedBundledSkillsDeps {
  return {
    bundledRoot,
    skillsTarget,
    logger,
    listSkillNames: (root) => {
      try {
        return nodeReaddirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter((name) => {
            try {
              return nodeExistsSync(safePath(root, name, "SKILL.md"));
            } catch {
              return false;
            }
          });
      } catch {
        return []; // no bundled-skills dir on this install → nothing to seed
      }
    },
    bundledVersion: (root, name) => {
      try {
        return extractVersion(safePath(root, name, "SKILL.md"), (p) => nodeReadFileSync(p, "utf-8"));
      } catch {
        return undefined;
      }
    },
    installedVersion: (target, name) => {
      try {
        const md = safePath(target, name, "SKILL.md");
        if (!nodeExistsSync(md)) return undefined;
        return extractVersion(md, (p) => nodeReadFileSync(p, "utf-8"));
      } catch {
        return undefined;
      }
    },
    seed: (name) => {
      try {
        nodeMkdirSync(skillsTarget, { recursive: true });
        // fs-safe-allowed: bundled-skill seeding into `<dataDir>/skills/` (recursive copy, outside the substrate — same posture as the former skill-creator IIFE).
        nodeCpSync(safePath(bundledRoot, name), safePath(skillsTarget, name), { recursive: true });
      } catch {
        /* best-effort: a failed seed of one skill must never abort boot */
      }
    },
  };
}
