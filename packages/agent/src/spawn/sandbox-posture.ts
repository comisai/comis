// SPDX-License-Identifier: Apache-2.0
/**
 * Pure sandbox-posture primitive (SANDBOX-01).
 *
 * One tested source of truth for the partial-order confinement semantics used
 * by the sub-agent spawn no-downgrade invariant (P0-C): a spawned child must
 * never be *less* confined than its spawner. This module is the dependency-free
 * foundation — no I/O, no event bus, no full daemon-config import. It is a
 * `@comis/agent` leaf so the daemon wiring can later INJECT a resolver into the
 * sub-agent runner (Plan 02) without inverting the dependency direction.
 *
 * ## The 4 config-derived dimensions (strict → loose)
 * Each dimension's enum labels are the EXACT operator-config strings from
 * `@comis/core` `schema-skills.ts` — never invented here:
 * - **exec** (`ExecSandboxSchema.enabled`, schema-skills.ts:90): `always` (sandbox
 *   wraps the command — MORE confined) > `never` (unsandboxed — LESS confined).
 * - **filesystem** (`TerminalAllowEntrySchema.scope.filesystem`, schema-skills.ts:145):
 *   `workspace` > `listed-paths` > `home` > `full`.
 * - **network** (`...scope.network`, schema-skills.ts:147): `none` > `listed-hosts` > `full`.
 * - **uid** (`...scope.uid`, schema-skills.ts:150): `dedicated` > `daemon`.
 *
 * Higher rank = more confined. A child is a DOWNGRADE (refuse) iff it is strictly
 * LESS confined than the parent on ANY single dimension (a partial order, not a
 * total one): the child can tighten one dimension and loosen another and still be
 * a downgrade.
 *
 * ## Design-vs-config reconciliation (ROADMAP success-criterion 1)
 * The design doc (§5 P0-C) and ROADMAP criterion-1 describe a `broker-only > open`
 * exec-network dimension and a "sandboxed (broker-only) parent → open child"
 * example. **That dimension does NOT exist as operator config.**
 * `broker-only`/`open`/`none` are RUNTIME sandbox network *modes* derived at spawn
 * time (`packages/skills/src/tools/builtin/sandbox/types.ts:36`), not a Zod config
 * field; the config-level exec sandbox is ONLY `enabled: always|never`. The
 * criterion-1 "broker-only parent → open child refused" therefore maps to the real
 * config model as: **a more-confined parent (e.g. exec `always`) spawning a
 * less-confined child (exec `never`) is refused.** We deliberately do NOT model the
 * bogus `broker-only > open` config dimension — it would be unverifiable. If a
 * future "exec network mode" config field is added, the comparator extends
 * additively via a new rank map.
 *
 * ## Missing-field-safe-default (threat T-172-01)
 * A missing/absent field on ANY dimension resolves to the MOST-confined enum
 * (highest rank) BEFORE comparison — a posture is NEVER inferred more permissive
 * than reality, so a config gap cannot silently open a downgrade.
 *
 * @module
 */

/**
 * A resolved sandbox posture across the 4 config-derived confinement dimensions.
 *
 * For the sub-agent spawn path, **exec is the active dimension** today;
 * `filesystem`/`network`/`uid` are present in the type so the comparator composes
 * when the deferred terminal-posture path lands (A1), but they resolve to their
 * most-confined default when absent (see {@link comparePosture}). The sub-agent
 * resolver ({@link resolvePostureFromSkills}) leaves them unset in P0-C scope.
 */
export interface SandboxPosture {
  /** Exec sandbox enablement. `always` = sandbox wraps the command (more confined). */
  exec: "always" | "never";
  /** Filesystem reach. Absent ⇒ `workspace` (strictest). */
  filesystem?: "workspace" | "listed-paths" | "home" | "full";
  /** Network reach. Absent ⇒ `none` (strictest). */
  network?: "none" | "listed-hosts" | "full";
  /** Process uid. Absent ⇒ `dedicated` (strictest). */
  uid?: "dedicated" | "daemon";
}

/** The four confinement dimensions the comparator ranks. */
export type PostureDimension = "exec" | "filesystem" | "network" | "uid";

/** Result of comparing a parent posture against a prospective child posture. */
export interface PostureComparison {
  /** `true` ⇒ the child is LESS confined on ≥1 dimension ⇒ refuse the spawn. */
  isDowngrade: boolean;
  /** The dimension(s) on which the child was strictly less confined (enum labels). */
  violatedDimensions: PostureDimension[];
}

// ---------------------------------------------------------------------------
// Rank maps (strict → loose). Higher rank = MORE confined.
//
// The FIRST key in each map is the most-confined enum, which is also the
// safe default used when a dimension is absent (missing-field-safe-default).
// ---------------------------------------------------------------------------

// `Map` lookups (not object indexing) avoid the `detect-object-injection` sink
// while keeping the key set closed to each dimension's enum literals. The first
// entry in each map is the most-confined enum — also the safe default an absent
// field folds to in rankOf().
const EXEC_RANK = new Map<SandboxPosture["exec"], number>([
  ["always", 1],
  ["never", 0],
]);
const FILESYSTEM_RANK = new Map<
  NonNullable<SandboxPosture["filesystem"]>,
  number
>([
  ["workspace", 3],
  ["listed-paths", 2],
  ["home", 1],
  ["full", 0],
]);
const NETWORK_RANK = new Map<NonNullable<SandboxPosture["network"]>, number>([
  ["none", 2],
  ["listed-hosts", 1],
  ["full", 0],
]);
const UID_RANK = new Map<NonNullable<SandboxPosture["uid"]>, number>([
  ["dedicated", 1],
  ["daemon", 0],
]);

const DIMENSIONS: readonly PostureDimension[] = [
  "exec",
  "filesystem",
  "network",
  "uid",
];

// Most-confined rank per dimension — the value an absent field folds to BEFORE
// ranking AND the fail-closed fallback for a present-but-unknown enum value. The
// pre-map `?? <most-confined>` already guarantees a valid key for the only field
// the validated config path can leave undefined, so the trailing `?? MOST_CONFINED`
// is defensive: it only fires if a caller hand-builds a SandboxPosture with an
// out-of-union value, bypassing Zod (schema-skills.ts enums). When it does fire it
// must rank MOST-confined (not 0 = least), so an unexpected value fails CLOSED — a
// child carrying it looks confined/safe; a parent carrying it makes a looser child
// a downgrade — never the reverse.
const EXEC_MOST_CONFINED = 1; // "always"
const FILESYSTEM_MOST_CONFINED = 3; // "workspace"
const NETWORK_MOST_CONFINED = 2; // "none"
const UID_MOST_CONFINED = 1; // "dedicated"

/**
 * Rank a single dimension of a posture, folding an absent field to the
 * most-confined value (highest rank) BEFORE ranking. This is the load-bearing
 * safe default (T-172-01): a missing field is never read as more permissive than
 * reality. The pre-map `?? <most-confined>` IS the safe default for an absent
 * field; the trailing `?? <most-confined>` is the fail-closed fallback for a
 * present-but-unknown enum value (unreachable via the Zod-validated config path,
 * but if a caller hand-builds a posture it must still fail CLOSED — IN-01).
 */
function rankOf(posture: SandboxPosture, dimension: PostureDimension): number {
  switch (dimension) {
    case "exec":
      return EXEC_RANK.get(posture.exec) ?? EXEC_MOST_CONFINED;
    case "filesystem":
      return (
        FILESYSTEM_RANK.get(posture.filesystem ?? "workspace") ??
        FILESYSTEM_MOST_CONFINED
      );
    case "network":
      return (
        NETWORK_RANK.get(posture.network ?? "none") ?? NETWORK_MOST_CONFINED
      );
    case "uid":
      return UID_RANK.get(posture.uid ?? "dedicated") ?? UID_MOST_CONFINED;
    default: {
      const _exhaustive: never = dimension;
      return _exhaustive;
    }
  }
}

/**
 * Compare a parent posture against a prospective child posture.
 *
 * Returns {@link PostureComparison.isDowngrade} = `true` (and the violating
 * dimension names) iff the child is strictly LESS confined than the parent on
 * ANY single dimension. Equal posture and a more-confined (upgrade) child both
 * compare as allowed. Absent fields on either side fold to the most-confined
 * value before comparison (T-172-01).
 *
 * Pure: no I/O, no config import, deterministic for a given input pair.
 */
export function comparePosture(
  parent: SandboxPosture,
  child: SandboxPosture,
): PostureComparison {
  const violatedDimensions: PostureDimension[] = [];

  for (const dimension of DIMENSIONS) {
    const parentRank = rankOf(parent, dimension);
    const childRank = rankOf(child, dimension);
    // Lower child rank = less confined than the parent on this dimension = downgrade.
    if (childRank < parentRank) {
      violatedDimensions.push(dimension);
    }
  }

  return {
    isDowngrade: violatedDimensions.length > 0,
    violatedDimensions,
  };
}

/**
 * The minimal structural slice of an agent's skills config this resolver reads.
 *
 * Declared inline (NOT imported from the full daemon config) so this module
 * stays a `@comis/agent` leaf: Plan 02's daemon wiring injects a resolver closure
 * built over the per-agent skills config it holds, which structurally satisfies
 * this shape. Only `execSandbox.enabled` is consumed in P0-C scope.
 */
export interface SkillsPostureSlice {
  execSandbox?: {
    enabled?: "always" | "never";
  };
}

/**
 * Fold an agent's skills config slice into a {@link SandboxPosture}.
 *
 * P0-C scope (A1): only the **exec** dimension is populated, from
 * `skills.execSandbox.enabled`. An absent slice or absent `enabled` resolves to
 * `"always"` — the most-confined default, matching the schema default
 * (`ExecSandboxSchema.enabled.default("always")`). The `filesystem`/`network`/`uid`
 * dimensions are deliberately left UNSET: they are reserved for the future
 * terminal-posture wiring (the deferred terminal-driver path) and fold to their
 * most-confined value in {@link comparePosture}, so the comparator treats this
 * resolver's output as fully confined on the inert dimensions.
 *
 * Pure: no I/O, no config import beyond the structural {@link SkillsPostureSlice}.
 */
export function resolvePostureFromSkills(
  skills: SkillsPostureSlice | undefined,
): SandboxPosture {
  return {
    exec: skills?.execSandbox?.enabled ?? "always",
    // filesystem / network / uid intentionally unset (present-but-inert, A1).
  };
}
