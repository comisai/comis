#!/bin/bash
# Install the reviewed launchers the capability-service live gates hash-pin.
#
# Run once per host, as root, before the E0 mechanics gate or the wave-four
# join gate. Without it both die in `beforeAll`: `launcherHash()` reads these
# paths to compute the terminal-allowlist pin, so an absent file is a bare
# ENOENT naming a path no test creates.
#
# Two contracts ride on one file:
#
#  1. DevCrew probes `<launcher> --version` while composing the service and
#     compares stdout to the exact pinned version. A mismatch surfaces only as
#     `Failure cause: codex_composition` behind a socket timeout, several
#     layers above the probe that refused.
#  2. Comis's terminal allowlist pins path + argsPrefix + content hash, so the
#     file must be root-owned and unwritable by the daemon user. A launcher the
#     worker could rewrite would defeat all three.
#
# The probe runs with a SANITIZED environment, which can be empty. So the
# generated shebang is an absolute interpreter — `/usr/bin/env bash` needs PATH
# to resolve `bash`, and an empty PATH makes that read as an unavailable
# executable rather than a bad shebang — and the --version path uses only shell
# builtins.
#
# The gates use a deterministic in-process fixture worker, so these launchers
# are probed but never drive real work. A host that also runs the real-worker
# journey installs the actual harness on PATH; the exec below then finds it.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "provision-reviewed-launchers.sh must run as root (it writes /usr/local/bin)" >&2
  exit 1
fi

install_launcher() {
  local path="$1" version="$2" token="$3" tool="$4"
  cat > "$path" <<LAUNCHER
#!/bin/bash
# Reviewed launcher pinned by the capability-service terminal allowlist.
if [ "\${1:-}" = "--version" ]; then
  echo "$version"
  exit 0
fi
if [ "\${1:-}" = "$token" ]; then
  shift
fi
if command -v "$tool" >/dev/null 2>&1; then
  exec "$tool" "\$@"
fi
echo "$tool is not installed for reviewed launcher $path" >&2
exit 127
LAUNCHER
  chown root:root "$path"
  chmod 0755 "$path"
  printf '%-38s %-24s %s\n' "$path" "$version" "$(sha256sum "$path" | cut -d' ' -f1)"
}

echo "=== installing reviewed launchers ==="
install_launcher /usr/local/bin/e0-codex-launcher     "codex-cli 0.147.0"     e0-reviewed           codex
install_launcher /usr/local/bin/wave4-codex-launcher  "codex-cli 0.147.0"     wave4-reviewed        codex
install_launcher /usr/local/bin/wave4-claude-launcher "2.1.233 (Claude Code)" wave4-claude-reviewed claude

# Prove the probe contract under the environment the probe actually uses, so a
# regression fails here rather than as an opaque composition error.
echo "=== verifying the probe contract under an empty environment ==="
for launcher in /usr/local/bin/e0-codex-launcher \
                /usr/local/bin/wave4-codex-launcher \
                /usr/local/bin/wave4-claude-launcher; do
  printf '%-38s -> %s\n' "$launcher" "$(env -i "$launcher" --version)"
done
