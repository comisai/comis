// SPDX-License-Identifier: Apache-2.0
/**
 * Fixture well-known skill-index shapes and their advertised files.
 *
 * A registry publishes a `/.well-known/skills/index.json` describing the skills
 * it offers: an array of `{ name, description, files? }` entries, where `files`
 * lists the skill-root-relative paths (the manifest is `SKILL.md`) a resolver
 * fetches to reconstruct each skill. These consts are the off-network inputs a
 * resolver and its wiring are exercised against — the index is never fetched
 * from a live host in a test.
 *
 * The shapes deliberately span every case a resolver must handle:
 *   - a well-formed index plus its files (the happy path);
 *   - an index advertising a path that escapes the skill root (a `..` segment,
 *     an absolute path, a backslash) — one unsafe path rejects the WHOLE
 *     bundle, so it is validated before any file is fetched;
 *   - a drifted index (the required `skills` array missing, or the wrong type)
 *     — a resolver fails loud rather than importing wrong bytes;
 *   - an index carrying unknown additive fields (top-level and per-skill) — a
 *     published index may grow fields a resolver has never seen, so extras are
 *     tolerated while the required shape is enforced;
 *   - a file set whose skill omits the required `SKILL.md` manifest;
 *   - a second, byte-different variant of a skill's files (a re-fetch whose
 *     content changed since the pinned import).
 *
 * File maps are keyed `"<skill-name>/<rel-path>"` so a resolver test can look
 * each advertised file up per skill. A valid `SKILL.md` is a spec-pure
 * frontmatter block (only `name` + `description`) wrapping a short prose body.
 *
 * @module
 */

/** One advertised skill in a well-known index. */
export interface WellKnownIndexSkillFixture {
  readonly name: string;
  readonly description: string;
  readonly files?: readonly string[];
}

/** A well-formed well-known index. */
export interface WellKnownIndexFixture {
  readonly skills: readonly WellKnownIndexSkillFixture[];
}

/**
 * A well-formed index advertising two skills — the first with a manifest and a
 * reference file, the second manifest-only. Each `name` resolves against
 * `FIXTURE_VALID_FILES`.
 */
export const FIXTURE_VALID_INDEX: WellKnownIndexFixture = {
  skills: [
    {
      name: "pdf-extractor",
      description: "Extracts text and tables from PDF documents into structured output.",
      files: ["SKILL.md", "references/notes.md"],
    },
    {
      name: "csv-summarizer",
      description: "Summarizes tabular CSV data into a short natural-language digest.",
      files: ["SKILL.md"],
    },
  ],
};

/**
 * The advertised files for `FIXTURE_VALID_INDEX`, keyed `"<name>/<rel-path>"`.
 * Each `SKILL.md` is spec-pure (only `name` + `description` frontmatter) so it
 * parses without the frontmatter mapper; the reference file is arbitrary prose.
 */
export const FIXTURE_VALID_FILES: Record<string, string> = {
  "pdf-extractor/SKILL.md": `---
name: pdf-extractor
description: Extracts text and tables from PDF documents into structured output.
---
Extract structured text and tables from the supplied PDF.
`,
  "pdf-extractor/references/notes.md": `# Extraction notes

Prefer the embedded text layer; fall back to OCR only when a page has none.
`,
  "csv-summarizer/SKILL.md": `---
name: csv-summarizer
description: Summarizes tabular CSV data into a short natural-language digest.
---
Summarize the supplied CSV into a short digest of its columns and row count.
`,
};

/**
 * An index whose single skill advertises a manifest plus three unsafe paths: a
 * parent-directory escape, an absolute path, and a backslash path. A resolver
 * validates every advertised path before fetching, and one unsafe entry
 * rejects the whole bundle.
 */
export const FIXTURE_PATH_ESCAPE_INDEX: WellKnownIndexFixture = {
  skills: [
    {
      name: "path-escape",
      description: "Advertises a file path that escapes the skill root; the whole bundle must reject.",
      files: ["SKILL.md", "../../etc/passwd", "/abs/x", "a\\b"],
    },
  ],
};

/**
 * A drifted index missing the required `skills` array (it publishes `items`
 * instead). A resolver fails loud rather than treating it as an empty index.
 */
export const FIXTURE_SHAPE_DRIFT_INDEX = {
  items: [
    {
      name: "pdf-extractor",
      description: "Extracts text and tables from PDF documents into structured output.",
    },
  ],
};

/**
 * A drifted index whose `skills` is the wrong type (a string, not an array). A
 * resolver fails loud on the type mismatch.
 */
export const FIXTURE_SHAPE_DRIFT_WRONG_TYPE_INDEX = {
  skills: "pdf-extractor, csv-summarizer",
};

/**
 * A well-formed index carrying unknown additive fields — an extra top-level key
 * AND an extra per-skill key. A resolver tolerates both (a published index may
 * grow fields), validating only the required shape.
 */
export const FIXTURE_ADDITIVE_FIELD_INDEX = {
  etag: "opaque-registry-tag",
  skills: [
    {
      name: "pdf-extractor",
      description: "Extracts text and tables from PDF documents into structured output.",
      files: ["SKILL.md"],
      downloads: 4211,
    },
  ],
};

/**
 * An advertised file set whose skill has NO `SKILL.md` — only a reference file.
 * A resolver requires a manifest and rejects this set.
 */
export const FIXTURE_MISSING_SKILLMD_FILES: Record<string, string> = {
  "no-manifest/references/notes.md": `# Orphan reference

This entry advertised files but no SKILL.md manifest.
`,
};

/**
 * A second, byte-different variant of `pdf-extractor`'s files: the same
 * manifest `name`/`description` (so it maps to the same installed skill and the
 * same import identifier) but a changed body and reference file. Drives the
 * re-import path where re-fetched content diverges from the pinned hash.
 */
export const FIXTURE_CHANGED_BYTES_FILES: Record<string, string> = {
  "pdf-extractor/SKILL.md": `---
name: pdf-extractor
description: Extracts text and tables from PDF documents into structured output.
---
Extract structured text and tables from the supplied PDF, including rotated pages.
`,
  "pdf-extractor/references/notes.md": `# Extraction notes (revised)

Handle rotated pages before falling back to OCR.
`,
};
