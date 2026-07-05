// SPDX-License-Identifier: Apache-2.0
/**
 * Real-shape SKILL.md fixtures for the foreign-frontmatter mapper.
 *
 * Each fixture is a faithful sample of a manifest shape the mapper must
 * converge onto the spec-pure form: a spec-conforming manifest whose metadata
 * carries a non-string value; a sibling `metadata.openclaw` extension
 * namespace; another ecosystem's top-level `platforms:` block with a nested
 * community-hub metadata dict and an executable entrypoint; a nested-object
 * metadata value; and a display-form `name` that must normalize to a valid
 * manifest slug.
 *
 * Every one of these is REJECTED by the strict internal schema when fed
 * straight through the parser — that is exactly why the mapper exists. The
 * field SHAPES are drawn from real ecosystems; no ecosystem PROJECT name
 * appears here (the `metadata.openclaw` key is a real API identifier, kept as
 * such; the mechanism is what the tests name).
 *
 * @module
 */

/**
 * (a) A spec-conforming manifest that authors `allowed-tools` as a
 * space-separated string, `compatibility` as prose, and a `metadata` map that
 * (as real specs allow) carries a NON-string value (`api_version: 2`). The
 * strict `metadata: record(string, string)` rejects the raw form; the mapper
 * flattens the scalar and hands off a valid manifest.
 */
export const FIXTURE_A_SPEC_CONFORMING = `---
name: pdf-extractor
description: Extracts text and tables from PDF documents into structured output.
allowed-tools: Read Write Bash
compatibility: Runs on Linux and macOS; requires the poppler command-line tools.
metadata:
  category: document-processing
  api_version: 2
---
Extract structured text and tables from the supplied PDF.
`;

/**
 * (b) A manifest carrying a sibling extension namespace under
 * `metadata.openclaw` (a real API identifier). Its `skillKey`/`primaryEnv`/
 * `os`/`requires.bins`/`requires.env` fold into the internal `comis` block;
 * its `requires.anyBins`/`requires.config`, the checksum-less binary-installer
 * `install[]`, and `always`/`emoji`/`homepage` have no internal semantics and
 * must each drop with a warning naming the key.
 */
export const FIXTURE_B_SIBLING_NAMESPACE = `---
name: repo-inspector
description: Inspects a git repository and summarizes its structure and health.
metadata:
  openclaw:
    skillKey: repo-inspector
    primaryEnv: cli
    os:
      - linux
      - darwin
    requires:
      bins:
        - git
        - jq
      env:
        - GITHUB_TOKEN
      anyBins:
        - rg
        - ag
      config:
        - inspector.defaults
    install:
      - type: brew
        name: git
    always: false
    emoji: "MAG"
    homepage: "https://example.invalid/repo-inspector"
---
Inspect the repository and report on its structure and health.
`;

/**
 * (c) Another ecosystem's manifest: a top-level `platforms:` list, a top-level
 * `version`/`author`, a nested community-hub metadata dict (tags/category/
 * related_skills/requires_toolsets/blueprint — none with internal semantics),
 * and an executable `entrypoint`. It must import PROMPT-ONLY: platforms fold
 * into `comis.os`, version/author become metadata strings, the nested dict
 * drops-with-warning, and the executable entrypoint drops-with-warning and is
 * NEVER mapped.
 */
export const FIXTURE_C_OTHER_HUB_WITH_ENTRYPOINT = `---
name: sentiment-scan
description: Scores the sentiment of a block of text and returns a single label.
platforms:
  - linux
  - macos
version: 0.3.1
author: Data Tools Collective
entrypoint: run.py
metadata:
  superhub:
    tags:
      - nlp
      - text
    category: analysis
    related_skills:
      - tokenizer
    requires_toolsets:
      - nltk
    blueprint: "0 9 * * *"
---
Score the sentiment of the provided text and return a single label.
`;

/**
 * (d) A manifest whose `metadata` map holds a NESTED-object value (`config`).
 * The strict string-to-string metadata rejects it outright; the mapper must
 * drop the nested value with a warning naming the key (never crash) while
 * keeping the sibling string entry.
 */
export const FIXTURE_D_NESTED_METADATA_VALUE = `---
name: cache-warmer
description: Periodically pre-warms an application cache to reduce cold starts.
metadata:
  category: performance
  config:
    ttl: 3600
    strategy: lru
---
Pre-warm the configured cache entries on the given schedule.
`;

/**
 * (e) A manifest whose authored `name` is a display-form string (mixed case,
 * spaces) — the shape you get when the on-disk directory differs from a
 * canonical slug. The strict `SkillNameSchema` rejects it raw; the mapper
 * normalizes it to a valid manifest slug (naming the change) so the manifest
 * name is authoritative and independent of any install directory.
 */
export const FIXTURE_E_DISPLAY_NAME = `---
name: Log Analyzer
description: Parses server log files and summarizes error rates over time.
---
Parse the supplied log files and summarize error rates over the window.
`;

/** All five fixtures, keyed for iteration in the "raw is rejected" gate. */
export const FOREIGN_FIXTURES = {
  specConforming: FIXTURE_A_SPEC_CONFORMING,
  siblingNamespace: FIXTURE_B_SIBLING_NAMESPACE,
  otherHubWithEntrypoint: FIXTURE_C_OTHER_HUB_WITH_ENTRYPOINT,
  nestedMetadataValue: FIXTURE_D_NESTED_METADATA_VALUE,
  displayName: FIXTURE_E_DISPLAY_NAME,
} as const;
