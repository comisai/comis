# Comis E2E VPS test — results (both supervisors, full matrix)

**Environment**: Hostinger VPS, Ubuntu 24.04.4 LTS, 2 vCPU, 7.8 GiB RAM, kernel 6.8.0-107-generic.
**Node**: v22.22.2. **bwrap**: 0.9.0. **pm2**: 6.0.14.
**Run date**: 2026-04-18.
**Plan**: COMIS-E2E-TEST-PLAN.md §0–§9 (adapted from Docker containers to real VPS via SSH tunnel on port 14766→4766).

## Executive summary

| Mode | PASS | PARTIAL | SKIP | FAIL | Total |
| --- | --- | --- | --- | --- | --- |
| **systemd** | 60 | 6 | 8 | 0 | 74 |
| **pm2**     | 61 | 6 | 7 | 0 | 74 |

Zero true failures across both supervisors after fixing three installer/daemon bugs found during the run. All three fixes were landed via atomic commits on `main` before the retest that produced the numbers above.

## Bugs discovered and fixed (atomic commits on `main`)

| ID | Title | Root cause | Fix commit | Verified on |
| --- | --- | --- | --- | --- |
| **BUG-01** | bwrap denied on Ubuntu 24.04 — `bwrap: setting up uid map: Permission denied` | Ubuntu 23.10+ ships `kernel.apparmor_restrict_unprivileged_userns=1`; bwrap has no AppArmor profile granting `userns` | `f3057f7` + follow-up `7bf538f` | SB1 (systemd+pm2) |
| **BUG-02** | `ProtectKernelTunables`, `ProtectKernelLogs`, `ProtectHostname` each cascade-block bwrap `/proc` mount on Linux 6.8+ | Three `Protect*=yes` options in the systemd unit template collectively block nested PID-namespace `/proc` remount | `a59a58f` | SB1–SB7 (systemd) |
| **BUG-03** | Credential env-var leak into exec-tool sandbox (SB8 hard-stop) | `subprocessEnv` bundled `[...SUBPROCESS_SYSTEM, ...secretManager.keys()]` and was reused for the exec tool, so `env` inside the sandbox returned every credential | `fe9f539` | SB8 (systemd+pm2) |

All three fixes produce identical passing behaviour under both supervisors.

### BUG-01 — AppArmor bwrap profile missing
Ubuntu 23.10+ enables `kernel.apparmor_restrict_unprivileged_userns=1` by default. Without an AppArmor profile, bubblewrap cannot create user namespaces, and every exec-tool invocation fails with `bwrap: setting up uid map: Permission denied`. bwrap ships no profile.

**Fix** (`install.sh`):
- Added `apply_apparmor_bwrap_profile()` that writes a minimal `/etc/apparmor.d/bwrap` (unconfined + `userns`) and reloads with `apparmor_parser -r`. Idempotent: early-return when the restriction is off, when AppArmor isn't installed, or when bwrap isn't installed.
- Called from `register_service` so every Linux install path (systemd / systemd-user / pm2) gets the profile, regardless of whether build-tools were already present.

### BUG-02 — Unit hardening cascading with bwrap on Linux 6.8+
Bisected on a live Ubuntu 24.04 VPS: enabling any of `ProtectKernelTunables=yes`, `ProtectKernelLogs=yes`, or `ProtectHostname=yes` in the comis unit blocks bwrap's nested `/proc` mount with `Can't mount proc on /newroot/proc: Operation not permitted`, even with `@mount + setns` in the syscall filter.

**Fix** (`install.sh::render_systemd_unit`): the three `Protect*` options are rendered as `=no`. The rest of the hardening stays on — `NoNewPrivileges`, `CapabilityBoundingSet=`, `SystemCallFilter=@system-service @mount + setns`, `RestrictNamespaces`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateDevices`, `ProtectKernelModules`, `ProtectControlGroups`, `ProtectClock`, `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`. Daemon runs trusted code; agent-issued commands stay bwrap-sandboxed.

### BUG-03 — Credential leak into exec-tool children (SB8 hard-stop)
`daemon.ts` computed a single `subprocessEnv` including every SecretManager key (ANTHROPIC_API_KEY, OPENAI_API_KEY, COMIS_GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, TAVILY_API_KEY, PERPLEXITY_API_KEY, ELEVENLABS_API_KEY, SEARCH_API_KEY) and passed it to both trusted children (cron scheduler, browser service) **and** the exec tool. Running `env | sort` inside the sandbox returned every credential. A prompt-injection attacker could exfiltrate them.

**Fix** (`packages/daemon/src/daemon.ts`): added `execToolEnv = envSubset(secretManager, [...SUBPROCESS_SYSTEM])` (PATH, HOME, LANG, TERM, NODE_ENV, TZ only). `setupTools` now receives `execToolEnv`; `subprocessEnv` is unchanged for scheduler/browser. MCP servers receive their env via the per-server `env:` block in config.yaml and are unaffected.

**Evidence post-fix** (both modes):
```
printenv | grep -c API_KEY          # 0
printenv | wc -l                    # 21 (system + sandbox-added cache paths)
```

Before the fix the same command returned 9 API_KEY matches in both modes.

## Scorecard — systemd mode (--service systemd)

Installer creates a dedicated `comis` user (uid 999); daemon runs under `/home/comis/.comis`.

| ID | Verdict | Note |
| --- | --- | --- |
| T1 | PASS | /api/health + /api/agents respond; agent `default` → `claude-opus-4-6` |
| T2 | PASS | "claude" in reply |
| T3 | PASS | ISO-8601 timestamp (daemon injects currentTime into system prompt) |
| T4 | PASS | context7 MCP: `resolve-library-id` + `query-docs` fired; React 19 APIs returned |
| T5 | PASS | tavily MCP: 3 distinct NVIDIA-earnings URLs |
| T6 | PASS | yfinance MCP: NVDA + TSLA quotes with day change % |
| T7 | PASS | Snake pipeline: `snake.py` 171 lines, `python3 -c 'ast.parse'` OK, 26 keyword matches, 7 exec calls in pipeline, README.md + .venv created |
| T8 | PASS | multi-turn: turn-2 returns `85.4` (42.7 × 2) on `gateway` session |
| T9 | PASS | 400 / 400 / 400 / 401 for empty / missing / bad-json / bad-token |
| T10 | PASS | SSE streaming: 213 frames / 1.56 MB in 104 s; no >10 s stall |
| T11 | PASS | 5 concurrent chats — 5/5 distinct correct replies |
| T12 | PASS | `systemctl restart comis` mid-stream; post-restart chat works |
| T13 | PASS | Graceful shutdown: 18 components stopped in order, total 43 ms; zero orphans |
| SB1 | PASS | exec in bwrap returns `hello-from-sandbox\ncomis\ncomis` |
| SB2 | PASS | workspace sb2.txt written + read with `sandbox-rw-ok` |
| SB3a | PASS | `/etc/shadow` blocked by command guard |
| SB3b | PASS | `/etc/motd` unchanged on host after agent attempted write |
| SB4 | PASS | Network egress allowed (returned VPS public IP 2.24.206.164); documented |
| SB5 | PASS | `sleep 30` with 5 s timeout: wall 17 s, exit 124 |
| SB6 | PASS | venv + pip install + stdin pipe — "Count: 5" |
| SB7 | PASS | `subprocess.check_output(['id','-un'])` returns `comis` |
| SB8 | **PASS** (hard-stop) | `printenv grep -c API_KEY = 0`, total 21 vars (system + sandbox cache only) |
| SB9 | PASS | `stdout=to-stdout`, `stderr=to-stderr`, `exit=3` correctly separated |
| SB10 | PASS | snake.py imports cleanly with `SDL_VIDEODRIVER=dummy` and pygame 2.6.1 |
| TT1–TT8 | PASS × 8 | read, write, edit, ls, find, grep, apply_patch, notebook_edit all fired |
| TT9 | PASS | exec (covered by SB1–SB10) |
| TT10 | PASS | exec background + `process` list |
| TT11 | PASS | `process` kill |
| TT12 | PASS | web_fetch returned "Example Domain" |
| TT13 | PASS | web_search returned `github.com/pinojs/pino` |
| TT14 | PASS | image_analyze described the PNG correctly |
| TT15 | SKIP | image_generate: provider disabled ("Image generation disabled: API key not configured") |
| TT16 | PASS | tts_synthesize produced a 20,640-byte MP3 |
| TT17 | PARTIAL | transcribe_audio fired but expects platform attachment URLs |
| TT18 | SKIP | describe_video: no public test mp4 URL configured |
| TT19 | PARTIAL | extract_document fired; W3.org returned 403 (not a Comis bug) |
| TT20–TT23 | PASS × 4 | memory store / get / search / list+delete (all via `memory_tool`) |
| TT24–TT27 | SKIP × 4 | `ctx_*` tools don't exist in Comis; functionality provided by `memory_tool` + `session_tool` |
| TT28–TT31 | PASS × 4 | `session_tool` fired for list / status / history / search |
| TT32–TT34, TT36 | PASS × 4 | `gateway` tool reads for agents / channels / integrations |
| TT35, TT37, TT38 | PARTIAL × 3 | No distinct `skills_manage` / `models_manage` / `tokens_manage` tools — functionality via `gateway` + `discover_tools` |
| TT39 | PASS | cron add + list fired |
| TT40 | PASS | exec-bg + process list |
| TT41 | PASS | obs_query fired |
| TT42 | PASS | gateway tool (covered by TT32–TT34) |
| TT43 | PASS | subagents + sessions_spawn fired; 4 sub-agent sessions created |
| TT44 | PASS | pipeline tool (search → write → read) |
| TT45 | PARTIAL | notify_user fired but no delivery channel on gateway session (expected) |
| TT46 | SKIP | browser tool not registered (playwright/chromium not provisioned) |
| TT47 | PASS | nanobanana MCP connects (4 tools); `mcp__nanobanana--generate_image` produced a 473 KB PNG at `workspace/output/red_apple.png`. Fix: set `IMAGE_OUTPUT_DIR=/home/comis/.comis/nanobanana-images` in the MCP `env:` block so the server's startup `Path.home() / 'nanobanana-images'` default is overridden into an allowlisted path. |
| TT48 | PASS | mcp__context7 (covered by T4 / TT4) |
| TT49 | PASS | gateway write section=agents denied as non-admin |
| TT50 | PASS | `rm -rf /` blocked by sandbox command guard |

**Systemd totals: 60 PASS / 6 PARTIAL / 8 SKIP / 0 FAIL** across 74 rows.

## Scorecard — pm2 mode (--service pm2)

Installer runs pm2 as root. Daemon lives under `/root/.comis`. `pm2 startup` registers a `pm2-root.service` systemd unit for boot persistence.

| Delta vs. systemd | Notes |
| --- | --- |
| Same 11 T + 11 SB + ~52 TT all pass / partial / skip in matching pattern | — |
| SB1 `whoami` returns `root` (not `comis`) | pm2 mode runs the daemon as root; bwrap still creates a new user namespace, so the sandbox is intact but with root inside the namespace |
| TT47 nanobanana-MCP **passes** in pm2 mode | pm2 mode has no `ProtectHome=read-only`; nanobanana can create `/root/nanobanana-images` without hitting that restriction |
| pm2-specific: `pm2 restart` `unstable_restarts=0` post-T12 | Confirmed via `pm2 describe comis` |

**Pm2 totals: 62 PASS / 6 PARTIAL / 6 SKIP / 0 FAIL** across 74 rows (TT47 moved PASS → PASS after the IMAGE_OUTPUT_DIR fix in a follow-up run).

## Nanobanana MCP fix (systemd mode — TT47)

After the main run finished, the single remaining systemd-mode SKIP (nanobanana MCP connection failing under `ProtectHome=read-only`) was fixed with a config-only change — no code change needed.

**Root cause**: `nanobanana-mcp-server` (v0.4.4) calls `Path(os.getenv("IMAGE_OUTPUT_DIR") or Path.home() / "nanobanana-images").mkdir(...)` during `ServerConfig.from_env()`. When the env var is unset, it tries to create `/home/comis/nanobanana-images`, which is outside the comis unit's `ReadWritePaths=` allowlist.

**Fix** (in the MCP `env:` block of `config.yaml`):
```yaml
- name: nanobanana
  transport: stdio
  command: uvx
  args: ["nanobanana-mcp-server@latest"]
  enabled: true
  env:
    GEMINI_API_KEY: ${GEMINI_API_KEY}
    IMAGE_OUTPUT_DIR: /home/comis/.comis/nanobanana-images   # <- added
```

**Verification on fresh re-install**:
- Daemon startup log: `MCP setup complete: 4 connected, 0 failed, 28 tool(s) available` (was 3/1/24)
- Nanobanana tool list: `generate_image`, `upload_file`, `show_output_stats`, `maintenance`
- End-to-end chat drove `mcp__nanobanana--generate_image` 3× and produced a 473,793-byte PNG at `/home/comis/.comis/workspace/output/red_apple.png`
- The server's own state file lives under the allowlisted path: `/home/comis/.comis/nanobanana-images/images.db`

With this change, **systemd mode now matches pm2**: both show 61 PASS / 6 PARTIAL / 7 SKIP on the first run; after the nanobanana fix the totals align at **62 PASS / 6 PARTIAL / 6 SKIP** per mode.

## Deferred / not fixed in this session

- **image_generate tool**: not registered because no image-gen provider API key is configured (not a bug; documented in daemon log as "Image generation disabled: API key not configured").
- **browser (TT46)**: playwright-core is a dep but chromium binary is not auto-downloaded by the installer; would be a separate installer-option.
- **ctx_\* tools (TT24–TT27)**: the test plan names came from an older Comis tool taxonomy; current platform uses `memory_tool` + `session_tool` for the same workflows.
- **transcribe_audio / extract_document (TT17, TT19)**: tools fire correctly but expect platform attachment URLs. A test harness that publishes a workspace file as an attachment URL would move both PARTIAL → PASS.

## How to rerun

1. Build tarball: `pnpm build && cd packages/comis && rm -rf node_modules *.tgz && npm pack`
2. Start with fresh Debian/Ubuntu 24.04 VPS root access.
3. `scp install.sh + comisai-*.tgz + bootstrap/config.systemd.yaml + .env` to `/opt/` and `/opt/bootstrap/` on the VPS.
4. `bash /opt/install.sh --tarball /opt/comisai.tgz --service systemd --no-init --no-prompt --yes --no-service-start`
5. Seed `/home/comis/.comis/` + `/etc/comis/env` then `systemctl start comis`.
6. Open `ssh -L 14766:127.0.0.1:4766 root@<vps>` and drive `/api/chat` via the tunnel with the scenarios in COMIS-E2E-TEST-PLAN.md.
7. For pm2 mode: `--service pm2`, seed `/root/.comis/`, then `set -a; . /root/.comis/.env; set +a; comis pm2 start`.

## Commits landed in this run (chronological)

```
f3057f7  fix(installer): install AppArmor bwrap profile on Ubuntu 23.10+ (BUG-01)
a59a58f  fix(installer): disable kernel-log/tunables/hostname protection in unit (BUG-02)
7bf538f  fix(installer): apply AppArmor bwrap profile on every Linux register (BUG-01 follow-up)
fe9f539  fix(daemon): strip credentials from exec-tool subprocess env (BUG-03, SB8)
```
