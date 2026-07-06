// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-private skill-provenance store + the shared keyed import mutex.
 *
 * This is the durable substrate the trust tier hangs on. `<dataDir>/skills` is
 * the SAME directory bundled (platform-trusted) skills seed into, so provenance
 * is the ONLY durable discriminator between an imported skill and a seeded one.
 * A record marks a skill imported — ADVISORY DOWNWARD ONLY: its presence can
 * demote a skill to the imported tier, but its ABSENCE never elevates a skill
 * (an unmatched skill keeps its path-derived source). The store is content-free
 * by construction — ids, hashes, counts, and relative paths only, never a skill
 * body.
 *
 * File: `<dataDir>/skill-provenance.json`, mode 0o600 (owner-only), keyed
 * `<scope>:<agentId|shared>:<name>`. The read is fail-safe (a missing or corrupt
 * file — or an individual malformed record — never throws and never blocks
 * boot). Every write runs the record through `parseProvenanceRecord` and a
 * write-time install-path escape check before persisting, then writes the WHOLE
 * file via the symlink-safe substrate (`writeRegularFile`, 0o600).
 *
 * Concurrency: the store is a single shared file, and provenance is persisted as
 * the final step of an ASYNC import commit (which reads the store, performs
 * async install work, then writes). Atomic rename alone does not stop a
 * read-modify-write lost update between two concurrent importers, so every
 * mutation MUST run inside `withSkillImportLock` — a MODULE-LEVEL SINGLETON keyed
 * mutex. A constant key acts as a global lock (the import commit serializes its
 * MCP-persist critical section on one). Same key runs strictly sequentially;
 * different keys run free.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ok, err, type Result } from "@comis/shared";
import { safePath, type ErrorKind } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import { SkillNameSchema } from "../manifest/schema.js";

const STORE_FILE_NAME = "skill-provenance.json";

// ---------------------------------------------------------------------------
// Record shape (z.strictObject + parseX helper, per the domain-type convention)
// ---------------------------------------------------------------------------

/**
 * The acquisition CHANNEL a skill was imported from — distinct from the
 * trust-tier `SkillSource`. Kept a separate enum on purpose: this names HOW the
 * bytes arrived; the trust tier (`imported`) is stamped elsewhere from a match
 * against this store.
 */
export const ACQUISITION_SOURCES = ["github", "archive", "wellknown", "clawhub", "upload"] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

/** Content-free scan outcome: a verdict + a finding COUNT, never matched text. */
const ScanVerdictSchema = z.strictObject({
  clean: z.boolean(),
  findingCount: z.number().int().nonnegative(),
});

/**
 * A durable provenance record. `contentHash` + `files` are computed over the
 * canonicalized INSTALLED set (see {@link computeInstalledSetHash}) so the pin
 * stays re-verifiable against disk. `identifier` is the source URL, or
 * `upload:sha256:<hash>` for an upload with no stable upstream identity.
 */
export const ProvenanceRecordSchema = z.strictObject({
  /**
   * Installed skill name (also the LAST segment of the `<scope>:<owner>:<name>`
   * store key). Constrained to the manifest slug rule so a ':' — or any other
   * key-splitting / separator char — can never forge or overlap a store key.
   */
  name: SkillNameSchema,
  /** Skill scope — mirrors the RPC scope enum. */
  scope: z.enum(["local", "shared"]),
  /** Owning agent id (the `shared` owner sentinel is applied when keying). */
  agentId: z.string().min(1),
  /** How the bytes arrived (acquisition channel, NOT the trust tier). */
  source: z.enum(ACQUISITION_SOURCES),
  /** Source URL, or `upload:sha256:<hash>` for uploads. */
  identifier: z.string().min(1),
  /** sha256 over the canonicalized installed file set. */
  contentHash: z.string().min(1),
  /** Content-free stage-time scan verdict. */
  scanVerdict: ScanVerdictSchema,
  /** Relative paths of the installed files (paths only — never bodies). */
  files: z.array(z.string()),
  /** ISO-8601 first-import timestamp. */
  importedAt: z.string().min(1),
  /** ISO-8601 last-update timestamp. */
  updatedAt: z.string().min(1),
  /** The actor (agent id) that performed the import. */
  importedBy: z.string().min(1),
  /** Whether the source registry vouched for an official publisher. */
  officialPublisher: z.boolean().optional(),
  /** Whether a local edit has diverged from the imported pin. */
  locallyModified: z.boolean().optional(),
});

/** A validated provenance record. */
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

/** The whole store: key (`<scope>:<agentId|shared>:<name>`) -> record. */
export type ProvenanceStore = Record<string, ProvenanceRecord>;

/**
 * Parse an unknown value into a {@link ProvenanceRecord}. Call sites use this —
 * never `.parse()` (throws) or a raw `.safeParse()`.
 */
export function parseProvenanceRecord(raw: unknown): Result<ProvenanceRecord, z.ZodError> {
  const result = ProvenanceRecordSchema.safeParse(raw);
  return result.success ? ok(result.data) : err(result.error);
}

// ---------------------------------------------------------------------------
// Typed reject
// ---------------------------------------------------------------------------

/** A typed store-write reject carrying an operator hint + a closed-union kind. */
export interface ProvenanceError {
  readonly message: string;
  readonly hint: string;
  readonly errorKind: ErrorKind;
}

function mkErr(errorKind: ErrorKind, message: string, hint: string): ProvenanceError {
  return { errorKind, message, hint };
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Build the store key `<scope>:<agentId|shared>:<name>`. A shared skill keys on
 * the `shared` owner sentinel (its owning agent is irrelevant); a local skill
 * keys on its owning agent id.
 */
export function provenanceKey(scope: "local" | "shared", agentId: string, name: string): string {
  const owner = scope === "shared" ? "shared" : agentId;
  return `${scope}:${owner}:${name}`;
}

// ---------------------------------------------------------------------------
// Fail-safe read
// ---------------------------------------------------------------------------

/**
 * Parse the raw store JSON into validated records. Fail-safe at BOTH levels: a
 * non-object top level yields `{}`, and an individual malformed record is
 * skipped (advisory downward — a corrupt record simply fails to mark its skill
 * imported; it never elevates one). `__proto__` keys are never copied.
 */
function coerceStore(raw: string): ProvenanceStore {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: ProvenanceStore = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "__proto__") continue;
    const record = parseProvenanceRecord(value);
    if (record.ok) store[key] = record.value;
  }
  return store;
}

/**
 * Read the provenance store. A missing file, malformed JSON, or unreadable file
 * returns an EMPTY store (`{}`) — never throws, never blocks boot.
 *
 * @param dataDir Absolute path to the Comis data directory.
 */
export function readProvenanceStore(dataDir: string): ProvenanceStore {
  const filePath = safePath(dataDir, STORE_FILE_NAME);
  if (!existsSync(filePath)) return {};
  try {
    return coerceStore(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Write-time validation + atomic whole-file write
// ---------------------------------------------------------------------------

/**
 * Reject a record name that would escape the skills directory (the poisoned-lock
 * lesson). The name must be a single contained path segment; separators, dot
 * segments, absolute forms, null bytes, and URL-encoded escapes are refused.
 */
function assertSafeInstallName(dataDir: string, name: string): Result<void, ProvenanceError> {
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes(":") ||
    name.includes("\0") ||
    name === "." ||
    name === ".."
  ) {
    return err(
      mkErr(
        "validation",
        `provenance record name '${name}' would escape the skills directory or split its store key`,
        "The record name must be a single path segment — no separators (including ':', the store-key delimiter), dot-segments, or absolute forms.",
      ),
    );
  }
  try {
    const skillsRoot = safePath(dataDir, "skills");
    safePath(skillsRoot, name);
  } catch {
    return err(
      mkErr(
        "validation",
        `provenance record name '${name}' would escape the skills directory`,
        "The record name must resolve to a contained skill directory under the data dir.",
      ),
    );
  }
  return ok(undefined);
}

/** Write the whole store atomically: 0o700 dir, then 0o600 symlink-safe file. */
function writeWholeStore(dataDir: string, store: ProvenanceStore): Result<void, ProvenanceError> {
  const dirResult = ensureContainedDir({ dir: dataDir, mode: 0o700 });
  if (!dirResult.ok) {
    return err(
      mkErr(
        "resource",
        `failed to ensure data dir ${dataDir}: ${dirResult.error.message}`,
        "Ensure the Comis data directory exists and is owner-private (0o700).",
      ),
    );
  }
  const filePath = safePath(dataDir, STORE_FILE_NAME);
  const writeResult = writeRegularFile({
    path: filePath,
    content: JSON.stringify(store, null, 2),
  });
  if (!writeResult.ok) {
    return err(
      mkErr(
        "resource",
        `failed to write ${filePath}: ${writeResult.error.message}`,
        "Ensure the provenance store path is writable and not a symlink.",
      ),
    );
  }
  return ok(undefined);
}

/**
 * Persist one provenance record (insert or update), preserving every other
 * record. Validates the record and its install path FIRST; a malformed or
 * escaping record is rejected with `errorKind: "validation"` and NOTHING is
 * written.
 *
 * Async by contract: provenance is persisted as the final step of an async
 * import commit, so the read-merge-write straddles the event loop. Callers MUST
 * hold {@link withSkillImportLock} — the store is a single shared file and two
 * concurrent unlocked writers lose a record.
 */
export async function writeProvenanceRecord(
  dataDir: string,
  record: ProvenanceRecord,
): Promise<Result<void, ProvenanceError>> {
  const parsed = parseProvenanceRecord(record);
  if (!parsed.ok) {
    const firstIssue = parsed.error.issues[0];
    const where = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "unknown field";
    return err(
      mkErr(
        "validation",
        `provenance record failed validation (${where})`,
        "Provide a well-formed provenance record; the store never persists an unvalidated record.",
      ),
    );
  }
  const valid = parsed.value;

  const contained = assertSafeInstallName(dataDir, valid.name);
  if (!contained.ok) return contained;

  // Read the merge base, then yield across the async-commit boundary before the
  // write — this is exactly why the caller must hold the lock.
  const store = readProvenanceStore(dataDir);
  await Promise.resolve();

  const key = provenanceKey(valid.scope, valid.agentId, valid.name);
  const next: ProvenanceStore = { ...store, [key]: valid };
  return writeWholeStore(dataDir, next);
}

/**
 * Remove exactly one record, preserving the rest. Idempotent for an absent key.
 * Async + lock-guarded for the same reason as {@link writeProvenanceRecord}.
 */
export async function removeProvenanceRecord(
  dataDir: string,
  key: string,
): Promise<Result<void, ProvenanceError>> {
  const store = readProvenanceStore(dataDir);
  await Promise.resolve();
  if (!(key in store)) return ok(undefined);

  const next: ProvenanceStore = {};
  for (const [existingKey, record] of Object.entries(store)) {
    if (existingKey === key || existingKey === "__proto__") continue;
    next[existingKey] = record;
  }
  return writeWholeStore(dataDir, next);
}

// ---------------------------------------------------------------------------
// Installed-set content hash
// ---------------------------------------------------------------------------

/**
 * Deterministic sha256 over the canonicalized installed file set: sorted by
 * relative path, then `${relPath}\n${bytes.toString("base64")}` joined. Stable
 * across input ordering so the pin re-verifies against disk regardless of the
 * order files were unpacked.
 */
export function computeInstalledSetHash(
  files: ReadonlyArray<{ relPath: string; bytes: Buffer }>,
): string {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const joined = sorted.map((f) => `${f.relPath}\n${f.bytes.toString("base64")}`).join("\n");
  return createHash("sha256").update(joined).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared keyed import mutex (MODULE-LEVEL SINGLETON)
// ---------------------------------------------------------------------------

/**
 * The ONE keyed-mutex chain-map for the whole process. Module-scoped and never
 * re-instantiated, so the daemon import commit and every provenance write share
 * a single lock instance — a second instance would split the domain and void
 * the concurrency guarantee.
 */
const importLocks = new Map<string, Promise<unknown>>();

/**
 * The constant key the import commit serializes its MCP-persist critical section
 * on. Used as a global lock: all work routed through this key runs strictly
 * sequentially process-wide.
 */
export const SKILL_IMPORT_COMMIT_LOCK = "skill-import:commit";

/**
 * Run `fn` under a per-`key` async mutex. Same-key invocations run strictly
 * sequentially (tail-to-tail chaining); different keys run concurrently. A
 * rejected `fn` does not poison the chain — the next waiter still runs.
 */
export async function withSkillImportLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = importLocks.get(key) ?? Promise.resolve();
  // `prior` is always a resolving promise (a settled-swallowing tail or the seed
  // resolve), so a single onFulfilled arm suffices — fn runs once the prior
  // holder has finished, whatever its outcome.
  const result = prior.then(() => fn());
  // The stored tail swallows the outcome so a later same-key waiter only observes
  // "prior done" — a rejected fn never poisons the chain.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  importLocks.set(key, tail);
  try {
    return await result;
  } finally {
    // Drop the key only if no newer waiter replaced our tail (bounds the map).
    if (importLocks.get(key) === tail) {
      importLocks.delete(key);
    }
  }
}
