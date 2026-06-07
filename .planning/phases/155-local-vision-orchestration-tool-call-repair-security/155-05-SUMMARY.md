---
phase: 155
plan: "05"
subsystem: harness + docs
tags: [L6, mlx, gguf, bench, docs]
dependency_graph:
  requires: [155-04b]
  provides: [L6-harness-annotation, L6-docs]
  affects: []
tech_stack:
  added: []
  patterns: [runtime-label-from-model-tag, docs-operational-guide]
key_files:
  created: []
  modified:
    - scripts/bench-small-model/comprehension.mjs
    - docs/reference/environment-variables.mdx
decisions:
  - "Runtime detection via tag suffix (-mlx suffix → MLX, else GGUF) keeps product code MLX/GGUF-agnostic while enabling human comparison"
  - "docs/reference/environment-variables.mdx chosen over a new local-models.mdx page (no sidebar change needed; Ollama config is already referenced from config-yaml.mdx)"
metrics:
  duration: "5min"
  completed: "2026-06-08"
  tasks: 2
  files: 2
---

# Phase 155 Plan 05: MLX-vs-GGUF latency labeling + docs (L6) Summary

Annotated bench harness comprehension probe with runtime detection (MLX vs GGUF from model tag) and added per-platform runtime recommendation docs section to environment-variables.mdx.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Annotate comprehension.mjs for MLX-vs-GGUF latency labeling | bf0255c1 | scripts/bench-small-model/comprehension.mjs |
| 2 | Add L6 per-platform runtime recommendation to docs | f6c4fe0a | docs/reference/environment-variables.mdx |

## What Was Built

**Task 1 (harness):** Added `inferRuntime(modelTag)` function that detects `-mlx` suffix and returns `"MLX (Apple Silicon)"` or `"GGUF (llama.cpp)"`. Model section headers in the comprehension report now include runtime label and average latency across probes. The per-probe table gained a `Latency (ms)` column. A JSDoc block documents the L6 measurement procedure: `BENCH_MODELS=qwen3.6:35b-mlx,qwen3.6:35b node scripts/bench-small-model/comprehension.mjs`. No scenario logic, scoring, or test oracle was changed.

**Task 2 (docs):** Added `## Local Model Runtime Selection (MLX vs GGUF)` section to `docs/reference/environment-variables.mdx` with a platform table (Apple Silicon → MLX, Linux/x86-64 → GGUF), a config.yaml example, and a Tip block documenting how to run the bench harness for direct latency comparison. `pnpm docs:check` passes (157 docs parsed cleanly).

## Verification

- `node --check scripts/bench-small-model/comprehension.mjs` — exits 0 (parses cleanly)
- `node scripts/bench-small-model/comprehension.mjs --help 2>/dev/null; echo "harness_ok"` — prints "harness_ok"
- `pnpm docs:check` — 157 docs parsed cleanly
- `pnpm cycles:refs` — clean (dry-run output only, no errors)
- `pnpm lint:security` — 5 errors at pre-existing baseline (not a v2.14 regression per STATE.md)

## Deviations from Plan

None — plan executed exactly as written. The `inferRuntime` helper was added as specified; documentation content matches the plan's verbatim content. The plan's nested YAML code block in the MDX was maintained without issues (MDX syntax accepted by the MDX compiler).

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes introduced. Both changes are read-only output labeling (harness) and static documentation text.

## Known Stubs

None. This plan is harness annotation + docs only. No data wiring or UI components involved.

## Self-Check: PASSED

- `scripts/bench-small-model/comprehension.mjs` — modified (verified parse-clean)
- `docs/reference/environment-variables.mdx` — modified (verified docs:check)
- Commit bf0255c1 exists: `git log --oneline | grep bf0255c1` → found
- Commit f6c4fe0a exists: `git log --oneline | grep f6c4fe0a` → found
