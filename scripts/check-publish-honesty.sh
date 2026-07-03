#!/usr/bin/env bash
#
# Comis Publish-Honesty Gate (binding constraint #8).
#
# Enforces the trim contract in benchmarks/CLAIMS.md mechanically:
#   1. The PUBLISHED memory surfaces must contain NO superiority claim
#      ("the only (agent) memory", "no other memory", outperforms, etc.),
#      NO deferred capability published as shipped (FORGET / per-type decay /
#      usefulness-aware eviction / FadeMem / weights-adapt online tuning /
#      dialectic / memory_ask / theory-of-mind), and NO placeholder benchmark
#      number (__%, __x, TODO, FIXME, "placeholder <number>").
#   2. Every committed-manifest path cited in benchmarks/CLAIMS.md must resolve
#      on disk (the "no orphan claim" rule).
#
# Mirrors scripts/docs-grep-checks.sh: `set -u` (NOT -e), check_no_match /
# check_grep_min_count helpers, PASS/FAIL/TOTAL counters, a --self-test mode,
# and the `[ "$FAIL" -eq 0 ] && exit 0 || exit 1` footer.
#
# GREP HYGIENE (load-bearing): this gate scopes every content grep to an
# explicit PUBLISHED_SURFACES allow-list. It NEVER greps itself (the forbidden
# tokens are named in this header) and NEVER greps benchmarks/CLAIMS.md (whose
# CUT table legitimately names the cut claims). Missing surfaces SKIP — so while
# memory.astro / the launch post do not yet exist, the gate still exits 0.
#
# Usage:
#   bash scripts/check-publish-honesty.sh              Run the gate; exit 0 on PASS
#   bash scripts/check-publish-honesty.sh --strict     Also FAIL on missing
#                                                       structural presence
#   bash scripts/check-publish-honesty.sh --self-test  Parse + planted-violation
#                                                       proof; exit 0 on success
#
set -u   # fail on undefined var; do NOT use -e (we want every check to run)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAIMS_FILE="$REPO_ROOT/benchmarks/CLAIMS.md"
PASS=0
FAIL=0
TOTAL=0
STRICT=0

# Colors (mirrors scripts/docs-grep-checks.sh:21-25).
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
NC=$'\033[0m'

# --- The published surfaces (the ONLY files this gate greps) --------------
# Today only README.md + the methodology page exist; memory.astro + the
# launch blog post are not yet written. check_no_match SKIPs the missing
# ones, so the gate exits 0 today. NEVER add benchmarks/CLAIMS.md here —
# its CUT table legitimately names the cut tokens.
PUBLISHED_SURFACES=(
  "$REPO_ROOT/README.md"
  "$REPO_ROOT/docs/agents/memory-benchmarks.mdx"
  "$REPO_ROOT/website/src/pages/memory.astro"
)
# The launch blog post has no fixed slug yet — match any memory/benchmark post.
# A glob that expands to nothing stays literal; the existence test below drops it.
for _bp in "$REPO_ROOT"/website/src/pages/blog/*memory*.astro \
           "$REPO_ROOT"/website/src/pages/blog/*benchmark*.astro; do
  [ -e "$_bp" ] && PUBLISHED_SURFACES+=("$_bp")
done

# --- Forbidden patterns (case-insensitive grep -iE) -----------------------
# Each entry is "label::regex". The regexes are NARROWLY scoped so they catch
# the draft overclaims WITHOUT flagging legitimate prose on the live surfaces:
#   - "the only" is scoped to the memory-comparative sense, so README's
#     "the only reachable egress" (credential broker) does NOT trip it.
#   - "placeholder" is the __%/__x/TODO/FIXME markers + "placeholder <number>",
#     NOT the bare word, so README's "placeholder key" and the methodology
#     page's env-var "(placeholder, e.g. <provider>)" rows do NOT trip it.
#   - "lifecycle"/"forgetting" are scoped to the FORGET capability sense.
FORBIDDEN=(
  # --- Superiority / "beats X" (binding constraint #8) ---
  "superiority:beats::\\bbeats\\b"
  "superiority:outperform::\\boutperform"
  "superiority:superior::\\bsuperior\\b"
  "superiority:#1::\\b#1\\b"
  "superiority:best-memory::best (agent )?memory\\b"
  "superiority:the-only-memory::the only ([a-z]+ )?memory"
  "superiority:the-only-X-memory::the only .{0,30}(agent )?memory"
  "superiority:no-other-memory::no other ([a-z]+ )?memory"
  # --- FORGET-as-shipped (deferred capability) ---
  "forget:forgetting::\\bforgetting\\b"
  "forget:per-type-decay::per-type (decay|forgetting)"
  "forget:usefulness-eviction::usefulness-aware (eviction|lifecycle)"
  "forget:fademem::\\bFadeMem\\b"
  "forget:lifecycle::(per-type|usefulness|memory|forget[a-z]*) ?(-|–)? ?lifecycle"
  "forget:lifecycle2::lifecycle .{0,20}(forget|decay|evict)"
  # --- Other deferred capabilities ---
  "deferred:weights-adapt::weights adapt"
  "deferred:online-tuning::online (weight )?tuning"
  "deferred:dialectic::\\bdialectic\\b"
  "deferred:memory_ask::memory_ask"
  "deferred:theory-of-mind::theory.?of.?mind"
  # --- Placeholder benchmark numbers ---
  "placeholder:pct::__%"
  "placeholder:times::__×"
  "placeholder:x::__x"
  "placeholder:todo::\\bTODO\\b"
  "placeholder:fixme::\\bFIXME\\b"
  "placeholder:qualified::placeholder (number|benchmark|result|stat|metric|score|[0-9])"
  # --- Stale reproduction command ---
  "stale-repro:filter-cmd::--filter @comis/agent bench:memory"
)

# --- Helpers --------------------------------------------------------------

# check_no_match <description> <pattern> <file>
# Asserts the (case-insensitive) pattern does NOT appear. Missing file SKIPs.
check_no_match() {
  local desc="$1" pattern="$2" file="$3"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$file" ]; then
    echo "  ${YELLOW}SKIP${NC}: $desc (surface not written yet: ${file#"$REPO_ROOT"/})"
    return
  fi
  if grep -qiE -e "$pattern" -- "$file" 2>/dev/null; then
    echo "  ${RED}FAIL${NC}: $desc (forbidden '$pattern' present) -- ${file#"$REPO_ROOT"/}"
    FAIL=$((FAIL + 1))
  else
    echo "  ${GREEN}PASS${NC}: $desc (absent as expected) -- ${file#"$REPO_ROOT"/}"
    PASS=$((PASS + 1))
  fi
}

# check_grep_min_count <description> <pattern> <file> <expected_min>
# Structural presence. Missing/short file SKIPs by default; FAILs under --strict.
check_grep_min_count() {
  local desc="$1" pattern="$2" file="$3" expected="$4"
  TOTAL=$((TOTAL + 1))
  local actual=0
  if [ -f "$file" ]; then
    actual=$(grep -cE -e "$pattern" -- "$file" 2>/dev/null) || actual=0
  fi
  if [ "$actual" -ge "$expected" ]; then
    echo "  ${GREEN}PASS${NC}: $desc (got $actual, expected >= $expected)"
    PASS=$((PASS + 1))
  elif [ "$STRICT" -eq 1 ]; then
    echo "  ${RED}FAIL${NC}: $desc (got $actual, expected >= $expected) -- ${file#"$REPO_ROOT"/}"
    FAIL=$((FAIL + 1))
  else
    echo "  ${YELLOW}SKIP${NC}: $desc (got $actual, expected >= $expected; advisory until --strict) -- ${file#"$REPO_ROOT"/}"
  fi
}

# check_no_orphan_manifest — every committed-manifest path token cited in
# benchmarks/CLAIMS.md must resolve on disk (no-orphan-claim rule).
# Robust to prose: strips trailing dots and skips the bare prefix / ellipsis.
check_no_orphan_manifest() {
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$CLAIMS_FILE" ]; then
    echo "  ${RED}FAIL${NC}: no-orphan-manifest (benchmarks/CLAIMS.md not found)"
    FAIL=$((FAIL + 1))
    return
  fi
  local orphans=0 p clean
  while IFS= read -r p; do
    clean="${p%%...}"      # drop a trailing prose ellipsis (path/...)
    clean="${clean%/}"      # drop a trailing slash (dir cited as path/)
    case "$clean" in
      benchmarks/results | benchmarks/results/) continue ;;  # bare prefix in prose
      *..*) continue ;;                                       # any residual ellipsis
    esac
    if [ ! -e "$REPO_ROOT/$clean" ]; then
      echo "  ${RED}FAIL${NC}: no-orphan-manifest -- cited path does not exist: $clean"
      orphans=$((orphans + 1))
    fi
  done < <(grep -oE 'benchmarks/results/[A-Za-z0-9./_-]+' "$CLAIMS_FILE" | sort -u)
  if [ "$orphans" -eq 0 ]; then
    echo "  ${GREEN}PASS${NC}: no-orphan-manifest (every cited benchmarks/results/ path resolves)"
    PASS=$((PASS + 1))
  else
    echo "  ${RED}FAIL${NC}: no-orphan-manifest ($orphans orphan path(s) in benchmarks/CLAIMS.md)"
    FAIL=$((FAIL + 1))
  fi
}

# run_forbidden_checks <file> — apply every FORBIDDEN pattern to one surface.
run_forbidden_checks() {
  local file="$1" entry label regex rest
  for entry in "${FORBIDDEN[@]}"; do
    label="${entry%%::*}"      # text before the first ::
    rest="${entry#*::}"        # everything after the first ::
    regex="$rest"
    check_no_match "no '$label'" "$regex" "$file"
  done
}

# --- Self-test mode (parse + planted-violation proof) ---------------------
# Proves the gate is NOT vacuous: it must detect a real `beats X` / `__%` in a
# surface. We plant the tokens in a TEMP file (never in this script, never in a
# real surface), confirm the detector fires on every planted token, then clean
# up. Also runs `bash -n` on this script.
if [ "${1-}" = "--self-test" ]; then
  st_fail=0
  if bash -n "$SCRIPT_DIR/check-publish-honesty.sh" 2>/dev/null; then
    echo "  ${GREEN}PASS${NC}: script parses (bash -n)"
  else
    echo "  ${RED}FAIL${NC}: script does NOT parse (bash -n)"
    st_fail=1
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/publish-honesty-plant.XXXXXX")"
  # Plant one token from each forbidden family + the canonical violations.
  {
    echo "Comis beats mem0 and Zep on every axis."        # superiority
    echo "The only agent memory that reasons and learns." # the-only-memory
    echo "Accuracy: __% (TODO fill from manifest)."        # __% + TODO
    echo "Per-type forgetting and usefulness-aware eviction ship today." # FORGET
    echo "Recall weights adapt over time via the dialectic." # weights-adapt + dialectic
  } > "$tmp"

  planted=("\\bbeats\\b" "the only ([a-z]+ )?memory" "__%" "\\bTODO\\b" \
           "\\bforgetting\\b" "usefulness-aware (eviction|lifecycle)" \
           "weights adapt" "\\bdialectic\\b")
  missed=0
  for pat in "${planted[@]}"; do
    if ! grep -qiE -e "$pat" -- "$tmp" 2>/dev/null; then
      echo "  ${RED}FAIL${NC}: planted token NOT detected by pattern: $pat"
      missed=$((missed + 1))
    fi
  done
  rm -f "$tmp"

  if [ "$missed" -eq 0 ]; then
    echo "  ${GREEN}PASS${NC}: planted-violation proof (all ${#planted[@]} forbidden tokens detected)"
  else
    echo "  ${RED}FAIL${NC}: planted-violation proof ($missed token(s) slipped through — gate would pass vacuously)"
    st_fail=1
  fi

  echo
  if [ "$st_fail" -eq 0 ]; then
    echo "  ${GREEN}SELF-TEST PASSED${NC} (parses + gate is non-vacuous)"
    exit 0
  else
    echo "  ${RED}SELF-TEST FAILED${NC}"
    exit 1
  fi
fi

if [ "${1-}" = "--strict" ]; then
  STRICT=1
fi

# --- Main checks ----------------------------------------------------------

echo
echo "-- Publish-honesty gate (binding constraint #8) --"
echo "   surfaces scoped to: README.md, docs/agents/memory-benchmarks.mdx, website/src/pages/memory.astro, launch blog post"
echo "   (missing surfaces SKIP — the gate exits 0 before they are written)"

for surface in "${PUBLISHED_SURFACES[@]}"; do
  echo
  echo "-- ${surface#"$REPO_ROOT"/} --"
  run_forbidden_checks "$surface"
done

echo
echo "-- No-orphan-manifest (benchmarks/CLAIMS.md -> benchmarks/results/) --"
check_no_orphan_manifest

echo
echo "-- Structural presence (advisory until --strict; enforced once surfaces are final) --"
check_grep_min_count "methodology page cites the reproduction command" 'bench-memory' \
  "$REPO_ROOT/docs/agents/memory-benchmarks.mdx" 1
check_grep_min_count "README links a committed manifest" 'benchmarks/results/' \
  "$REPO_ROOT/README.md" 1

# --- Result footer --------------------------------------------------------
echo
echo "-- RESULT --"
echo "  PASS: ${GREEN}${PASS}${NC} / ${TOTAL}"
echo "  FAIL: ${RED}${FAIL}${NC}"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
