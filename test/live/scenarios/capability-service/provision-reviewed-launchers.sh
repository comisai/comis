#!/bin/bash
# Install the reviewed launchers the capability-service live gates hash-pin.
#
# Run once per host, as root, before the deterministic E0 mechanics gate.
# Without it the gate dies in `beforeAll`: the harness READS these paths to
# compute the terminal-allowlist hash pin, so an absent file is a bare ENOENT
# naming a path nothing in the repository creates.
#
# A second, quieter contract also rides on the file. While composing its
# service the companion EXECUTES `<launcher> --version` and compares stdout to
# the exact pinned version. A launcher that answers anything else — including
# one that insists on its reviewed token first, because `--version` is not that
# token — surfaces only as `Failure cause: codex_composition` behind an
# operator-socket timeout, several layers above the probe that refused.
#
# Scope: this provisions enough for the DETERMINISTIC gate, which drives an
# in-process fixture worker and asserts no real harness process participates.
# It is not enough for the real-worker journey, whose launcher carries role
# bootstraps, a concurrent-start barrier and sibling-confinement evidence. That
# one belongs with the scenario that drives it.
#
# The launcher therefore delegates `--version` to the harness when one is
# installed, and a probe stub stands in when none is. The stub answers the
# probe and refuses everything else loudly, so it can never be mistaken for a
# worker.
set -euo pipefail

# Default target is the reviewed system path. LAUNCHER_PREFIX exists so the
# contract gate can execute this script into a temp dir on any host and assert
# what the launchers actually ANSWER — a text-only check cannot catch a shell
# bug, and one shipped here: a `local` that referenced a sibling assignment in
# the same statement, which `set -u` rejects because bash expands every word
# before it assigns any of them.
PREFIX="${LAUNCHER_PREFIX:-/usr/local/bin}"
if [ "$PREFIX" = "/usr/local/bin" ] && [ "$(id -u)" -ne 0 ]; then
  echo "provision-reviewed-launchers.sh must run as root (it writes /usr/local/bin)" >&2
  exit 1
fi
mkdir -p "$PREFIX"

# Ownership is only meaningful for the reviewed system path, and only root can
# set it. A temp-prefix run still proves the probe contract, which is the part a
# gate can check.
harden() {
  chmod 0755 "$1"
  [ "$(id -u)" -eq 0 ] && chown root:root "$1"
  return 0
}

# Absolute interpreter, not `/usr/bin/env`. The probe inherits the environment
# today only because no probe environment is configured; the adapter accepts one
# in which PATH need not appear, and `env` cannot resolve `bash` without PATH.
# Resolve the harness ONCE and hand the launcher the path it resolved to.
# Checking `command -v` but delegating to "$PREFIX/$tool" is how this broke the
# first time: an ambient harness on PATH suppressed the stub, and the launcher
# then delegated to a path nothing had created.
RESOLVED=""
resolve_or_stub() {
  local tool="$1"
  local version="$2"
  local path="$PREFIX/$tool"
  local found
  found="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$found" ]; then
    RESOLVED="$found"
    printf '%-38s %s\n' "$tool" "harness present at $found — no stub installed"
    return 0
  fi
  cat > "$path" <<STUB
#!/bin/bash
# Version-probe stub for the deterministic mechanics gate.
#
# That gate runs the fixture worker and asserts no real $tool process ever
# participates, but service composition still probes the configured
# executable's version before it will start. This answers only that probe.
if [ "\${1:-}" = "--version" ] && [ "\$#" -eq 1 ]; then
  echo "$version"
  exit 0
fi
echo "$tool version-probe stub: refusing to act as a worker" >&2
exit 97
STUB
  harden "$path"
  RESOLVED="$path"
  printf '%-38s %s\n' "$path" "probe stub -> $version"
}

install_launcher() {
  local name="$1"
  local token="$2"
  local tool="$3"
  local path="$PREFIX/$name"
  cat > "$path" <<LAUNCHER
#!/bin/bash
# Reviewed launcher pinned by the capability-service terminal allowlist.
# Root-owned and unwritable by the daemon user on purpose: the allowlist pins
# path, argument prefix and content hash, and a launcher the worker could
# rewrite would defeat all three.
if [ "\${1:-}" = "--version" ] && [ "\$#" -eq 1 ]; then
  exec "$tool" --version
fi
if [ "\${1:-}" != "$token" ]; then
  echo "reviewed launcher rejected unreviewed arguments" >&2
  exit 2
fi
shift
exec "$tool" "\$@"
LAUNCHER
  harden "$path"
  printf '%-38s %s\n' "$path" "-> $tool"
}

echo "=== harness resolution ==="
resolve_or_stub codex "codex-cli 0.147.0"
CODEX="$RESOLVED"
resolve_or_stub claude "2.1.233 (Claude Code)"
CLAUDE="$RESOLVED"

echo "=== reviewed launchers ==="
install_launcher e0-codex-launcher     e0-reviewed           "$CODEX"
install_launcher wave4-codex-launcher  wave4-reviewed        "$CODEX"
install_launcher wave4-claude-launcher wave4-claude-reviewed "$CLAUDE"

# Prove the probe contract the way the companion invokes it, so a regression
# fails here rather than as an opaque composition error two layers up.
echo "=== probe contract ==="
for name in e0-codex-launcher wave4-codex-launcher wave4-claude-launcher; do
  printf '%-38s -> %s\n' "$PREFIX/$name" "$("$PREFIX/$name" --version)"
done
