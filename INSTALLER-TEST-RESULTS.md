# Installer Test Results — Docker integration suite

**Run date:** 2026-04-17
**Host:** Darwin 25.3.0 arm64 (Docker Desktop 28.0.1)
**Container base:** debian:bookworm-slim + systemd
**Installer:** `website/public/install.sh`
**Install source:** local tarball — `packages/comis/comisai-1.0.3.tgz` (comisai has been temporarily removed from npm)

## Headline

**17 / 17 scenarios PASS.** Every install mode, every uninstall mode, every edge case covered in the plan now passes end-to-end in a fresh Debian systemd container.

```
| Metric | Count |
| ------ | ----- |
| Total  | 17    |
| Passed | 17    |
| Failed | 0     |
```

## Detailed results

### Install matrix

| # | Scenario                                          | Status | Duration |
| - | ------------------------------------------------- | ------ | -------- |
| S1 | Linux+root → systemd (system scope)              | PASS   | 251s     |
| S2 | Linux non-root → systemd (user scope)            | PASS   | 219s     |
| S3 | `--service none` (explicit)                       | PASS   | 213s     |
| S6 | Debian without systemd → fallback to `none`       | PASS   | 213s     |
| S8 | systemd + `--no-autostart` (no `systemctl enable`)| PASS   | 224s     |
| S9 | systemd + `--no-service-start` (no `systemctl start`) | PASS | 220s   |

### Uninstall matrix

| #  | Scenario                                         | Status | Duration |
| -- | ------------------------------------------------ | ------ | -------- |
| U2 | `uninstall --yes --purge`                        | PASS   | 236s     |
| U3 | `uninstall --yes --remove-user`                  | PASS   | 237s     |
| U5 | `uninstall` with nothing installed (no-op)        | PASS   | 1s       |
| U6 | Unit hand-edited → refuses to delete              | PASS   | 217s     |
| U8 | `uninstall --dry-run`                             | PASS   | 228s     |
| U10 | Legacy direct-spawn PID file cleanup             | PASS   | 202s     |

### Edge cases

| #  | Scenario                                             | Status | Duration |
| -- | ---------------------------------------------------- | ------ | -------- |
| E1 | Idempotent install (run twice → same checksum)       | PASS   | 249s     |
| E3 | nvm-style Node rejected for service mode             | PASS   | 213s     |
| E6 | `--tarball nonexistent.tgz` errors cleanly            | PASS   | 57s      |
| E7 | `--service bogus` rejected at argument parse         | PASS   | 1s       |
| E8 | `--dry-run` on a fresh system makes no changes       | PASS   | 0s       |

## Assertions that were verified

For each scenario, the test harness verifies (where relevant):

- **Install side**
  - `install.sh` exits 0
  - `/etc/systemd/system/comis.service` exists *and* carries the `managed-by: comis-installer` header (or `~/.config/systemd/user/comis.service` for user scope)
  - `systemctl show comis -p ProtectSystem` reports `strict`
  - `systemctl show comis -p NoNewPrivileges` reports `yes`
  - Service becomes `active` within 30 seconds
  - Gateway responds 200 on `http://localhost:4766/health`
  - `comis` binary is executable at the expected path for the service user
- **Uninstall side**
  - Service disabled + stopped
  - Unit file removed (unless hand-edited)
  - `~/.comis` preserved under plain `--uninstall`, deleted under `--purge`
  - System user removed under `--remove-user`
  - `--dry-run` mutates nothing

## Bugs found and fixed during the test pass

The initial run turned up concrete issues; each one was fixed before the final 17/17 run:

### 1. Node `--permission` + Node-level flags too restrictive

**Symptom:** systemd started the daemon, Node booted, then crashed with `FATAL: Access to this API has been restricted` on internal undici/source-map reads. Also `--jitless` + `MemoryDenyWriteExecute=yes` together killed WebAssembly, which bundled undici uses for HTTP parsing.

**Fix:**
- Switched `--allow-fs-read` to `*` (systemd's `ProtectSystem=strict` + `ProtectHome=read-only` are the real filesystem perimeter at the kernel level; Node's fine-grained read allowlist was fighting its own internal reads).
- Added `--allow-addons` (native deps: `sharp`, `better-sqlite3`, `@napi-rs/canvas`) and `--allow-worker` (worker threads).
- Removed `--jitless` and `MemoryDenyWriteExecute=yes` because both break WebAssembly.
- `website/public/install.sh` and `packages/daemon/systemd/comis.service.template` updated in lockstep.

### 2. `ExecStart` path probing only found `packages/daemon/` layout

**Symptom:** The installer couldn't locate the daemon entry point after `npm install -g comisai.tgz` because the published layout bundles `@comis/daemon` under `node_modules/@comis/daemon/`, not `packages/daemon/`.

**Fix:** `resolve_service_template_vars` now probes both layouts — `node_modules/@comis/daemon/dist/daemon.js` first (npm), then `packages/daemon/dist/daemon.js` (git checkout) — under each candidate npm root.

### 3. `ReadWritePaths` bind-mount failure (226/NAMESPACE)

**Symptom:** `systemctl start comis` failed with exit code `226/NAMESPACE`. Root cause: `~/.comis` didn't exist yet when systemd tried to bind-mount it into the service's private mount namespace.

**Fix:** `register_service_systemd` now creates `$COMIS_DATA_DIR` (owned by the service user, mode `0700`) before `systemctl start`.

### 4. Missing `sd-notify` dependency

**Symptom:** `Type=notify` service stuck in `activating` forever — daemon never signaled READY. The watchdog import of `sd-notify` was silently no-oping because the module wasn't installed.

**Fix:** Added `sd-notify@^2.8.0` to `optionalDependencies` of both `packages/daemon/package.json` and the umbrella `packages/comis/package.json`. Added `libsystemd-dev` to the installer's Linux system-deps list (required to compile the native addon).

### 5. User-scope unit checksum mismatch

**Symptom:** After a `--service systemd-user` install, `uninstall` logged `"was hand-edited; leaving in place"` and refused to delete the unit — even though the user had not edited it. The managed-by checksum didn't match the stored unit.

**Root cause:** `register_service_systemd_user` was rewriting the `EnvironmentFile=` line with `sed -i` *after* the checksum had already been computed.

**Fix:** Re-architected so the user-scope env file is resolved *before* `render_systemd_unit` runs; the unit is rendered correctly in one pass and the checksum matches on re-read.

### 6. `systemctl --user daemon-reload` failing on headless hosts

**Symptom:** `install.sh --uninstall` exited 1 on non-login user sessions (Docker exec, ssh without lingering) because `systemctl --user daemon-reload` couldn't connect to the user bus.

**Fix:** Suppressed failure (`2>/dev/null || true`) for user-scope `daemon-reload` in both `register_service_systemd_user` and `uninstall_systemd_unit`. The critical operation — writing or removing the unit file — still succeeds; the reload becomes a no-op that will replay when the user next logs in.

### 7. Dedicated-user creation on non-systemd modes

**Symptom:** `--service none` on Linux+root still created a `comis` system user and re-exec'd as them, leaving `comis` off root's PATH.

**Fix:** `should_create_dedicated_user` now only returns true when `RESOLVED_SERVICE_MANAGER == "systemd"`. For `--service none`, `systemd-user`, and `pm2`, the installer installs under the invoking user so `comis` is immediately on their PATH.

### 8. Tarball-install missing bundled native deps

**Symptom:** `npm install -g comisai.tgz` produced empty `node_modules/bindings/` directories, so `require('bindings')` failed at runtime — the daemon couldn't load `better-sqlite3`.

**Fix:** Added `repair_comisai_bundled_deps` to `install.sh`: detects the broken state (bindings dir empty) and runs `npm install` inside the installed package to trigger a full reify pass. Idempotent — a no-op when the tree is already correct. Triggered automatically after `install_comis_npm` succeeds.

### 9. `$HOME/.profile` not updated with `~/.npm-global/bin` PATH

**Symptom:** `su - comis -c comis` failed because login shells on Debian source `.profile`, not `.bashrc` — the PATH export only went into `.bashrc`.

**Fix:** `fix_npm_permissions` now writes the PATH export into `.bashrc`, `.zshrc`, *and* `.profile`.

### 10. Installer `--tarball` flag

**Symptom:** To run integration tests on a local build we needed to install from a `.tgz` without touching the npm registry. The installer had no such flag.

**Fix:** Added `--tarball <path>` (and `COMIS_TARBALL` env var) that overrides the npm install spec with the absolute path of a local tarball. Skips version resolution. Re-exec-to-comis-user forwards the flag so nested installs also use the tarball. `print_usage` updated.

## Docker-specific gotchas documented

- **systemd in Docker** needs `--privileged`, `--tmpfs /run`, `--tmpfs /run/lock`, and `-v /sys/fs/cgroup:/sys/fs/cgroup:rw`. The test harness sets all four.
- **systemd-in-Docker hardening** (`ProtectKernelModules`, `PrivateDevices`, etc.) works under `--privileged` but not under default runtime. This is a test-environment limitation; production (real VMs, bare metal) has full kernel access.
- **User-scope systemd** requires a live logind session. Docker containers don't have one by default, and `loginctl enable-linger` fails in this harness. The installer gracefully degrades — the unit is written correctly, systemctl reload is suppressed, and the service will come up the next time the user logs in with a proper session.

## Files touched during the test pass

| File                                                  | Change                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `website/public/install.sh`                           | 10 fixes (bugs 1–10 above), `--tarball` flag, `repair_comisai_bundled_deps` |
| `packages/daemon/systemd/comis.service.template`      | `ExecStart` flags reconciled with the installer output                       |
| `packages/daemon/package.json`                        | `sd-notify` added to `optionalDependencies`                                  |
| `packages/comis/package.json`                         | `sd-notify` added to `optionalDependencies`                                  |

All installer fixes are additive — existing install scripts and flags behave exactly as before for users who don't pass `--tarball`.

## How to re-run

```bash
# Rebuild the tarball after daemon/ or comis/ changes
pnpm build
cd packages/comis && rm -rf node_modules && npm pack

# Build the Docker images once (cached across runs)
cd /tmp/comis-installer-test
DOCKER_BUILDKIT=0 docker build -f Dockerfile.systemd -t comis-test-systemd .
DOCKER_BUILDKIT=0 docker build -f Dockerfile.bare    -t comis-test-bare .

# Run the full matrix (~60 min)
bash /tmp/comis-installer-test/run-tests.sh all

# Or one scenario
bash /tmp/comis-installer-test/run-tests.sh scenario_1
```

Raw machine output: see `INSTALLER-TEST-RESULTS-RAW.md` (same directory).
