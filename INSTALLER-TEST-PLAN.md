# Installer Test Plan — Docker-based integration suite

**Scope:** end-to-end verification of `website/public/install.sh` and `comis uninstall` across all supported OS + service-manager combinations, with a local `.tgz` tarball standing in for the npm registry.

**Why this exists:** the installer now owns service registration, uninstall, and several safety rails (managed-by checksums, version-manager rejection, PID-file migration). None of those had automated coverage; a regression in any of them silently breaks first-run experience for every new user.

## 1. Constraints for this run

1. **Package source:** the `comisai` package has been temporarily removed from npm, so every test installs from a local tarball built via `pnpm pack` on `packages/comis/`. The installer is extended with a `--tarball <path>` flag for this; otherwise `npm install -g` in the test environment would hit the public registry and fail.
2. **Hosts:**
   - Linux scenarios: fresh Debian `bookworm-slim` Docker containers (arm64 on the test host).
   - macOS/pm2 scenarios: cannot be tested in Linux containers. They're covered by a separate **host-local** script run on the developer Mac, isolated via a scratch `$HOME`.
3. **Network:** tests pre-copy the tarball into each container, so they don't need internet. Installer Node-installation paths (apt/NodeSource) do need network, which is available to Docker by default.
4. **Systemd inside Docker:** requires a specific run configuration — `--privileged`, `--tmpfs /run`, cgroup v2 mount, and the container's entrypoint must be `/lib/systemd/systemd`. Tests that need systemd set this up; tests that don't need it use a plain `/bin/bash` container.

## 2. What we test

### 2.1 Install matrix

| # | OS             | Mode         | `--service`     | Expected manager    | Boot persistence? |
| - | -------------- | ------------ | --------------- | ------------------- | ----------------- |
| 1 | Debian + systemd | root       | auto (default)  | systemd (system)    | systemctl enable  |
| 2 | Debian + systemd | non-root   | auto (default)  | systemd (user)      | linger hint shown |
| 3 | Debian + systemd | root       | none            | none                | manual start only |
| 4 | Debian + systemd | root       | systemd-user    | rejected (needs non-root or should force)* | n/a |
| 5 | Debian + systemd | root       | pm2             | pm2 (falls back)    | none (no launchd) |
| 6 | Debian — no systemd | non-root | auto          | none (fallback)     | n/a               |
| 7 | Debian + systemd | root + `--no-user` | auto  | systemd (system, as root user) | systemctl enable |
| 8 | Debian + systemd | root       | auto + `--no-autostart` | systemd (system) | **not** enabled   |
| 9 | Debian + systemd | root       | auto + `--no-service-start` | systemd (system) | enabled, **not started** |
| 10 | macOS (host)   | non-root   | auto (default)  | pm2                 | `pm2 startup launchd` (sudo) |
| 11 | macOS (host)   | non-root   | auto + `--no-autostart` | pm2         | ecosystem only, no plist |

\* For scenario 4: systemd-user from root works but is unusual — the user service installs under root's `~/.config/systemd/user/`. Test verifies behavior matches `resolve_service_manager()` rules without erroring.

### 2.2 Uninstall matrix

| #  | Pre-condition                      | Command                                 | Expected                                                    |
| -- | ---------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| U1 | Scenario 1 installed               | `comis uninstall --yes`                 | unit removed, daemon-reload, binary removed, `~/.comis` kept |
| U2 | Scenario 1 installed               | `comis uninstall --yes --purge`         | all of U1 + `~comis/.comis` deleted                         |
| U3 | Scenario 1 installed               | `comis uninstall --yes --remove-user`   | all of U2 + `comis` user deleted                            |
| U4 | Scenario 2 installed               | `comis uninstall --yes`                 | user-scope unit removed                                     |
| U5 | Nothing installed                  | `comis uninstall --yes`                 | rc=0, no-op, no errors (idempotent)                         |
| U6 | Scenario 1 + unit hand-edited      | `comis uninstall --yes`                 | unit kept, warning printed, binary still removed            |
| U7 | Scenario 1 + other process running as `comis` | `comis uninstall --yes --remove-user` | user NOT deleted, clear error              |
| U8 | Scenario 1 installed               | `comis uninstall --yes --dry-run`       | nothing mutated, plan printed                               |
| U9 | Scenario 10 (macOS pm2)            | `comis uninstall --yes`                 | pm2 process removed, launchd plist removed                  |
| U10 | Legacy direct-spawn daemon running | `comis uninstall --yes`                 | direct daemon killed, PID file cleaned                     |

### 2.3 Edge cases

| # | Scenario                                                                                              | Expected                                                               |
| - | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| E1 | Re-run installer on an already-installed host (upgrade path)                                          | unit re-rendered only if checksum matches or unit identical; otherwise preserved; service restarted |
| E2 | Flip `--service` between runs (systemd → pm2 → systemd)                                               | legacy manager cleaned up, new manager registers cleanly                |
| E3 | Version-manager Node (nvm/fnm/volta) visible on PATH                                                  | `--service auto` rejects with clear error + remediation hint             |
| E4 | Stale `~/.comis/daemon.pid` from direct-spawn daemon before service install                            | `cleanup_legacy_daemon_state` stops the process and removes the PID file |
| E5 | WSL without systemd                                                                                   | falls back to `--service none` with `/etc/wsl.conf` guidance            |
| E6 | `--tarball /nonexistent.tgz`                                                                          | installer errors with clear "not found" message                         |
| E7 | Invalid `--service bogus`                                                                             | installer exits 2 with enumeration of valid values                      |
| E8 | Dry-run from a fresh system                                                                           | prints plan, makes no changes                                            |

### 2.4 Behavioral assertions (applied across multiple scenarios)

- **Idempotency:** running the same install command twice produces the same end state on the second run (no duplicate units, no errors).
- **Sandboxing:** after systemd install, `systemctl show comis -p ProtectSystem,ProtectHome,NoNewPrivileges` reports the expected hardening values.
- **Gateway health:** after start, `curl http://localhost:4766/health` returns 200 within 20 seconds (when API keys exist or the daemon doesn't require them for startup).
- **Checksum integrity:** `unit_is_managed` returns true for freshly installed units and false after any line change.

## 3. Out of scope for this run

- **Full runtime functional tests** (agent execution, channel connections). The daemon starting and passing the gateway health check is sufficient — we're testing the *installer*, not Comis itself.
- **Upgrade from an older Comis version.** Requires two published tarballs. Revisit once a stable published version exists again.
- **IPv6-only networks, SELinux in enforcing mode, cross-architecture runs** (x86_64 Docker on arm64 host). Deferred.
- **`--install-method git`** paths. The tarball approach only exercises `--install-method npm`. Git install is exercised by our existing local development workflow.

## 4. Test harness design

### 4.1 Tarball

```bash
pnpm build                   # build all workspace packages
cd packages/comis
pnpm pack                    # produces comisai-1.0.3.tgz (runs prepack.js)
# Result: packages/comis/comisai-1.0.3.tgz
```

Added installer flag `--tarball <path>` (and `COMIS_TARBALL` env) that overrides the npm install spec with the absolute path to a local tgz. The flag short-circuits version resolution, so `--beta` / `--version` are ignored when it's set.

### 4.2 Docker images

Two base images:

**`debian-systemd`** (built once, cached):
```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y \
      systemd systemd-sysv dbus curl sudo ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
```

Run pattern:
```bash
docker run -d --privileged --name <test-name> \
  --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$PWD/comisai-1.0.3.tgz:/opt/comisai.tgz:ro" \
  -v "$PWD/website/public/install.sh:/opt/install.sh:ro" \
  debian-systemd
```

**`debian-bare`**: for no-systemd fallback and non-root scenarios where systemd isn't required, plain `debian:bookworm-slim`.

### 4.3 Runner

A single `scripts/test-installer.sh` orchestrates:

```
for scenario in matrix; do
    docker run -d ...                            # spin up container
    docker exec <c> <scenario-specific-setup>    # create user, etc.
    docker exec <c> bash /opt/install.sh <args>  # run installer
    docker exec <c> <scenario-specific-assertions>  # verify state
    docker exec <c> bash /opt/install.sh --uninstall <uninstall-args>
    docker exec <c> <post-uninstall-assertions>
    docker rm -f <c>                              # tear down
done
```

Each scenario reports PASS/FAIL with captured logs. Full run writes `installer-test-results.md`.

### 4.4 Assertion helpers (inside container)

```bash
assert_systemd_active() { systemctl is-active comis >/dev/null; }
assert_unit_hardened() {
    for prop in "ProtectSystem=strict" "NoNewPrivileges=yes" "MemoryDenyWriteExecute=yes"; do
        systemctl show comis -p "${prop%=*}" --value | grep -q "${prop#*=}" \
            || return 1
    done
}
assert_binary_exists() { command -v comis >/dev/null; }
assert_no_binary()     { ! command -v comis >/dev/null 2>&1; }
assert_data_intact()   { [[ -d ~/.comis ]]; }
assert_no_data()       { [[ ! -d ~/.comis ]]; }
assert_gateway_ready() { curl -fsS --max-time 5 http://localhost:4766/health; }
```

### 4.5 Run modes

- **`quick`**: scenarios 1, 2, 6 + U1, U2, U5 — smoke-tests the primary paths (~5 min).
- **`full`**: every matrix row — ~20 min.
- **`single <n>`**: one named scenario for debugging.

## 5. Pass/fail reporting

Each scenario produces a structured record:

```
### Scenario 1 — Linux+root → systemd system scope
  Status: PASS
  Duration: 42s
  Install  : comis daemon started; unit active; hardening verified
  Uninstall: unit removed; binary removed; ~/.comis intact
  Logs     : <attached on failure>
```

Aggregated into `installer-test-results.md` with pass/fail counts. Any failure dumps `journalctl -u comis -n 100` and `systemctl status comis` for triage.

## 6. Known limitations

- **arm64 host running arm64 Node in arm64 Debian container:** mirrors production topology for ARM servers but not x86_64-specific quirks (e.g., sharp prebuilt binary paths). Acceptable for initial coverage; a later run on x86_64 CI would be ideal.
- **No network partition scenarios.** If NodeSource/apt mirrors are down, install fails — we don't simulate that.
- **`--service pm2` on Linux** requires installing pm2 from npm registry. Since registry access is available in Docker, this works, but it does reach out to the internet.

## 7. Success criterion

**The plan passes if:** every scenario in §2.1–§2.3 reports PASS, every assertion in §2.4 holds, and zero `systemctl status comis` invocations show `Failed` state post-install.

**The plan fails if:** any scenario regresses — including "pre-existing weirdness" — because this is the first comprehensive coverage, so any observed failure must either be fixed or explicitly documented as a new known limitation in §6.
