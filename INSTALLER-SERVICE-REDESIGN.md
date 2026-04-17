# Installer Redesign — Managed Service Integration

**Status:** Ready for implementation
**Author:** review of `website/public/install.sh`
**Target:** `website/public/install.sh` + supporting CLI changes
**Scope:** Make the one-liner installer register the daemon as a supervised service on first install.

---

## 1. Problem Statement

Today `install.sh` drops the CLI into place and, at the end, tells the user to run `comis daemon start`. On Linux this runs a **detached `node` process** with a PID file in `~/.comis/` — no boot persistence, no watchdog, no sandboxing, no journal integration. The hardened systemd unit exists at `packages/daemon/systemd/comis.service` but the installer never copies it, never runs `systemctl daemon-reload`, and never enables the service. On macOS the installer does nothing about supervision at all; `comis pm2 setup` exists as a separate manual step and launchd boot persistence is never wired up.

The `comis daemon` CLI (`packages/cli/src/commands/daemon.ts:131–350`) already auto-detects systemd via `hasSystemd()` and prefers `systemctl start comis` when the unit is registered — but because the installer never registers it, that branch is dead code for every fresh install.

**Goal:** after a successful install, `comis` is a real managed service:

| OS     | Supervisor | Boot persistence | Log sink                    |
| ------ | ---------- | ---------------- | --------------------------- |
| Linux  | systemd    | `systemctl enable` | journald (`journalctl -u comis`) |
| macOS  | pm2        | `pm2 startup` (launchd) | `~/.pm2/logs/comis-*.log`   |

## 2. Non-Goals

- Adding a third supervisor (supervisord, OpenRC, runit). systemd is the de-facto Linux standard for targets we support (Node 22 is already a hard dep, which implies a reasonably modern distro); anything non-systemd falls back to the existing direct-spawn mode.
- Rewriting the daemon control CLI. `comis daemon start/stop/status/logs` already multiplexes systemd vs direct spawn; it just needs a pm2 branch on macOS and a user-systemd branch for non-root Linux.
- Containerised installs. Docker is handled by a separate path (`docs/operations/docker.mdx`).

## 3. Current State (evidence)

- `install.sh:2470–2476` — on Linux-as-root it installs system deps, creates the `comis` user, re-execs as that user, then returns. No service wiring.
- `install.sh:1807–1815` — on successful re-exec the only instruction printed is `comis daemon start`.
- `install.sh` grep for `systemd|systemctl|pm2|\.service|launchd`: **zero matches**.
- `packages/daemon/systemd/comis.service` — expects `/opt/comis` + `/var/lib/comis` + `/etc/comis/env`, none of which exist after an npm global install.
- `packages/cli/src/commands/pm2.ts:59` — ecosystem script path is resolved relative to `@comis/cli` dist, so it works for both git and npm installs; `pm2 save` / `pm2 startup` are **not** invoked anywhere.
- `packages/cli/src/commands/daemon.ts:131–142` — `hasSystemd()` requires both `/run/systemd/system` **and** `comis.service` to be registered. Fresh installs fail the second check, so daemon CLI silently falls back to direct spawn.

## 4. Design Overview

Introduce a **service-manager abstraction** inside `install.sh`. After the CLI is on disk, the installer picks one manager and runs it:

```
detect_service_manager()
  ├── macOS                     → pm2
  ├── Linux + systemd + root    → systemd (system scope)
  ├── Linux + systemd + non-root→ systemd (user scope, `--user`)
  └── otherwise                 → none (print manual instructions)
```

New CLI flag `--service <auto|systemd|systemd-user|pm2|none>` (default `auto`). Env override `COMIS_SERVICE=...`. Current "print `comis daemon start`" behavior is preserved under `--service none`.

### 4.1 Inputs to service templating

Regardless of manager, the installer resolves the following **once** and passes them to the template:

| Variable          | Source                                                     | Example                                                    |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `COMIS_NODE_BIN`  | `command -v node` (after `ensure_supported_node_on_path`)  | `/usr/bin/node` or `/home/comis/.nvm/versions/node/v22…/bin/node` |
| `COMIS_DAEMON_JS` | `$(npm root -g)/comisai/packages/daemon/dist/daemon.js` for npm installs; `<repo>/packages/daemon/dist/daemon.js` for git installs | `/usr/lib/node_modules/comisai/packages/daemon/dist/daemon.js` |
| `COMIS_USER`      | `comis` if root-install, else current user                 | `comis`                                                    |
| `COMIS_HOME`      | `getent passwd <user>` → home                              | `/home/comis`                                              |
| `COMIS_DATA_DIR`  | `$COMIS_HOME/.comis`                                       | `/home/comis/.comis`                                       |
| `COMIS_CONFIG`    | `$COMIS_DATA_DIR/config.yaml`                              | `/home/comis/.comis/config.yaml`                           |

This deliberately keeps the current `~/.comis` data layout — we do **not** move to `/opt/comis` + `/var/lib/comis`. Reasons:

1. It works for both root and non-root installs uniformly.
2. `comis doctor`, `comis init`, `comis pm2 setup`, and the test harnesses all already target `~/.comis`.
3. Moving layout requires a separate migration RFC; this design is about *adding supervision*, not relocating data.

Consequence: the **shipped `packages/daemon/systemd/comis.service` is abandoned as-is**. The installer generates a unit from a template instead. The checked-in file becomes a reference document only (or is deleted — see §9).

### 4.2 Linux / systemd flow (root install)

Preconditions: running as root, `/run/systemd/system` exists.

```
1. install_system_deps_as_root           # existing
2. create_comis_user                     # existing
3. reexec_as_comis_user                  # existing — installs CLI under comis user
4. ← return to root with rc=0
5. resolve_service_template_vars          # NEW — probes daemon.js path under ~comis
6. render_systemd_unit > /etc/systemd/system/comis.service
7. render_env_file    > /etc/comis/env          # 0600, owned root:comis
8. systemctl daemon-reload
9. systemctl enable --now comis
10. wait_for_ready (polls http://localhost:4766/health)
11. on failure: systemctl status comis --no-pager; journalctl -u comis -n 50
```

The re-exec step (which currently happens **in main()** before any service wiring) is refactored so that `main()` runs the user-scoped install via `su - comis` and then returns to the root shell to finish service registration. Concretely:

```bash
if should_create_dedicated_user; then
    install_system_deps_as_root
    create_comis_user
    reexec_as_comis_user         # installs CLI under comis user, returns rc
    local user_rc=$?
    [[ "$user_rc" -ne 0 ]] && return "$user_rc"
    register_service_linux       # NEW — still running as root here
    return 0
fi
```

The re-exec currently ends with `return $?` which short-circuits `main()`; that `return` is replaced with a fallthrough so post-install steps can run as root.

### 4.3 Linux / systemd flow (non-root / user scope)

Preconditions: not root, `systemctl --user` works, `XDG_RUNTIME_DIR` is set (typical on desktop; on headless servers `loginctl enable-linger <user>` may be needed — we print the hint, do not auto-execute).

```
1. install_comis (npm/git as current user)
2. render_systemd_unit > ~/.config/systemd/user/comis.service
3. systemctl --user daemon-reload
4. systemctl --user enable --now comis
5. print: "To survive logout, run: sudo loginctl enable-linger $USER"
```

Unit differences in user scope: no `User=`, no `Group=`, no `ReadWritePaths=/var/lib/comis` (drop it — `ProtectHome=` must also be `tmpfs` or `off` because `$HOME/.comis` has to be writable). The hardening posture is **relaxed** in user scope; we document this trade-off.

### 4.4 macOS / pm2 flow

Preconditions: macOS, `npm` on PATH.

```
1. install_comis (npm/git)
2. ensure_pm2                            # npm install -g pm2 if missing
3. comis pm2 setup                        # writes ~/.comis/ecosystem.config.js
4. comis pm2 start                        # pm2 start ecosystem.config.js
5. pm2 save                               # snapshot process list
6. pm2 startup launchd -u $USER --hp $HOME
   └── prints sudo line; installer executes it (with --no-sudo-prompt check)
7. wait_for_ready (polls http://localhost:4766/health)
```

Step 6 is the one that needs confirmation — `pm2 startup` prints a `sudo env PATH=… pm2 startup launchd -u <user> --hp <home>` command that must be run as root to install the launchd plist. Two modes:

- **Interactive (default):** installer runs the sudo line directly, sudo prompts for password.
- **`--no-autostart`:** skip step 6; pm2-managed but no boot persistence. Print manual instructions.

On uninstall or `--service pm2 → none` switch: `pm2 unstartup launchd` and `pm2 delete comis`.

### 4.5 Flag matrix

| Flag                          | Effect                                                               |
| ----------------------------- | -------------------------------------------------------------------- |
| `--service auto` (default)    | Pick per OS/priv as described in §4                                  |
| `--service systemd`           | Force system-scope systemd; error if not root or not systemd         |
| `--service systemd-user`      | Force user-scope systemd                                             |
| `--service pm2`               | Force pm2 (requires npm global write permission or `sudo npm i -g`)  |
| `--service none`              | Install CLI only, print manual `comis daemon start`                  |
| `--no-autostart`              | Install service but do **not** enable boot persistence / `pm2 startup` |
| `--no-service-start`          | Install + enable but do not start yet (useful for pre-config setups) |

Env equivalents: `COMIS_SERVICE`, `COMIS_NO_AUTOSTART`, `COMIS_NO_SERVICE_START`.

## 5. Generated Artifacts

### 5.1 Systemd unit (system scope)

Template lives inline in `install.sh` as a heredoc. Differences from the checked-in file:

- `ExecStart` uses resolved absolute `$COMIS_NODE_BIN` and `$COMIS_DAEMON_JS`.
- `WorkingDirectory=$COMIS_HOME` (not `/opt/comis`).
- `ReadWritePaths=$COMIS_DATA_DIR` (not `/var/lib/comis /var/log/comis`).
- Node `--permission` flags paths updated: `--allow-fs-read=$COMIS_DAEMON_JS_DIR --allow-fs-write=$COMIS_DATA_DIR --allow-child-process`.
- `EnvironmentFile=-/etc/comis/env` unchanged.
- Security hardening directives retained verbatim: `ProtectSystem=strict`, `ProtectHome=yes` (with `$COMIS_DATA_DIR` added to `ReadWritePaths` to punch through), `MemoryDenyWriteExecute=yes`, `SystemCallFilter=@system-service`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`.

**Decision — ProtectHome posture:** `ProtectHome=read-only` + `ReadWritePaths=$COMIS_DATA_DIR`. This preserves the current `~comis/.comis` layout, still hides `/root` and other users' homes from the service, and lets the daemon write to its data directory. Alternatives considered and rejected: `ProtectHome=yes` (would require moving data to `/var/lib/comis` — out of scope) and `ProtectHome=tmpfs` + bind mount (more moving parts, no security benefit over read-only).

### 5.2 Environment file `/etc/comis/env`

```ini
# Generated by install.sh — edit via `sudoedit /etc/comis/env` then `systemctl restart comis`
COMIS_CONFIG_PATHS=/home/comis/.comis/config.yaml
NODE_ENV=production
# ANTHROPIC_API_KEY=...   # fill in after install
# OPENAI_API_KEY=...
```

Permissions: `0640`, owner `root:comis`. The installer does **not** write API keys — that's the user's job via `comis init` or hand-editing.

### 5.3 PM2 ecosystem

Already handled by `comis pm2 setup` (`packages/cli/src/commands/pm2.ts:56–89`). Installer just invokes it; no new template.

## 6. Upgrade Flow

Current upgrade path calls `restart_daemon_if_running` which uses `comis daemon stop && comis daemon start` (`install.sh:2371–2390`). This must now be aware of the service manager:

```
restart_service_if_running() {
    case "$(detect_active_manager)" in
        systemd)      maybe_sudo systemctl restart comis ;;
        systemd-user) systemctl --user restart comis ;;
        pm2)          pm2 restart comis ;;
        direct)       comis daemon stop && comis daemon start ;;
        none)         : ;;
    esac
}
```

`detect_active_manager` probes in order: `systemctl is-active comis` (system), `systemctl --user is-active comis`, `pm2 describe comis`, then PID-file check. First match wins.

On **upgrade**, the unit file may be older than the template. Strategy:

- Store a checksum of the rendered unit in `/etc/comis/.unit-version` (or as a `# comis-installer-version: X.Y.Z` header comment).
- On upgrade, if the on-disk unit's version differs from the installer's and the user hasn't modified it (compare against the known checksum), re-render. Otherwise skip and log a warning.
- Never overwrite a unit the user has manually edited. Detection: unit header comment `# managed-by: comis-installer; checksum: abc123`; if the file's current checksum != recorded checksum, assume user-edited.

## 7. Uninstall Flow

Full design lives in §14. Summary: `install.sh --uninstall` (and `comis uninstall` wrapper) reverses every installer-created artifact. Data under `~comis/.comis` is preserved unless `--purge` is also passed. The comis system user is preserved unless `--remove-user` is also passed.

## 8. Failure Modes & Diagnostics

| Condition                                           | Installer behavior                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| systemd unit fails to start                         | Dump `systemctl status comis --no-pager` + `journalctl -u comis -n 50`; exit non-zero                |
| Gateway health probe times out (15s) but unit active | Warn, print `journalctl -u comis -f` command, exit 0 (install succeeded, daemon may be slow)         |
| `pm2 startup` sudo denied                           | Warn, keep service running, suggest manual `sudo env PATH=… pm2 startup launchd` line                |
| Not root, user systemd not usable (no XDG_RUNTIME_DIR) | Fall back to `--service none`, print manual start instructions                                    |
| `COMIS_NODE_BIN` differs from `/usr/bin/node`       | Template uses the resolved absolute path; no PATH dependency in unit                                 |
| Daemon already running under a different manager    | Detect (detect_active_manager), stop it, migrate to new manager, warn user                           |

All diagnostic output goes through existing `ui_error` / `ui_warn` / `ui_info` helpers; no stderr pollution during normal flow.

## 9. CLI-Side Changes

These land alongside the installer rewrite but are separate commits.

### 9.1 `comis daemon` — add pm2 branch on macOS

`packages/cli/src/commands/daemon.ts` currently dispatches: systemd → direct spawn. Add a third probe:

```typescript
async function hasPm2Service(): Promise<boolean> {
  try {
    const { stdout } = await exec("pm2", ["jlist"], { timeout: 5_000 });
    return JSON.parse(stdout).some((p: { name: string }) => p.name === "comis");
  } catch {
    return false;
  }
}
```

Start/stop/status/logs then become:

```
systemd?  → systemctl
pm2?      → pm2
else      → direct spawn (existing code path)
```

This makes `comis daemon start` / `stop` / `status` / `logs` work transparently regardless of which supervisor the installer picked.

### 9.2 `comis pm2 setup` — add `--enable-boot`

Currently writes the ecosystem file only (`packages/cli/src/commands/pm2.ts:56–89`). Add `--enable-boot` flag that, after setup, runs `pm2 save` + `pm2 startup launchd` and prints the sudo line.

### 9.3 Delete or repurpose `packages/daemon/systemd/comis.service`

Options:
- **Delete**: installer generates it dynamically, no copy under version control to drift.
- **Keep as reference**: rename to `comis.service.template` with `@PLACEHOLDER@` variables, document that it's for reference only.

**Recommended:** keep as `.template`, have install.sh `sed`-substitute rather than carry an inline heredoc. Single source of truth, testable in isolation.

## 10. Testing Plan

| Test                                                                | Harness                                         |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| Linux root install → systemd unit rendered, enabled, active         | Docker: `debian:bookworm-slim` + systemd-in-Docker |
| Linux non-root install → user-scope unit + linger hint printed      | Docker: same image, `USER comis` layer          |
| macOS install → pm2 ecosystem + `pm2 list` shows comis as "online"  | GitHub Actions `macos-14` runner                |
| `--service none` → behaves identically to current installer         | Both runners                                    |
| Upgrade path → unit not overwritten if user-edited                  | Unit test with mock checksum                    |
| Uninstall path → service stopped, unit removed, daemon-reload       | Docker                                          |
| `install.sh --dry-run --service systemd` → prints commands, no writes | Shellcheck-style static test                  |

Extend `test/integration/` if there's a daemon-under-systemd integration path worth keeping in CI; otherwise these become standalone installer smoke tests under `website/public/test/` (new directory) or a top-level `installer/test/`.

## 11. Rollout

1. Land CLI-side changes first (§9). They are backward-compatible — `comis daemon` gains a pm2 branch, existing systemd/direct flows unchanged.
2. Land installer behind opt-in flag: `--service systemd` / `--service pm2`. Default stays `none` for one release.
3. Flip default to `--service auto` in the subsequent release.
4. Document the flag in `website/public/install.sh` `print_usage` and in `docs/get-started/`.

This avoids surprising existing CI pipelines that pipe the installer into bash in non-interactive mode — they'll continue to get today's behavior until they opt in, and can pin `--service none` forever if they want.

## 12. Resolved Decisions (previously open)

### 12.1 Node binary under version managers → reject for service mode

Version-manager paths (nvm, nodenv, fnm, volta) bake the Node version string into `ExecStart` and `--allow-fs-read`, which breaks the unit on every Node upgrade. Shims also aren't real binaries, so `ExecStart` needs a fully-resolved path.

**Decision:** service-managed Comis requires **system-installed Node**.

Implementation:
- During service-var templating, resolve `readlink -f "$(command -v node)"`.
- If the result contains `/.nvm/`, `/.nodenv/`, `/.fnm/`, or `/.volta/`, refuse systemd/pm2 mode with a clear error: *"Service-managed Comis requires system-installed Node. Run: `sudo apt-get install -y nodejs` (or equivalent) and re-run the installer."*
- `install_node` (already called as root pre-reexec) continues to install NodeSource/distro Node; extend it to prefer system Node over any pre-existing version-manager Node.
- Version-manager Node remains fully supported under `--service none`.

### 12.2 WSL systemd probe → two-stage check, silent fallback

**Decision:** treat WSL without systemd as `--service none` and print a one-line hint. Never attempt to enable WSL systemd automatically (requires Windows-side `wsl --shutdown`).

Probe:

```bash
has_systemd() {
    [[ -d /run/systemd/system ]] || return 1
    systemctl is-system-running --quiet 2>/dev/null
    local rc=$?
    # 0 = running, 1 = degraded (still OK); anything else = offline
    [[ $rc -eq 0 || $rc -eq 1 ]]
}
```

Fallback messaging:
- WSL detected (`[ -n "$WSL_DISTRO_NAME" ]`) → print: *"WSL detected without systemd. Enable it by adding `[boot]\nsystemd=true` to `/etc/wsl.conf` and running `wsl --shutdown`, then re-run the installer. Skipping service registration."*
- Otherwise (containers, unusual compat layers) → generic fallback hint, no WSL-specific guidance.

### 12.3 macOS without admin rights → two-phase pm2 setup

**Decision:** split pm2 wiring into a no-sudo phase and a sudo phase. Non-admin users still get a supervised daemon for the login session; only reboot persistence requires sudo.

**Phase A (always, no sudo):**
1. `npm install -g pm2` — if this fails with `EACCES`, prompt for sudo retry; if sudo unavailable, fall back to `--service none` (do **not** install pm2 into `~/.npm-global` for service use — creates a pm2 instance invisible to the default shell).
2. `comis pm2 setup`
3. `comis pm2 start`
4. `pm2 save`
5. Health probe (`localhost:4766/health`)

**Phase B (boot persistence, needs sudo):**
1. Probe: `sudo -n true` (passwordless) or interactive TTY + user in admin group.
2. If yes: run `sudo env PATH=$PATH pm2 startup launchd -u $USER --hp $HOME`.
3. If no: print the exact sudo line with instruction *"Run this later to enable boot persistence"*; exit 0 with Phase A already successful.

`--no-autostart` forces skipping Phase B.

### 12.4 Stale PID cleanup on migration → installer-side, unconditional

Migrating from direct-spawn to a service manager leaves `~/.comis/daemon.pid` pointing at an orphan process. `comis daemon stop` can't clean it because after registration `hasSystemd()` starts returning true and it tries `systemctl stop comis` instead.

**Decision:** add `cleanup_legacy_daemon_state` to the installer, called **before** service registration (and from the uninstall + manager-switch paths):

```bash
cleanup_legacy_daemon_state() {
    local pid_file="$COMIS_DATA_DIR/daemon.pid"
    [[ ! -f "$pid_file" ]] && return 0

    local pid
    pid=$(tr -d '[:space:]' < "$pid_file" 2>/dev/null)

    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        ui_info "Stopping direct-spawn daemon (PID $pid) before migrating to $SERVICE_MANAGER"
        kill -TERM "$pid" 2>/dev/null || true
        local waited=0
        while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 10 ]]; do
            sleep 1
            waited=$((waited + 1))
        done
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    fi

    rm -f "$pid_file"
    ui_success "Legacy daemon state cleared"
}
```

Rationale: only the installer knows a manager switch is happening; keeping this out of `comis daemon stop` preserves the CLI's single-owner assumption.

## 13. Summary of Files Touched

| File                                                | Change                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `website/public/install.sh`                         | New: service-manager abstraction, unit rendering, pm2 autostart wiring |
| `packages/daemon/systemd/comis.service`             | Rename → `comis.service.template`, parameterise paths                  |
| `packages/cli/src/commands/daemon.ts`               | Add `hasPm2Service()` probe; dispatch systemd / pm2 / direct            |
| `packages/cli/src/commands/pm2.ts`                  | Add `--enable-boot` flag to `setup`; `pm2 save` + `pm2 startup`         |
| `docs/operations/systemd.mdx`                       | Replace manual setup steps with "run the installer"; keep as reference for ops details |
| `docs/operations/pm2.mdx`                           | Same treatment                                                         |
| `docs/get-started/`                                 | Mention `--service` flag and what the default does on each OS          |
| `website/public/test/` (new)                        | Installer smoke tests (Docker + macOS)                                 |

## 14. Uninstall

Every installer-created artifact needs a reverse path. Without one, users who try the installer and change their mind must manually hunt down binaries, services, config files, and (on root installs) a system user. Uninstall ships in the same release as service registration.

### 14.1 Entry points

Two equivalent forms — the installer form works even if the CLI is broken:

```bash
# Via installer
curl -fsSL https://comis.ai/install.sh | bash -s -- --uninstall [flags]

# Via CLI (thin wrapper that re-invokes install.sh --uninstall)
comis uninstall [flags]
```

### 14.2 Flags

| Flag            | Effect                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `--uninstall`   | Remove binary + service registration. **Keeps data** (`~/.comis`, `/etc/comis`) by default.             |
| `--purge`       | Everything `--uninstall` does, plus delete `~/.comis` / `/etc/comis` / `/var/log/comis`.                |
| `--remove-user` | (Linux+root only) Also `userdel -r comis` and `groupdel comis`. Implies `--purge`.                      |
| `--yes`         | Skip interactive confirmation.                                                                          |
| `--dry-run`     | Print every action; perform none.                                                                       |

Default (no `--purge`) is deliberately conservative — a user can reinstall and keep their config, secrets, and agent memory.

Env equivalents: `COMIS_UNINSTALL=1`, `COMIS_PURGE=1`, `COMIS_REMOVE_USER=1`.

### 14.3 Execution order (reverse of install)

```
1. Confirm (unless --yes):
     "This will remove Comis from <path>, disable the systemd/pm2 service, and
      [--purge: delete ~/.comis and all agent data]. Continue? [y/N]"

2. Detect active service manager (detect_active_manager from §6), then:
     systemd      → maybe_sudo systemctl disable --now comis
                    maybe_sudo rm /etc/systemd/system/comis.service
                    maybe_sudo systemctl daemon-reload
                    maybe_sudo systemctl reset-failed comis || true
     systemd-user → systemctl --user disable --now comis
                    rm ~/.config/systemd/user/comis.service
                    systemctl --user daemon-reload
     pm2          → pm2 delete comis
                    pm2 save
                    sudo env PATH=$PATH pm2 unstartup launchd   # if admin
     direct       → reuse cleanup_legacy_daemon_state (§12.4) to kill + clear PID
     none         → nothing to do

3. Remove binary:
     npm install → npm uninstall -g comisai
     git install → rm ~/.local/bin/comis         # wrapper only
                   # leave the git checkout alone — user's own repo

4. Remove installer-written config files:
     maybe_sudo rm -f /etc/comis/env
     maybe_sudo rmdir /etc/comis 2>/dev/null || true   # only if empty

5. --purge only:
     rm -rf "$COMIS_HOME/.comis"
     maybe_sudo rm -rf /var/log/comis    # if it exists

6. --remove-user only (Linux+root):
     maybe_sudo userdel -r comis         # -r also removes home dir
     maybe_sudo groupdel comis 2>/dev/null || true

7. Final summary:
     list every path touched, every service unregistered, and — if data was
     preserved — the exact commands to delete it later.
```

### 14.4 Safety rails

| Rail                                                                                      | Rationale                                                                                |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Refuse `--remove-user` if other processes run as the `comis` user                         | User may have deployed their own code under that account. Probe: `pgrep -u comis -v -f 'comis\|node'`. |
| Never delete a systemd unit without the `managed-by: comis-installer` header (§6)         | User may have hand-written or heavily customized the unit. Warn and skip.                |
| Verify `~/.comis` ownership before `rm -rf`                                               | Guard against shared-machine mistakes.                                                   |
| Never auto-`npm uninstall -g` if the binary came from a linked dev checkout              | `npm ls -g comisai` → if `resolved: file:…`, use `npm unlink -g` instead.                |
| Ignore "not found" / "already stopped" errors                                             | Uninstall must be idempotent — running it twice must succeed with rc=0.                  |
| Do **not** auto-remove pm2 on macOS                                                       | Shared global tool; other apps may depend on it. Mention in summary only.                |

### 14.5 Edge cases

1. **Daemon mid-request** — systemd/pm2 stop paths use their built-in grace timeouts. Direct-spawn path reuses the 10-second graceful-then-kill sequence from `cleanup_legacy_daemon_state`.
2. **`--purge` on shared machines** — only touches the invoking user's `~/.comis`. For root-installed service mode, targets `~comis/.comis`. **No** `--purge-all` that sweeps every user — too dangerous; require manual cleanup for non-comis users.
3. **macOS pm2 leftovers** — launchd plist removed via `pm2 unstartup launchd`; pm2 binary itself is preserved and the summary prints the manual removal command.
4. **Log files under `/var/log/comis`** — preserved under plain `--uninstall`, removed under `--purge`. Summary lists them either way.
5. **Re-running `--uninstall` after partial failure** — every step is guarded by existence checks; second run cleans up whatever the first missed.

### 14.6 Testing

Extend the §10 test matrix:

| Test                                                                  | Harness                   |
| --------------------------------------------------------------------- | ------------------------- |
| Install → uninstall → verify no systemd unit, no binary, data kept    | Docker                    |
| Install → --purge → verify data gone, user preserved                  | Docker                    |
| Install → --remove-user → verify user gone, home gone                 | Docker                    |
| --uninstall run twice → second run is a no-op, rc=0                   | Docker                    |
| --uninstall with user-edited unit → skips deletion, warns             | Docker + fixture          |
| --remove-user blocked by unrelated process under `comis` user         | Docker + fixture          |
| macOS install → uninstall → pm2 entry gone, launchd plist gone        | GitHub Actions `macos-14` |
| --dry-run --uninstall → prints plan, touches nothing                  | Both runners              |

### 14.7 Files touched

Extends §13:

| File                                                | Change                                             |
| --------------------------------------------------- | -------------------------------------------------- |
| `website/public/install.sh`                         | Add `--uninstall`, `--purge`, `--remove-user` flags and `uninstall_main()` |
| `packages/cli/src/commands/uninstall.ts`            | **New:** `comis uninstall` wrapper that re-invokes `install.sh --uninstall` |
| `packages/cli/src/index.ts`                         | Register the new command                           |
| `docs/operations/`                                  | Add `uninstall.mdx` with the flag matrix           |

---

**End of design.**
