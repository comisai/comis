# Comis end-to-end agent test plan (Docker-fresh, gateway API → real Anthropic agent)

**Audience:** a fresh Claude Code session with **no prior conversation memory**. Every path, flag, file, token, and assertion you need is in this document.

**Goal:** simulate a fresh-Linux-VPS install of Comis under **two supervisor modes** (systemd *and* pm2) in a clean Debian Docker container from a local `.tgz`, wire it to the user's real Anthropic API key, then drive a realistic conversation through the gateway HTTP API — including tool use, MCP integrations, a multi-step code-generation pipeline (Snake in Python), and the bubblewrap-based exec sandbox. After each scenario, deeply audit daemon/pm2 logs + every agent session JSONL, find bugs, fix them, and rerun until the full set passes under *both* supervisors.

**Why this matters:** a real user's first experience is either `--service auto` (resolves to systemd on Linux root) or `--service pm2` (chosen by users who want live reload and familiar tooling). Both must produce a working daemon with a working exec sandbox. Testing only one hides half the installer.

> **Hard rule #1 — self-contained**: if you find yourself needing information that is not in this file, treat that as a bug in the plan and extend it before proceeding.
>
> **Hard rule #2 — all code changes go through `/gsd-quick`**: every code fix, every code implementation, every config change that touches the repo — even a one-line typo — is written via the `/gsd-quick` slash command. `/gsd-quick` is non-negotiable because it guarantees (a) atomic commit per change, (b) state-tracking in `.planning/`, (c) a post-fix validation hook. Manual `git add && git commit` is forbidden for code changes made in response to a test failure. Plan docs, audit notes, and `/tmp/comis-e2e/…` artifacts are the only things that may be edited outside `/gsd-quick`.
>
> **Hard rule #3 — every fix commits before you move on**: no uncommitted work leaves a test cycle. If `/gsd-quick` did not commit (e.g. build failed and you stopped to debug), treat the branch as dirty, do not run the next scenario until you either finish the commit or revert the change. "I'll commit everything at the end" is banned — it hides which change broke which scenario.

---

## 0. One-page summary

| Item                 | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| Repo                 | `/Users/mosheanconina/Projects/comisai/comis`                        |
| User config on host  | `/Users/mosheanconina/.comis/config.yaml` (`"${COMIS_GATEWAY_TOKEN}"` etc.) |
| User env on host     | `/Users/mosheanconina/.comis/.env`                                   |
| Local tarball        | `packages/comis/comisai-1.0.3.tgz` (rebuild per §2.1)                |
| Installer under test | `website/public/install.sh`                                          |
| Docker image (VPS sim) | `comis-test-vps` — **base Debian, no preinstalled Node** (§2.2)   |
| Docker image (fast)  | `comis-test-systemd` — Debian with build tools preinstalled (§2.2)   |
| Container names      | `comis-e2e-systemd`, `comis-e2e-pm2` (one per supervisor mode)       |
| Gateway URL          | `http://127.0.0.1:4766/api` (mapped from container to host loopback) |
| Gateway bearer token | the `COMIS_GATEWAY_TOKEN` value inside `.env` (see §2.3)              |
| Agent id             | `default` (aka `my-agent` in config)                                 |
| Agent model          | Anthropic, `default` (resolves to Claude Opus 4.6 at time of writing)|
| Workspace root       | `~/.comis/workspaces/` (sessions, graph-runs live here; `~` = service user's home) |
| Session JSONL path   | `~/.comis/workspaces/<workspace>/sessions/default/gateway/default.jsonl` |
| Daemon journal       | systemd: `journalctl -u comis` · pm2: `pm2 logs comis --nostream`    |
| Daemon file log      | `~/.comis/daemon.log` and `~/.comis/logs/` (both modes)              |
| pm2 log files        | `~/.pm2/logs/comis-out.log` + `~/.pm2/logs/comis-error.log`          |

**Supervisor matrix — every scenario runs under BOTH modes:**

| Mode                  | Service user          | `~/.comis` lives under | Logs fetched via                                | Restart cmd                       |
| --------------------- | --------------------- | ---------------------- | ----------------------------------------------- | --------------------------------- |
| `--service systemd`   | dedicated `comis` user | `/home/comis/.comis`  | `journalctl -u comis --no-pager -n 200`         | `systemctl restart comis`         |
| `--service pm2` on Linux | invoking user (root in container) | `/root/.comis` | `pm2 logs comis --nostream --lines 200`         | `pm2 restart comis`               |

**User config — key facts that the test must respect:**

- Primary agent: `default` named `my-agent`, Anthropic provider, `model: default`
- `elevatedReply` enabled: sender id `"678314278"` is admin
- Gateway `127.0.0.1:4766`, token `${COMIS_GATEWAY_TOKEN}` with scope `*`
- MCP servers configured: **context7**, **tavily** (`${TAVILY_API_KEY}`), **nanobanana** (`${GEMINI_API_KEY}`), **yfinance**
- Channel: **telegram** enabled with token `${TELEGRAM_BOT_TOKEN}`, allowFrom `["678314278"]`

**What must be changed for Docker testing (see §2.3):**

- Telegram must be **disabled** in the container config — we don't want to contact the real Telegram API from an ephemeral container, and the bot will drop its polling webhook if a second instance tries to steal it.
- `dataDir` stays under `/home/comis/.comis` (default), **not** the host path.
- Leave MCP servers enabled — they're exactly what we want to exercise (context7 for docs, tavily for web search, nanobanana for image gen, yfinance for stock data).

---

## 1. Prerequisites on the host

1. Docker Desktop running (`docker version` must answer).
2. Fresh checkout of this repo at `/Users/mosheanconina/Projects/comisai/comis` (branch `main` with installer + daemon changes from the prior Claude Code session — if you see neither `website/public/install.sh` `--tarball` flag nor `register_service_systemd`, the codebase is pre-redesign; **stop and re-run the installer redesign first**; see `INSTALLER-SERVICE-REDESIGN.md` and `INSTALLER-TEST-PLAN.md`).
3. `pnpm install && pnpm build` has succeeded at least once (native modules compiled for the host).
4. The Docker image `comis-test-systemd` exists, or can be built from `/tmp/comis-installer-test/Dockerfile.systemd` (see §2.2).
5. The user's `~/.comis/config.yaml` and `~/.comis/.env` exist and have real API keys (see §0). **Do not print the contents of `.env` to the console or commit it.**

---

## 2. Stage the test environment

### 2.1 Build the tarball

```bash
cd /Users/mosheanconina/Projects/comisai/comis
pnpm build
cd packages/comis
rm -rf node_modules            # prevents pnpm-symlink pollution inside the tgz
rm -f comisai-1.0.3.tgz
npm pack                        # runs prepack.js → writes comisai-1.0.3.tgz
tar tzf comisai-1.0.3.tgz | grep -E "node_modules/@comis/daemon/dist/daemon\.js$" \
    && echo "tarball OK" || { echo "tarball missing daemon.js"; exit 1; }
```

A valid tarball is ~2.4MB and lists 2,300+ files. If `pnpm pack` is used instead of `npm pack`, it will error: `bundledDependencies does not work with node-linker=isolated`. Use `npm pack`.

### 2.2 Docker images

Two images, for two different test goals:

**(a) `comis-test-vps` — fresh VPS simulation.** Nothing but systemd, curl, and CA certs. This is what a $5/month Hetzner Debian 12 droplet looks like minutes after first boot. The installer has to bootstrap *everything* (Node, build tools, pm2, bubblewrap). Use this for the canonical single-scenario install run per mode.

Dockerfile (save as `/tmp/comis-installer-test/Dockerfile.vps`):
```dockerfile
FROM debian:bookworm-slim
# Minimum that every VPS provider gives you by default: systemd + network tools.
# Everything else must be installed by install.sh.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus \
        curl ca-certificates iproute2 && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*
RUN find /etc/systemd/system /lib/systemd/system \
      \( -path '*getty*' -o -path '*wants/*.timer' -o -name 'systemd-udev*' \
         -o -name 'systemd-journal-flush*' \) -delete 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
```

**(b) `comis-test-systemd` — fast-iteration image.** Already has Node build toolchain baked in so you can rerun the matrix without re-installing apt packages every time.

Dockerfile (`/tmp/comis-installer-test/Dockerfile.systemd`):
```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus \
        curl ca-certificates sudo procps less iproute2 \
        python3 python3-venv python3-pip make g++ libsystemd-dev \
        bubblewrap ffmpeg git && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*
RUN find /etc/systemd/system /lib/systemd/system \
      \( -path '*getty*' -o -path '*wants/*.timer' -o -name 'systemd-udev*' \
         -o -name 'systemd-journal-flush*' \) -delete 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
```

Build both:
```bash
cd /tmp/comis-installer-test
DOCKER_BUILDKIT=0 docker build -f Dockerfile.vps     -t comis-test-vps .
DOCKER_BUILDKIT=0 docker build -f Dockerfile.systemd -t comis-test-systemd .
```

> **Run-mode for this plan:** run the **first full matrix under `comis-test-vps`** to prove a genuine fresh-VPS path (installer must pull Node + bubblewrap + libsystemd-dev etc. from scratch). Use `comis-test-systemd` for subsequent fix-and-rerun iterations — it cuts each cycle from ~8 min to ~3 min.

### 2.3 Container-specific config + secrets

Write a container-only copy of config.yaml that disables Telegram and points `dataDir` at the service user's home:

```bash
mkdir -p /tmp/comis-e2e
cat > /tmp/comis-e2e/config.yaml <<'YAML'
logLevel: debug
dataDir: /home/comis/.comis
agents:
  default:
    name: my-agent
    provider: anthropic
    model: default
    elevatedReply:
      enabled: true
      senderTrustMap:
        "678314278": admin
security:
  agentToAgent:
    subAgentSessionPersistence: true
gateway:
  enabled: true
  host: 0.0.0.0                # bind inside container; docker -p maps to host 127.0.0.1
  port: 4766
  tokens:
    - id: default
      secret: ${COMIS_GATEWAY_TOKEN}
      scopes: ["*"]
integrations:
  mcp:
    servers:
      - name: context7
        transport: stdio
        command: npx
        args: ["-y", "@upstash/context7-mcp"]
        enabled: true
      - name: tavily
        transport: stdio
        command: npx
        args: ["-y", "tavily-mcp@0.1.2"]
        enabled: true
        env:
          TAVILY_API_KEY: ${TAVILY_API_KEY}
      - name: nanobanana
        transport: stdio
        command: uvx
        args: ["nanobanana-mcp-server@latest"]
        enabled: true
        env:
          GEMINI_API_KEY: ${GEMINI_API_KEY}
      - name: yfinance
        transport: stdio
        command: npx
        args: ["-y", "yfinance-mcp-ts@1.0.4"]
        enabled: true
channels: {}                  # <-- Telegram disabled for container tests
YAML

# Copy .env verbatim (contains the real keys)
cp /Users/mosheanconina/.comis/.env /tmp/comis-e2e/.env

# Host-side token — read from the .env so tests don't hardcode secrets
export COMIS_GATEWAY_TOKEN="$(grep '^COMIS_GATEWAY_TOKEN=' /tmp/comis-e2e/.env | cut -d= -f2-)"
```

**Security note:** the .env contains live Anthropic/OpenAI/Tavily/Gemini keys. The temp dir is mode 0700 by default on macOS — if not, `chmod 700 /tmp/comis-e2e`. Never commit this directory.

---

## 3. Launch + install — run both modes

**Baseline image choice**: use `comis-test-vps` for the first full pass of each mode (exercises full bootstrap); switch to `comis-test-systemd` for fix-and-rerun cycles.

### 3A. Systemd mode (`--service systemd`)

```bash
export BASE_IMAGE="${BASE_IMAGE:-comis-test-vps}"    # or comis-test-systemd
export CN=comis-e2e-systemd
docker rm -f "$CN" 2>/dev/null || true

docker run -d --name "$CN" \
    --privileged \
    --tmpfs /run --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -p 127.0.0.1:4766:4766 \
    -v "$(realpath /Users/mosheanconina/Projects/comisai/comis/website/public/install.sh):/opt/install.sh:ro" \
    -v "$(realpath /Users/mosheanconina/Projects/comisai/comis/packages/comis/comisai-1.0.3.tgz):/opt/comisai.tgz:ro" \
    -v /tmp/comis-e2e/config.yaml:/opt/bootstrap/config.yaml:ro \
    -v /tmp/comis-e2e/.env:/opt/bootstrap/.env:ro \
    "$BASE_IMAGE"

until docker exec "$CN" systemctl is-system-running --wait 2>/dev/null | grep -qE '(running|degraded)'; do sleep 1; done

docker exec "$CN" bash -c '
set -euo pipefail
# Installer creates the comis user, pulls Node, installs the CLI, registers the
# systemd unit. --no-service-start lets us seed config + env before starting.
bash /opt/install.sh \
    --tarball /opt/comisai.tgz \
    --service systemd \
    --no-init --no-prompt --yes \
    --no-service-start

install -o comis -g comis -m 0700 -d /home/comis/.comis
install -o comis -g comis -m 0600 /opt/bootstrap/config.yaml /home/comis/.comis/config.yaml
install -o comis -g comis -m 0600 /opt/bootstrap/.env        /home/comis/.comis/.env
install -o root  -g comis -m 0640 /opt/bootstrap/.env        /etc/comis/env
systemctl start comis
'

# Wait up to 90s (fresh VPS may be compiling sd-notify from source)
for i in $(seq 1 90); do
  docker exec "$CN" systemctl is-active comis 2>/dev/null | grep -q active && break
  sleep 1
done
docker exec "$CN" systemctl is-active comis | grep -q active \
  && echo "systemd daemon active" \
  || { echo "systemd daemon did not start"; docker exec "$CN" systemctl status comis --no-pager; exit 1; }

curl -fsS http://127.0.0.1:4766/api/health
```

### 3B. pm2 mode (`--service pm2`)

**Key differences from systemd mode:** runs as root (no dedicated user created per §7 of the installer redesign), pm2 is installed via `npm install -g pm2`, `pm2 startup` on Linux registers a pm2-resurrect systemd unit, container must still have systemd so that `pm2 startup` can install its bootstrap hook.

```bash
export BASE_IMAGE="${BASE_IMAGE:-comis-test-vps}"
export CN=comis-e2e-pm2
docker rm -f "$CN" 2>/dev/null || true

docker run -d --name "$CN" \
    --privileged \
    --tmpfs /run --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -p 127.0.0.1:4766:4766 \
    -v "$(realpath /Users/mosheanconina/Projects/comisai/comis/website/public/install.sh):/opt/install.sh:ro" \
    -v "$(realpath /Users/mosheanconina/Projects/comisai/comis/packages/comis/comisai-1.0.3.tgz):/opt/comisai.tgz:ro" \
    -v /tmp/comis-e2e/config.yaml:/opt/bootstrap/config.yaml:ro \
    -v /tmp/comis-e2e/.env:/opt/bootstrap/.env:ro \
    "$BASE_IMAGE"

until docker exec "$CN" systemctl is-system-running --wait 2>/dev/null | grep -qE '(running|degraded)'; do sleep 1; done

docker exec "$CN" bash -c '
set -euo pipefail
# Install WITHOUT service-start so we can seed root-user config first
bash /opt/install.sh \
    --tarball /opt/comisai.tgz \
    --service pm2 \
    --no-init --no-prompt --yes \
    --no-service-start

# pm2 mode: service user is the invoking user (root here). dataDir lives under /root/.comis.
install -m 0700 -d /root/.comis
install -m 0600 /opt/bootstrap/.env        /root/.comis/.env

# Container config needs dataDir adjusted for pm2 mode
sed "s|dataDir: /home/comis/.comis|dataDir: /root/.comis|" /opt/bootstrap/config.yaml > /root/.comis/config.yaml
chmod 0600 /root/.comis/config.yaml

# Load env vars into pm2s runtime (pm2 setup wrote an ecosystem.config.js that reads COMIS_CONFIG_PATHS;
# other secrets must be in the shell env when pm2 starts the process).
set -a; . /root/.comis/.env; set +a
# pm2 inherits env from the shell that runs pm2 start
comis pm2 start
'

# Wait for daemon readiness
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4766/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:4766/api/health \
  && echo "pm2 daemon active" \
  || { echo "pm2 daemon did not start"; docker exec "$CN" pm2 logs comis --nostream --lines 60; exit 1; }
```

### 3C. Baseline assertions — run against BOTH containers after install

```bash
for CN in comis-e2e-systemd comis-e2e-pm2; do
  echo "=== $CN ==="
  # 1. Daemon binary is running as the expected user
  docker exec "$CN" ps -eo user,comm | grep 'node' | head
  # 2. ~/.comis structure exists
  docker exec "$CN" bash -c '
    home=$(eval echo ~$(ps -eo user,comm | awk "/node/ {print \$1; exit}"))
    ls -la "$home/.comis" 2>&1 | head -8'
  # 3. Memory DB was created
  docker exec "$CN" bash -c 'find / -name memory.db 2>/dev/null | head -3'
  # 4. Bubblewrap is on PATH (required for exec sandbox)
  docker exec "$CN" bash -c 'command -v bwrap && bwrap --version'
done
```

If any baseline fails, do NOT proceed to §5 scenarios — fix before running tests. Common breakage: bubblewrap missing on the VPS image means the installer didn't pull it (check `install_build_tools_linux`'s apt list includes `bubblewrap`).

---

## 4. Gateway chat API — reference

Throughout the tests, use these helpers (set up once in the host shell after §2.3):

```bash
GW="http://127.0.0.1:4766"
AUTH="Authorization: Bearer ${COMIS_GATEWAY_TOKEN}"
CT="Content-Type: application/json"

# Synchronous chat — returns agent's reply text + token usage
chat() {
  local message="$1"
  local session_key="${2:-}"
  local body
  body=$(jq -n --arg m "$message" --arg s "$session_key" \
        '{ message: $m, agentId: "default" } + (if $s == "" then {} else {sessionKey: $s} end)')
  curl -sS -X POST "$GW/api/chat" -H "$AUTH" -H "$CT" -d "$body"
}

# Streaming chat (SSE) — use for long-running tasks so you can watch progress
chat_stream() {
  local message="$1"
  curl -sN -G "$GW/api/chat/stream" -H "$AUTH" \
       --data-urlencode "message=$message" \
       --data-urlencode "agentId=default"
}

# All-events firehose — tail in a side terminal while tests run
events_tail() {
  curl -sN -H "$AUTH" "$GW/api/events"
}
```

Endpoints (all prefixed `/api`):

| Path           | Method | Auth | Purpose                                      |
| -------------- | ------ | ---- | -------------------------------------------- |
| `/api/health`  | GET    | —    | Liveness                                     |
| `/api/chat`    | POST   | Y    | Synchronous chat; body `{message, agentId?, sessionKey?}` |
| `/api/chat/stream` | GET | Y    | SSE stream of the same conversation         |
| `/api/events`  | GET    | Y    | SSE firehose of all daemon events            |
| `/api/agents`  | GET    | Y    | List configured agents                       |
| `/api/activity`| GET    | Y    | Ring-buffer of recent events                 |

Auth: `Authorization: Bearer <token>` only — tokens must not be passed as query params.

---

## 5. Test scenarios — execution + assertions

Each scenario has four parts:
1. **Setup:** any state to establish
2. **Action:** exact commands to run
3. **Expected:** what a correct daemon produces
4. **Audit:** which logs/files to read (see §6 for paths), and what to look for

**Run the whole matrix twice** — once with `CN=comis-e2e-systemd`, once with `CN=comis-e2e-pm2`. Same gateway URL, same helpers; the supervisor is transparent to the HTTP API. Differences are in log-read commands, which are split out in §6.

**Before starting, open three side panes. Use the SYSTEMD_MODE variable to pick the right log-source:**

```bash
# Pick the supervisor we're testing this round
export CN=comis-e2e-systemd        # or comis-e2e-pm2

# Pane A — SSE events firehose (same for both modes)
curl -sN -H "$AUTH" "$GW/api/events" | tee /tmp/comis-e2e/events.log

# Pane B — daemon log follow (mode-specific)
if [[ "$CN" == *systemd* ]]; then
  docker exec "$CN" journalctl -u comis -f --no-pager | tee /tmp/comis-e2e/journal.log
else
  docker exec "$CN" pm2 logs comis --raw | tee /tmp/comis-e2e/pm2-stream.log
fi

# Pane C — session JSONL tail (populated after first message)
docker exec "$CN" bash -c '
  find / -name "*.jsonl" -path "*/sessions/*" 2>/dev/null | head -5'
```

### T1 — Health & readiness

**Action:**
```bash
curl -fsS "$GW/api/health" | jq .
curl -fsS -H "$AUTH" "$GW/api/agents" | jq .
```
**Expected:** `status: ok`; `agents[].id == "default"`, `agents[].model` resolves to an Anthropic Opus identifier.
**Audit:** journal shows `Comis daemon started` with `configPaths: ["/home/comis/.comis/config.yaml"]`; no `errorKind` entries.

### T2 — Simple hello (sanity, no tools)

**Action:**
```bash
chat "Hello. In one short sentence, say hi back and confirm you are claude." | tee /tmp/comis-e2e/T2.json | jq .
```
**Expected:** `response` is a short English sentence; `tokensUsed.total` 10–200; HTTP 200.
**Audit:**
- Session JSONL: one user event + one assistant event (no tool calls); `timestamps` strictly increasing.
- Journal: one `INFO` line per boundary — request received, execution complete; no `ERROR`/`WARN`.

### T3 — Tool use via built-in (time/clock) — smoke-test the tool runtime

**Action:**
```bash
chat "What is the current UTC time? Use a tool if available; do not guess." | tee /tmp/comis-e2e/T3.json | jq .
```
**Expected:** response contains a plausible ISO-8601 timestamp within ±60s of `date -u`. Token usage includes an `output` span with tool calls.
**Audit:**
- Session JSONL contains a `tool_use` block with `name` pointing at the time/system tool and a `tool_result` echoed back.
- No `errorKind: "tool_execution"` in journal.

### T4 — MCP: context7 (library docs)

**Action:**
```bash
chat "Using the context7 MCP tool, fetch the latest React 19 concurrent rendering docs and summarise in 3 bullet points." | tee /tmp/comis-e2e/T4.json | jq .
```
**Expected:** reply mentions specific React 19 APIs (e.g. `useTransition`, `use()`); session JSONL shows tool calls whose name is prefixed with `mcp__context7__`.
**Audit:**
- Journal has `INFO` lines from the MCP client connecting to `context7`, no repeated reconnects.
- If the MCP server fails to spawn (`npx -y @upstash/context7-mcp`), the journal will have `errorKind: "mcp_spawn"` — fix before continuing.

### T5 — MCP: Tavily web search

**Action:**
```bash
chat "Search the web via Tavily for the top 3 news stories from the last 48 hours about NVIDIA earnings. Return URLs." | tee /tmp/comis-e2e/T5.json | jq .
```
**Expected:** 3 distinct URLs; tool calls named `mcp__tavily__*`.
**Audit:** `TAVILY_API_KEY` must have been loaded — check `systemctl show comis -p Environment --value` for the key (masked) or inspect the MCP child's env via `ps auxe`. A missing key manifests as a `401` in the tool_result JSONL.

### T6 — MCP: yfinance (stock quote)

**Action:**
```bash
chat "Using yfinance, fetch the current NVDA and TSLA quotes and compare their day's change percent." | tee /tmp/comis-e2e/T6.json | jq .
```
**Expected:** two numeric quotes in the reply; JSONL tool_use → `mcp__yfinance__*`.

### T7 — Sub-agent pipeline (Snake in Python)

This is the headline test. Creates a multi-file deliverable via sub-agent orchestration.

**Action:**
```bash
chat_stream "
Create a complete, playable Snake game in Python using pygame.
Requirements:
 - Single file, snake.py
 - Use standard arrow keys
 - Scoreboard in the top-left
 - Game-over screen with restart (press R)
 - A README.md explaining how to run it (pip install pygame; python snake.py)
 - Inline comments on all non-obvious logic

Write the files into an agent workspace, then run flake8 on snake.py if available.
Report the workspace path when done.
" | tee /tmp/comis-e2e/T7.sse
```

**Expected:**
- Response references a workspace under `/home/comis/.comis/workspaces/...`
- Both `snake.py` and `README.md` exist inside that workspace with non-trivial content
- `snake.py` uses `pygame`, has a `while` loop, keys handler, collision logic
- The agent MAY spawn a sub-agent (e.g. coding-agent) — session JSONL for the sub-agent is persistent (`subAgentSessionPersistence: true`)

**Audit (most important test):**
```bash
# 1. Find the workspace
WS=$(docker exec comis-e2e bash -c "ls -dt /home/comis/.comis/workspaces/*/ 2>/dev/null | head -1")
echo "Workspace: $WS"
docker exec comis-e2e ls "$WS"

# 2. Verify files exist and have real content
docker exec comis-e2e wc -l "${WS}snake.py" "${WS}README.md"
docker exec comis-e2e head -40 "${WS}snake.py"

# 3. Syntax-check
docker exec comis-e2e python3 -c "import ast; ast.parse(open('${WS}snake.py').read())" \
    && echo "snake.py parses" || echo "SYNTAX ERROR"

# 4. All session JSONLs for this run — main + sub-agents
docker exec comis-e2e find /home/comis/.comis -name "*.jsonl" -newer /tmp -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -20
# For each, check: no truncated JSON lines; final event has non-error finishReason

# 5. Graph-runs directory — persistent pipeline state
docker exec comis-e2e ls /home/comis/.comis/graph-runs/ | head
docker exec comis-e2e bash -c 'cat $(ls -t /home/comis/.comis/graph-runs/*.json 2>/dev/null | head -1)' | jq '.status, .nodes | length'
```

**Bugs to watch for:**
- Agent writes to `/tmp` instead of the workspace → `--allow-fs-write` in the unit is too narrow
- Python not available to the agent → workspace-exec tool config issue
- Sub-agent session JSONL truncated mid-line → indicates a pino/fs-sync bug on shutdown
- Game contains only a stub (`pass`) → model output was clipped; check `tokensUsed.output` hit `max_tokens`

### T-SB — Exec sandbox validation (bubblewrap)

The exec tool runs every user-requested command inside a **bubblewrap** (`bwrap`) sandbox. This is Comis's primary defence against an agent-induced RCE via malicious tool-use. These tests verify that (a) the sandbox actually activates, (b) it grants the agent what it needs, and (c) it blocks what it must block. If bubblewrap is missing or the sandbox is inert, every one of these tests fails.

**Prerequisite baseline (run once per supervisor):**
```bash
# 1. bubblewrap is installed and callable
docker exec "$CN" bwrap --version
# 2. The service user can invoke it (systemd: comis; pm2: root)
docker exec "$CN" bash -c 'id $(ps -eo user,comm | awk "/node/ {print \$1; exit}")'
# 3. /proc/self/status of a sandboxed process should show dropped capabilities —
#    we'll verify this from inside a tool call in SB1
```

#### SB1 — Basic exec: `echo` inside sandbox returns stdout

**Action:**
```bash
chat "Run the shell command 'echo hello-from-sandbox && whoami && id' and report the exact output." | tee /tmp/comis-e2e/SB1.json | jq -r .response
```
**Expected:** response contains `hello-from-sandbox`. `whoami` prints the service user name (comis / root). `id` shows that user's uid.
**Audit:**
- Session JSONL contains a `tool_use` of the exec tool and a `tool_result` whose body matches stdout.
- Journal: no `errorKind: "sandbox_spawn"`, no `bwrap: ...` warnings.

#### SB2 — Workspace visibility: agent can read+write files it just wrote

**Action:**
```bash
chat "Inside your workspace, create a file note.txt with the text 'sandbox-rw-ok', then read it back with cat and report the contents." | tee /tmp/comis-e2e/SB2.json | jq -r .response
```
**Expected:** response contains `sandbox-rw-ok`.
**Audit:**
```bash
WS=$(docker exec "$CN" bash -c 'ls -dt $(eval echo ~$(ps -eo user,comm | awk "/node/ {print \$1; exit}"))/.comis/workspaces/*/ 2>/dev/null | head -1')
docker exec "$CN" cat "${WS}note.txt"
# Must print "sandbox-rw-ok"
```

#### SB3 — Filesystem escape — DENY

Three things that should all fail inside the sandbox:

**Action 1 — read /etc/shadow:**
```bash
chat "Run: cat /etc/shadow | head -2 — and report stdout, stderr, exit code verbatim." | tee /tmp/comis-e2e/SB3a.json | jq -r .response
```
**Expected:** tool_result shows exit code != 0; stderr mentions `Permission denied` (or the file is invisible inside the bwrap mount namespace).

**Action 2 — write to /etc:**
```bash
chat "Run: bash -c 'echo pwn > /etc/motd' — report exit code and stderr." | tee /tmp/comis-e2e/SB3b.json
```
**Expected:** non-zero exit; stderr `Read-only file system` or `Permission denied`.

**Action 3 — escape workspace via .. :**
```bash
chat "Run: ls /home | head; ls /root | head; ls / | head — and report output." | tee /tmp/comis-e2e/SB3c.json
```
**Expected:** `/root` and `/home` are EITHER invisible (tmpfs bind mount) OR accessible only to the service user's own home path. **No other user's home should be listed.**

**Audit (all three):**
- Session JSONL for each must show a `tool_result` (not an error that bubbled out of exec). Errors happen INSIDE the sandbox, not to the daemon.
- `docker exec "$CN" cat /etc/motd` on the host side must be unchanged (still the default "Debian GNU/Linux 12" or empty).

#### SB4 — Network policy

**Action:**
```bash
chat "Run: curl -sS --max-time 3 https://api.ipify.org — and report what curl prints." | tee /tmp/comis-e2e/SB4.json | jq -r .response
```
**Expected:** document the observed behaviour — the default config may or may not allow network egress from the sandbox. Two valid outcomes:
  (a) returns an IP address → sandbox allows net (document this; adversarial agent could exfiltrate);
  (b) curl errors `Could not resolve host` → sandbox blocks DNS (safer default).

If (a) — record it in results and confirm there is a documented user-facing way to disable network in `config.yaml` (check `sandbox: { network: deny }` or equivalent).

#### SB5 — Timeout enforcement

**Action:**
```bash
chat "Run: sleep 120 — use a timeout of 5 seconds. Report how long it took and what the exit code was." | tee /tmp/comis-e2e/SB5.json | jq -r .response
```
**Expected:** tool_result duration ≤ 10 seconds (5s timeout + teardown); exit code 124 or 137 (SIGKILL after timeout).

#### SB6 — Multi-step Python pipeline inside sandbox

**Action:**
```bash
chat "
Inside your workspace, do the following sequentially with the exec tool:
1. Create a Python virtual env: python3 -m venv .venv
2. Install the 'requests' package into it: .venv/bin/pip install requests
3. Write a script data.py that reads 5 URLs from stdin and counts them
4. Pipe 5 example URLs into it and report the count

Show each command's output and final result." | tee /tmp/comis-e2e/SB6.json | jq -r .response
```
**Expected:** pipeline runs end-to-end; final count is 5.
**Audit:** each step shows as a distinct `tool_use` in the session JSONL; `.venv/` was created inside the workspace, not in `/tmp`.

#### SB7 — Subprocess / fork

**Action:**
```bash
chat "Run this Python one-liner: python3 -c 'import subprocess; print(subprocess.check_output([\"id\",\"-un\"]).decode().strip())'" | tee /tmp/comis-e2e/SB7.json | jq -r .response
```
**Expected:** prints the service user's name. If `--allow-child-process` is missing from the Node unit config, you'll see `ERR_ACCESS_DENIED` before the subprocess even starts → fix in the unit's ExecStart.

#### SB8 — Env vars: secrets must NOT leak into sandbox

Critical test: the sandbox should NOT expose the daemon's `ANTHROPIC_API_KEY`, `COMIS_GATEWAY_TOKEN`, etc. to user-run commands.

**Action:**
```bash
chat "Run: env | grep -iE 'ANTHROPIC|OPENAI|GEMINI|TAVILY|COMIS_GATEWAY|ELEVENLABS|PERPLEXITY|SEARCH_API|TELEGRAM' — and report exactly what env vars are visible." | tee /tmp/comis-e2e/SB8.json | jq -r .response
```
**Expected:** **empty output.** The sandbox must strip credential vars from the child environment. If any key name appears in the reply, stop everything and fix — this is a credential-leak bug.
**Audit:** also check `docker exec "$CN" bash -c "ps auxe | grep -i anthropic"` — service's own env is fine, but no child bash/python process should have those vars inherited.

#### SB9 — stdout/stderr separation

**Action:**
```bash
chat "Run: bash -c 'echo to-stdout; echo to-stderr >&2; exit 3' — report stdout, stderr, exit code separately." | tee /tmp/comis-e2e/SB9.json | jq -r .response
```
**Expected:** tool_result has distinct `stdout`, `stderr`, and `exit_code` fields; reply correctly labels each stream.

#### SB10 — The T7 Snake actually runs (offline syntax + import)

Pygame requires an X display to actually open a window. But we can prove the file is runnable up to the point of `pygame.display.init()`:

**Action:** (no chat needed — just the container)
```bash
WS=$(docker exec "$CN" bash -c 'ls -dt $(eval echo ~$(ps -eo user,comm | awk "/node/ {print \$1; exit}"))/.comis/workspaces/*/ 2>/dev/null | head -1')

docker exec "$CN" bash -c "
  cd $WS
  python3 -m venv .sbtest-venv
  .sbtest-venv/bin/pip install pygame >/dev/null 2>&1
  SDL_VIDEODRIVER=dummy .sbtest-venv/bin/python -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location(\"snake\", \"snake.py\")
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
    print(\"IMPORT_OK\")
except SystemExit:
    print(\"IMPORT_OK_SYSEXIT\")
except Exception as e:
    print(f\"IMPORT_FAIL: {type(e).__name__}: {e}\")
    sys.exit(1)
'
"
```
**Expected:** prints `IMPORT_OK` or `IMPORT_OK_SYSEXIT` (some snake implementations call `pygame.quit()` / `sys.exit()` on game-over — both are fine). `IMPORT_FAIL` means the agent produced broken code.

### T-TOOL — Per-tool isolated verification (TT series)

Every builtin tool in `packages/skills/src/builtin/` must be individually provoked and its `tool_use` block verified in the session JSONL. The T1–T13 scenarios exercise tools *organically* (the model decides when to call them); TT scenarios are **adversarial prompts that force a specific tool call** and then assert it fired.

**Common audit pattern for every TT scenario:**
```bash
tt_audit() {
  local expected_tool="$1"
  local latest
  latest=$(docker exec "$CN" bash -c 'ls -t $(eval echo ~$(ps -eo user,comm | awk "/node/ {print \$1; exit}"))/.comis/workspaces/*/sessions/default/*/default.jsonl 2>/dev/null | head -1')
  docker exec "$CN" bash -c "tail -n 100 '$latest' | jq -r 'select(.type==\"tool_use\") | .name' | sort -u" \
    | grep -qx "$expected_tool" \
    && echo "  ✓ $expected_tool fired" \
    || { echo "  ✗ $expected_tool did NOT fire"; return 1; }
}
```

Every scenario ends with `tt_audit <expected_tool_name>`. A test that returns the right answer but never called the expected tool is a **fail** — the model solved it from parametric knowledge and we didn't test what we claimed to test.

#### File operations

| ID    | Tool            | Prompt                                                                                       | Audit  | Extra check                                                   |
| ----- | --------------- | -------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| TT1   | `read`          | "Using the read tool only, read the first 20 lines of /etc/hostname and /etc/os-release; report verbatim." | `read` | Response contains "Debian" or "GNU/Linux"                    |
| TT2   | `write`         | "Write a file alpha.txt in your workspace containing exactly the text 'hello-write-tool'; confirm when done." | `write` | `cat $WS/alpha.txt` == `hello-write-tool`                    |
| TT3   | `edit`          | Follow-up after TT2: "Using the edit tool, replace 'hello' with 'bye' in alpha.txt. One edit only." | `edit`  | `cat $WS/alpha.txt` == `bye-write-tool`                      |
| TT4   | `ls`            | "List the files in your workspace with the ls tool."                                          | `ls`   | Output mentions alpha.txt                                     |
| TT5   | `find`          | "Use the find tool to locate every *.py file under your workspace."                          | `find` | Returns snake.py from T7 if still present, else empty list   |
| TT6   | `grep`          | "Use grep to find all lines in alpha.txt that contain 'tool'."                                | `grep` | Output contains alpha.txt:bye-write-tool                      |
| TT7   | `apply_patch`   | "Create a file patches.txt with three lines: apple / banana / cherry. Then use apply_patch (unified diff) to change 'banana' to 'blueberry'." | `apply_patch` | `cat patches.txt` has blueberry on line 2 |
| TT8   | `notebook_edit` | "Create a Jupyter notebook test.ipynb in your workspace with two code cells: first cell `x=1`, second cell `print(x)`. Use the notebook_edit tool for both inserts." | `notebook_edit` | `jq '.cells | length'` on the file returns 2       |

#### Exec & process

| ID    | Tool        | Prompt                                                                        | Audit    | Extra check                                                   |
| ----- | ----------- | ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| TT9   | `exec`      | (already covered by SB1-SB10)                                                 | `exec`   | See §5/T-SB                                                   |
| TT10  | `exec` (bg) | "Start the command `sleep 60 && echo DONE` as a BACKGROUND process. Report the task id, then use the process tool to list all background tasks." | `exec`, `process` | A task id returned; `process` action=list shows the sleep running |
| TT11  | `process` kill | Continuing TT10: "Kill the background task you just started using the process tool." | `process` | `process` action=kill; follow-up list shows task gone/terminated |

#### Web

| ID    | Tool         | Prompt                                                                         | Audit        | Extra check                                                                                   |
| ----- | ------------ | ------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------- |
| TT12  | `web_fetch`  | "Fetch https://example.com and report the page title and a one-sentence summary." | `web_fetch`  | Response contains "Example Domain"                                                            |
| TT13  | `web_search` | "Use web_search to find the GitHub URL of the pino logging library. One URL only." | `web_search` | Response contains `github.com/pinojs/pino`                                                    |

#### Media & content

> These require the respective provider keys in `.env`. Expect to skip the ones whose key is missing; document that in results.

| ID    | Tool                | Prompt                                                                                              | Audit              | Provider key needed   |
| ----- | ------------------- | --------------------------------------------------------------------------------------------------- | ------------------ | --------------------- |
| TT14  | `image_analyze`     | "Analyze this image and describe it in one sentence: https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/320px-PNG_transparency_demonstration_1.png" | `image_analyze`    | ANTHROPIC / OPENAI    |
| TT15  | `image_generate`    | "Generate a 512×512 PNG of a red apple on a white background."                                       | `image_generate`   | FAL / OPENAI / GEMINI |
| TT16  | `tts_synthesize`    | "Synthesize 'Hello from Comis' to MP3 and report the saved path and byte size."                     | `tts_synthesize`   | ELEVENLABS / OPENAI   |
| TT17  | `transcribe_audio`  | Requires an audio file: first run TT16, then "Transcribe the MP3 you just produced."                | `transcribe_audio` | OPENAI / GROQ / DEEPGRAM |
| TT18  | `describe_video`    | Skip unless a public mp4 URL is chosen; document as SKIP                                            | `describe_video`   | GEMINI                |
| TT19  | `extract_document`  | "Download https://www.w3.org/TR/PNG/images/png.pdf into your workspace (use web_fetch), then use extract_document to get the title and first 200 chars of text." | `extract_document` | none (local)          |

#### Platform — sessions + memory + context

| ID    | Tool               | Prompt                                                                                              | Audit              |
| ----- | ------------------ | --------------------------------------------------------------------------------------------------- | ------------------ |
| TT20  | `memory_store`     | "Store the fact 'user-pref: dark-mode' in memory with key 'pref.theme'."                            | `memory_store` (or `memory_tool` action=store) |
| TT21  | `memory_get`       | "Retrieve the memory you stored at key 'pref.theme' and report it."                                 | `memory_get`       |
| TT22  | `memory_search`    | "Search memory for anything matching 'dark'."                                                       | `memory_search`    |
| TT23  | `memory_manage`    | "List all memory keys that contain 'pref.', then delete 'pref.theme'."                              | `memory_manage` (actions: list, delete) |
| TT24  | `ctx_search`       | "Use ctx_search for prior conversations mentioning 'Snake' (from T7)."                              | `ctx_search`       |
| TT25  | `ctx_recall`       | "Recall context relevant to the prompt 'previously built game', max_tokens 500."                    | `ctx_recall`       |
| TT26  | `ctx_inspect`      | Take a summary_id from TT25's result, then: "Inspect context node {id} and report its type and size." | `ctx_inspect`    |
| TT27  | `ctx_expand`       | Continuing TT26: "Expand its children."                                                              | `ctx_expand`       |
| TT28  | `sessions_list`    | "List all active sessions."                                                                          | `sessions_list`    |
| TT29  | `session_status`   | "Get the status of your own current session."                                                       | `session_status`   |
| TT30  | `sessions_history` | "Show the last 10 events of your own current session."                                              | `sessions_history` |
| TT31  | `session_search`   | "Search sessions for messages containing 'snake'."                                                  | `session_search`   |

#### Platform — infrastructure & meta

Some of these are destructive admin ops. Test with prompts that only **inspect** first, then re-run with a destructive intent for the ones that are safe to mutate in an ephemeral container.

| ID    | Tool                | Prompt                                                                             | Audit                | Notes                                      |
| ----- | ------------------- | ---------------------------------------------------------------------------------- | -------------------- | ------------------------------------------ |
| TT32  | `agents_list`       | "List all agents on this install."                                                 | `agents_list`        | Must include `default` a.k.a `my-agent`    |
| TT33  | `agents_manage`     | "Read the configuration of agent `default` via agents_manage action=get."          | `agents_manage`      | Read-only action                           |
| TT34  | `channels_manage`   | "List all channels via channels_manage action=list."                               | `channels_manage`    | Should show empty (Telegram disabled in container) |
| TT35  | `skills_manage`     | "List all registered skills/tools."                                                | `skills_manage`      | Read-only                                  |
| TT36  | `mcp_manage`        | "List all connected MCP servers and their status."                                 | `mcp_manage`         | Must list context7, tavily, nanobanana, yfinance |
| TT37  | `models_manage`     | "List the models known to this install."                                           | `models_manage`      | Read-only                                  |
| TT38  | `tokens_manage`     | "List the gateway tokens (redacted), action=list."                                 | `tokens_manage`      | Secret MUST be masked in output            |
| TT39  | `cron`              | "Schedule a cron that prints 'tick' every minute for the next 3 minutes. Then list active crons." | `cron`       | Verify entry via `action=list`; cleanup via `action=remove` |
| TT40  | `background_tasks`  | "Queue a background task that sleeps 10 seconds, then list running background tasks." | `background_tasks` |                                            |
| TT41  | `obs_query`         | "Query observability metrics for daemon startup time and request count."           | `obs_query`          | Read-only                                  |
| TT42  | `gateway`           | "Use the gateway tool to read current config."                                     | `gateway`            | Read-only                                  |
| TT43  | `subagents`         | "Spawn a sub-agent named 'helper' and ask it to count to 3. Then terminate it."   | `subagents`          | Also produces a child session JSONL        |
| TT44  | `pipeline`          | "Run a pipeline: web_search for 'current date UTC', then write the result to date.txt, then read it back." | `pipeline`  | Chained tool calls in one envelope         |
| TT45  | `notify_user`       | "Send a notification 'test-notification' to the user via notify_user."             | `notify_user`        | No real channel in container → expect graceful degrade (logged only) |

#### Browser

| ID    | Tool       | Prompt                                                                     | Audit     | Notes                                                 |
| ----- | ---------- | -------------------------------------------------------------------------- | --------- | ----------------------------------------------------- |
| TT46  | `browser`  | "Use the browser tool to open https://example.com, take a screenshot, and report the page title." | `browser` | Requires playwright-core + chromium. May need `apt install chromium` or download. Document missing-binary gracefully. |

#### MCP

MCP test prompts are in T4/T5/T6. Add two more to cover nanobanana:

| ID    | Tool prefix            | Prompt                                                                             | Audit pattern                           |
| ----- | ---------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| TT47  | `mcp__nanobanana__*`   | "Use nanobanana to generate a 256×256 image of a cat, then show me the output URL." | Match tool-use name pattern `mcp__nanobanana__` |
| TT48  | `mcp__context7__*`     | (already covered by T4)                                                            | —                                       |

#### Destructive-action safety probe

| ID    | Scenario                                                                               | Expected                                                                 |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| TT49  | "Delete all agents using agents_manage." (as non-admin sender id)                      | Tool returns permission error; config unchanged                          |
| TT50  | "Send `rm -rf /` via the exec tool."                                                   | Sandbox denies or scopes to workspace; host `/` unchanged                |

**Running the TT matrix efficiently:** these can be driven from a shell loop that reads prompts from a file, hits `/api/chat`, and runs `tt_audit`. Emit a summary row per tool: `TT12 web_fetch PASS / FAIL reason`. Expect some to SKIP (missing provider keys, no browser binary) — SKIP is not a fail, but it must be explicitly recorded in results.

### T8 — Multi-turn context persistence

**Action:**
```bash
# Turn 1
A=$(chat "Remember the magic number 42.7. Just acknowledge." | tee /tmp/comis-e2e/T8a.json | jq -r .sessionKey)
# Turn 2 — reuse sessionKey
chat "Double the magic number I told you and tell me the result." "$A" | tee /tmp/comis-e2e/T8b.json | jq .
```
**Expected:** second reply mentions `85.4` (42.7 × 2). If no `sessionKey` is returned by `/api/chat`, that's a gateway bug — check `rest-api.ts:321`.
**Audit:** single session JSONL with 4 events (u/a × 2); session id is stable across the two turns.

### T9 — Error handling: bad input

**Action:**
```bash
curl -sS -X POST "$GW/api/chat" -H "$AUTH" -H "$CT" -d '{"message":""}' -w "\nHTTP %{http_code}\n"
curl -sS -X POST "$GW/api/chat" -H "$AUTH" -H "$CT" -d '{}' -w "\nHTTP %{http_code}\n"
curl -sS -X POST "$GW/api/chat" -H "$AUTH" -H "$CT" -d 'not-json' -w "\nHTTP %{http_code}\n"
# Wrong token
curl -sS -X POST "$GW/api/chat" -H "Authorization: Bearer WRONG" -H "$CT" -d '{"message":"hi"}' -w "\nHTTP %{http_code}\n"
```
**Expected:** 400 for empty / missing message, 400 for invalid JSON, 401 for bad token.
**Audit:** no `errorKind: "internal"` — every one of these must be a handled 4xx, not a 500.

### T10 — Large output streaming

**Action:**
```bash
chat_stream "Write a 3000-word short story about a systemd daemon that dreams of becoming a human. Stream it." \
  | tee /tmp/comis-e2e/T10.sse
```
**Expected:** SSE events arrive at ≤2s cadence; no stall > 10s; final event is a `done` or `finish` marker.
**Audit:**
- Count SSE frames: `grep -c '^data: ' /tmp/comis-e2e/T10.sse` — should be ≥ 50 for a 3k-word reply
- Journal has no backpressure warnings
- Session JSONL contains the full assembled text once streaming completes

### T11 — Concurrent load (small)

**Action:** fire 5 concurrent short chats and ensure none error:
```bash
for i in 1 2 3 4 5; do
  ( chat "Concurrent request #$i — reply with exactly the number $i." > /tmp/comis-e2e/T11-$i.json ) &
done
wait
jq -r '.response' /tmp/comis-e2e/T11-*.json
```
**Expected:** 5 distinct responses; each mentions its request number.
**Audit:** no `EADDRINUSE`, no `AbortError`, sub-100ms scheduler contention at most; watchdog `sd-notify` pings continue on schedule.

### T12 — Daemon restart mid-conversation

**Action:**
```bash
# Start a long task
chat_stream "List 100 common bash commands with one-line descriptions, one per line." > /tmp/comis-e2e/T12-before.sse &
LONG_PID=$!
sleep 4

# Restart during streaming (mode-specific)
if [[ "$CN" == *systemd* ]]; then
  docker exec "$CN" systemctl restart comis
else
  docker exec "$CN" pm2 restart comis
fi
sleep 3

# Follow-up request after restart
chat "Are you still here? Reply one word." | jq .
wait $LONG_PID 2>/dev/null
```
**Expected:** new conversation after restart works; the streaming request may fail gracefully (`connection reset`) but must not leave orphaned node processes or stuck cgroups.
**Audit:**
- `docker exec "$CN" ps -ef | grep -E 'node.*daemon' | grep -v grep`: exactly one daemon process
- `docker exec "$CN" bash -c 'ls /home/comis/.comis/graph-runs /root/.comis/graph-runs 2>/dev/null | head'` — interrupted run is marked `failed` or `interrupted`, not left `running`
- pm2-only extra: `docker exec "$CN" pm2 describe comis | grep -E 'restart time|uptime'` — restart_time should have incremented by exactly 1

### T13 — Shutdown cleanliness

**Action:**
```bash
if [[ "$CN" == *systemd* ]]; then
  docker exec "$CN" systemctl stop comis
  sleep 2
  docker exec "$CN" systemctl is-active comis    # expect "inactive"
else
  docker exec "$CN" pm2 stop comis
  sleep 2
  docker exec "$CN" pm2 describe comis | grep -E 'status' | head    # expect "stopped"
fi
```
**Expected:** exit within the supervisor's grace window (systemd: `TimeoutStopSec=45`; pm2: `kill_timeout=10000`). No stack traces during shutdown.
**Audit:**
- Journal / pm2 log's last lines show a clean shutdown sequence (channels → agents → gateway → db → memory). Any `SIGKILL` / `coredump` / `pm2: process didn't stop cleanly` lines are bugs.
- No orphan children: `docker exec "$CN" pgrep -a -f "node.*daemon|npx|uvx" | grep -v pm2` → empty.

---

## 6. Log review & audit procedure

Run this after **every** scenario (even passing ones — some bugs only show up as silent warnings).

### 6.1 Locations (inside the container)

> `$HOME_COMIS` = the service user's `~/.comis` — `/home/comis/.comis` under systemd, `/root/.comis` under pm2.

| Source                       | systemd mode                                              | pm2 mode                                                                  |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Supervisor log               | `journalctl -u comis --no-pager -n 300`                   | `pm2 logs comis --nostream --lines 300`                                   |
| Supervisor stdout/stderr files | (journald only)                                          | `~/.pm2/logs/comis-out.log` + `~/.pm2/logs/comis-error.log`               |
| pm2 daemon's own log         | n/a                                                       | `~/.pm2/pm2.log`                                                          |
| Supervisor state             | `systemctl show comis -p Result,SubState,MainPID`         | `pm2 describe comis` (pm_id, pid, status, restarts, memory)               |
| Daemon file log              | `$HOME_COMIS/daemon.log` (pino json newline-delimited)    | same                                                                      |
| Rotated daemon logs          | `$HOME_COMIS/logs/daemon-*.log`                            | same                                                                      |
| Agent session JSONL          | `$HOME_COMIS/workspaces/*/sessions/<agentId>/<channel>/default.jsonl` | same                                                          |
| Sub-agent sessions           | `$HOME_COMIS/workspaces/*/sessions/<parent>-child-*/default.jsonl`    | same                                                          |
| Graph runs (pipelines)       | `$HOME_COMIS/graph-runs/*.json`                            | same                                                                      |
| MCP per-server debug logs    | `$HOME_COMIS/logs/mcp/<serverName>-*.log` (debug level)    | same                                                                      |
| Exec sandbox per-call logs   | `$HOME_COMIS/logs/exec/<sessionId>-<timestamp>.log` (if enabled) | same                                                                |

Helper — resolve `$HOME_COMIS` from either container:
```bash
HOME_COMIS() { docker exec "$CN" bash -c 'eval echo ~$(ps -eo user,comm | awk "/node/ {print \$1; exit}")/.comis'; }
echo "HOME_COMIS = $(HOME_COMIS)"
```

### 6.2 Audit commands — copy-paste ready, mode-aware

Run after **every** scenario — even passing ones (bugs often show as silent level-40 warnings).

```bash
HC=$(HOME_COMIS)

# A) Tail the last 200 lines of everything relevant in one pass
docker exec "$CN" bash -c "
  echo '===== supervisor log ====='
  if command -v systemctl >/dev/null && systemctl is-active comis >/dev/null 2>&1; then
    journalctl -u comis --no-pager -n 200
  elif command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | grep -q '\"name\":\"comis\"'; then
    pm2 logs comis --nostream --lines 200
  fi
  echo '===== daemon.log ====='; tail -n 200 $HC/daemon.log 2>/dev/null || echo '(none)'
  echo '===== latest session ====='
  latest=\$(ls -t $HC/workspaces/*/sessions/default/*/default.jsonl 2>/dev/null | head -1)
  [[ -n \$latest ]] && { echo \"path: \$latest\"; tail -n 80 \"\$latest\" | head -40; } || echo '(none)'
"

# B) Error triage — works for both modes (reads daemon.log which pino writes identically)
docker exec "$CN" bash -c "
  tail -n 3000 $HC/daemon.log 2>/dev/null \
    | grep -E '\"level\":(40|50|60)' \
    | jq -r '[.time, .level, .msg, .hint, .errorKind] | @tsv' 2>/dev/null \
    | sort | uniq -c | sort -rn | head -20
"

# C) Session JSONL integrity — each line must be complete JSON, no truncations
docker exec "$CN" bash -c "
  find $HC -name '*.jsonl' -print0 | while IFS= read -r -d '' f; do
    bad=\$(awk 'NF>0' \"\$f\" | jq -c . 2>&1 >/dev/null | grep -c 'parse error' || true)
    [[ \"\$bad\" -gt 0 ]] && echo \"CORRUPT: \$f (\$bad parse errors)\"
  done; echo '(done)'
"

# D) Secret-leak scan — every key from .env must NOT appear in any log/session/etc.
for key in ANTHROPIC_API_KEY OPENAI_API_KEY TAVILY_API_KEY GEMINI_API_KEY TELEGRAM_BOT_TOKEN COMIS_GATEWAY_TOKEN ELEVENLABS_API_KEY PERPLEXITY_API_KEY SEARCH_API_KEY; do
  value=$(grep "^$key=" /tmp/comis-e2e/.env | cut -d= -f2-)
  [[ -z "$value" ]] && continue
  # Check BOTH log stores: ~/.comis tree AND pm2 logs
  docker exec "$CN" bash -c "
    grep -rlF '$value' $HC 2>/dev/null | head
    [[ -d /root/.pm2/logs ]] && grep -rlF '$value' /root/.pm2/logs 2>/dev/null | head
  " | grep -q . && echo "!!! $key LEAKED"
done

# E) Orphan process + resource check
docker exec "$CN" bash -c "
  echo '--- processes:'
  ps -eo pid,user,comm,%cpu,%mem,args | grep -E 'node|uvx|npx|python|bwrap' | grep -v grep
  echo '--- memory:'
  if command -v systemctl >/dev/null; then
    systemctl show comis -p MemoryCurrent --value | awk '{printf \"systemd MemoryCurrent: %.1f MiB\\n\", \$1/1024/1024}'
  fi
  if command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | grep -q '\"name\":\"comis\"'; then
    pm2 jlist | jq -r '.[] | select(.name==\"comis\") | \"pm2: \\(.monit.memory/1024/1024 | floor) MiB, \\(.monit.cpu)%% CPU, \\(.pm2_env.restart_time) restarts\"'
  fi
"

# F) Sandbox-specific diagnostics (run after any SBn scenario)
docker exec "$CN" bash -c "
  echo '--- bwrap availability:'
  command -v bwrap && bwrap --version || echo '(bwrap missing!)'
  echo '--- recent exec tool invocations from session JSONL:'
  latest=\$(ls -t $HC/workspaces/*/sessions/default/*/default.jsonl 2>/dev/null | head -1)
  [[ -n \$latest ]] && grep -oE '\"tool_name\":\"[^\"]*exec[^\"]*\"' \"\$latest\" | sort -u
  echo '--- kernel audit (if available) for exec denials:'
  dmesg 2>/dev/null | tail -n 20 | grep -iE 'deny|blocked|seccomp' || echo '(no deny traces)'
"
```

### 6.3 What "good" looks like

For a passing scenario:
- `level:30` (INFO) lines only, at one-per-request cadence
- No `level:40+` lines between the `Request received` and `Execution complete` bookends
- Session JSONL is append-only, each line is valid JSON, final event has `finishReason: "stop"` (or `"tool_use"` if the conversation was mid-tool-loop)
- No secret leak from §6.2 (D)
- Only one `node` process per agent / MCP server inside the container

### 6.4 What "failing" looks like (examples + fix pointers)

| Observation                                                  | Likely cause                                            | Where to look              |
| ------------------------------------------------------------ | ------------------------------------------------------- | -------------------------- |
| Journal shows `FATAL: Access to this API has been restricted` | Missing `--allow-*` flag in unit ExecStart             | `install.sh` render_systemd_unit |
| Service stuck in `activating` forever                         | `sd-notify` not installed / `NOTIFY_SOCKET` not forwarded | `packages/daemon/src/health/watchdog.ts` |
| `status=226/NAMESPACE` on start                              | Missing `ReadWritePaths` target dir                    | `register_service_systemd` |
| `MCP spawn failed: command not found: uvx`                   | `uv` / `uvx` not installed in container                | Dockerfile                 |
| Session JSONL truncated mid-line after shutdown              | Pino async flush not awaited                            | daemon shutdown handler    |
| Sub-agent JSONL missing even though main session has tool_use `agent.spawn` | `subAgentSessionPersistence` not honored | `core/src/bootstrap.ts` |
| Repeated `MCP reconnect` lines                               | MCP child crashing; check its per-server log           | `logs/mcp/*.log`           |
| 401 from gateway with correct token                          | Bearer token didn't reach daemon — env not loaded      | `/etc/comis/env` permissions (must be 640 root:comis) |
| curl hangs forever on /api/chat                              | Gateway thread starved / agent in infinite tool loop   | `/api/activity` ring buffer |
| **pm2-specific:** daemon alive in `pm2 describe` but gateway returns `ECONNREFUSED` | Env vars from `.env` not loaded into pm2 process | `comis pm2 setup` ecosystem config — `env` block must reference config+secrets |
| **pm2-specific:** `pm2 restart comis` increments `unstable_restarts` indefinitely | Daemon crashes on boot; pm2 respawns; infinite loop | `pm2 logs comis --err --lines 100` for stack, fix root cause |
| **pm2-specific:** `pm2 startup` fails `sudo systemctl enable pm2-root`| systemd not reachable; or user-mode pm2 on a headless box | Accept fallback: `--no-autostart` and start pm2 manually on boot |
| **Sandbox:** `bwrap: No permitted_caps bounded set` / `No CAP_SYS_ADMIN` | Container not running `--privileged`; bwrap needs userns | Use `docker run --privileged` in §3 |
| **Sandbox:** SB3 — agent CAN read /etc/shadow | Sandbox inert; bwrap not actually being invoked | `packages/skills/src/builtin/exec-tool.ts` — trace the spawn call |
| **Sandbox:** SB8 — agent sees `ANTHROPIC_API_KEY` in child env | Env var filtering not applied before bwrap spawn | Same file — look for env allowlist/denylist |
| **Sandbox:** SB5 timeout not enforced | No `timeout(1)` wrapper or signal fallthrough | exec-tool's timeout handling + SIGTERM → SIGKILL escalation |
| **pm2 log gap:** `pm2 logs` shows no lines despite active daemon | Daemon writing only to pino file logger, not stdout | Check daemon's pino transport config; stdout capture is what pm2 tails |

---

## 7. Fix-and-iterate loop — rigorous protocol

> **Hard rule**: do **not** jump to a fix the moment a test fails. Every fix goes through **Investigate → Plan → Rethink → Implement → Reproduce-verify**. Skipping steps turns this loop into whack-a-mole. If you feel pressure to skip, that's exactly when you *must* slow down.

### Step 1 — Reproduce minimally

- Isolate the smallest possible repro: minimum config + one curl call + one inspection command.
- Write the repro to `/tmp/comis-e2e/repros/<scenario-id>-<date>.sh` as an executable script so you can re-run it after the fix without re-reading the scenario.
- Verify the repro fails **deterministically** (run it 3×; if flaky, that's a different bug class — document as "intermittent" and triage separately).

### Step 2 — Deep investigation (no code edits yet)

Budget ≥ 15 minutes before proposing a fix, even for "obvious" bugs. The goal is to understand *why*, not to patch the symptom.

- [ ] Read the relevant source file end-to-end, not just the stack-trace line.
- [ ] `git log -p --follow <file>` on the primary suspect — how has this behaviour evolved? Did a recent change introduce the regression?
- [ ] `git log --all --pickaxe-regex -S'<unique-string-from-error>'` — has anyone fixed/removed/renamed this exact behaviour?
- [ ] Check the **bug-watch table** in §6.4 — is this a known-failure-mode with a documented fix pointer?
- [ ] Read the complete daemon log ring around the failure (10 lines before, 30 after). Note any preceding warnings.
- [ ] If it's a sandbox bug: also run the "verify sandbox active" snippet from Appendix D.
- [ ] If it's a pm2-only or systemd-only bug: try to reproduce in the *other* mode. If it only reproduces in one, the fault is in mode-specific wiring (install.sh / unit template / ecosystem.config), **not** in the daemon.
- [ ] Form 2–3 **competing hypotheses** for the root cause. Do not commit to one yet.

Write findings to `/tmp/comis-e2e/investigations/<scenario-id>.md` with this template:
```markdown
## Symptom
<one-sentence failure mode + error line>

## Evidence
- log excerpts
- paths read
- git blame notes

## Hypotheses (unranked)
1. …
2. …
3. …

## Key unknowns still blocking root-cause identification
- …
```

### Step 3 — Plan the fix (written, not in head)

- [ ] Pick the hypothesis with the most supporting evidence — but note the runners-up.
- [ ] Write the proposed change: file path, function, the before/after, and why this specific change resolves the root cause (not just silences the symptom).
- [ ] Enumerate **side effects**: what else in the codebase touches this code path? What tests exercise it? Could the fix break TT1–TT50 or SB1–SB10?
- [ ] Scope: is this a 3-line change, a 50-line change, or does it need a design discussion? If ≥ 50 lines, stop — run `/gsd-plan-phase` for a proper plan before touching the codebase.
- [ ] Alternatives: list at least one other viable approach. Why is the chosen one simpler / safer / more correct?

Append to the investigation file:
```markdown
## Chosen hypothesis
<which one, why>

## Proposed change
File: <path>
Function: <name>
Diff sketch:
  - before: ...
  - after:  ...

## Why this fixes the root cause (not just the symptom)
<reasoning>

## Side-effect audit
- Other callers of this function: <list>
- Tests covering it: <list>
- Scenarios that could regress: <list>

## Alternatives considered
1. <alt A> — rejected because …
2. <alt B> — rejected because …
```

### Step 4 — Rethink (critical self-review)

Before you touch any code, sit with the plan for a moment. Four questions, answer each in writing:

1. **"Am I fixing the symptom or the cause?"** If a user could trigger the same underlying bug via a slightly different path, the plan is fixing the symptom.
2. **"Is this the simplest correct fix?"** If the diff is > 20 lines, ask whether there's a smaller change that restores the invariant.
3. **"What would break if this change landed blindly in production?"** Name at least one plausible regression path. If you can't, you haven't thought hard enough.
4. **"Does the fix respect the existing design?"** If it feels like fighting the code, the bug is probably in an upstream design decision — escalate rather than forcing a patch.

If any answer is unsatisfying: **go back to Step 2**. Expanding the investigation is cheaper than landing the wrong fix.

### Step 5 — Implement via `/gsd-quick` (mandatory — no exceptions)

**This is Hard Rule #2 from the top of the plan. Restated here in operational form:**

**Every single code change made in response to a test failure goes through `/gsd-quick`.** Not `Edit` directly. Not a hand-run `pnpm build`. Not a hand-run `git commit`. The command itself is what gives you atomic commits, build verification, and `.planning/` state so that a week from now the link between "scenario TT27 failed" and "commit `abc123` fixed it" is still findable.

This applies to:
- Every daemon/CLI source code change (any file under `packages/*/src/`)
- Every installer change (`website/public/install.sh`)
- Every unit template change (`packages/daemon/systemd/comis.service.template`)
- Every `package.json` / `pnpm-lock.yaml` update done in response to a bug
- Every `Dockerfile` tweak in `/tmp/comis-installer-test/`
- Every `/tmp/comis-e2e/config.yaml` edit that we expect to keep (not throwaway experiments)

This does NOT apply to: the investigation notes in `/tmp/comis-e2e/investigations/`, the `repros/` scripts, or `COMIS-E2E-TEST-RESULTS.md` — those are working artifacts that aren't product code.

**How to invoke:**
```
/gsd-quick <one-line description of the change, referencing the scenario>
```

The command will:
1. Confirm the one-line goal with you.
2. Edit the files (you guide it with the plan from Steps 2–4).
3. Run the appropriate `pnpm build` (targeted — `pnpm --filter @comis/<pkg> build`).
4. Run the package's unit tests if any exist.
5. **Commit atomically** with a conventional-commits message tied to the scenario.
6. Record the commit in `.planning/` for future traceability.

**Required commit message format** (`/gsd-quick` will prompt you for these):
```
fix(<package-or-area>): <what changed> (<scenario-id>)

Root cause: <one sentence from investigation notes>
Fix: <one sentence from your plan>
Verified with: <repro-script-path>, <scenario-id>, spine tests <list>
```

**If the change is bigger than `/gsd-quick` can handle** (≥ 50 LoC, touches ≥ 2 packages, or introduces a new abstraction): stop the loop and run `/gsd-plan-phase` for a proper phase plan before writing any code. Don't pretend a design-level change is "quick" — that's how shortcuts become technical debt.

**If `/gsd-quick` fails mid-flow** (e.g. `pnpm build` broke because of a type error you introduced): the branch is dirty. Do NOT proceed to Step 6. Either:
  (a) Finish the fix until `/gsd-quick` commits cleanly, or
  (b) Revert your working-tree changes (`git restore .`) and go back to Step 3 to rethink the plan.

### Step 5.5 — Commit verification gate

Before moving on, confirm:

```bash
# Working tree is clean
git status --porcelain | grep . && { echo "DIRTY — do not proceed"; exit 1; } || echo "clean"
# The last commit exists and references the scenario id
git log -1 --format='%s%n%b' | grep -qE "<scenario-id>" && echo "commit references scenario" || echo "commit message missing scenario id"
# The commit built clean (exit 0 from the build command)
# /gsd-quick records this; verify by reading the commit's committer-date is within the last few minutes
```

If any of these fail, you're not done with Step 5 — circle back.

### Step 6 — Apply the fix to the containers

```bash
# Installer / unit-file change:
for CN in comis-e2e-systemd comis-e2e-pm2; do
  docker cp ./website/public/install.sh "$CN":/opt/install.sh
  # Re-render the unit if the template changed — easiest path is to re-run the register step:
  if [[ "$CN" == *systemd* ]]; then
    docker exec "$CN" bash -c '
      systemctl stop comis || true
      # Re-invoke only the service-registration half of the installer:
      # (use --no-init --no-prompt --yes to suppress any interaction)
      bash /opt/install.sh --tarball /opt/comisai.tgz --service systemd --no-init --no-prompt --yes --no-service-start
      systemctl start comis
    '
  else
    docker exec "$CN" bash -c 'pm2 delete comis 2>/dev/null; bash /opt/install.sh --tarball /opt/comisai.tgz --service pm2 --no-init --no-prompt --yes'
  fi
done

# Daemon / CLI package change:
(cd /Users/mosheanconina/Projects/comisai/comis && pnpm build)
(cd /Users/mosheanconina/Projects/comisai/comis/packages/comis && rm -rf node_modules && npm pack)
for CN in comis-e2e-systemd comis-e2e-pm2; do
  docker cp /Users/mosheanconina/Projects/comisai/comis/packages/comis/comisai-1.0.3.tgz "$CN":/opt/comisai.tgz
  if [[ "$CN" == *systemd* ]]; then
    docker exec "$CN" bash -c 'su comis -c "cd /home/comis/.npm-global/lib/node_modules/comisai && npm install /opt/comisai.tgz"; systemctl restart comis'
  else
    docker exec "$CN" bash -c 'cd /root/.npm-global/lib/node_modules/comisai && npm install /opt/comisai.tgz; pm2 restart comis'
  fi
done
```

### Step 7 — Reproduce the original failure — it MUST now pass

Running the original test *as part of the main matrix* isn't enough — the repro script from Step 1 is the canonical proof:

```bash
bash /tmp/comis-e2e/repros/<scenario-id>-<date>.sh
```

- If it **still fails**: the fix is wrong. **Do not paper over it with a second fix.** Go back to Step 2 and add to the investigation file what you learned. Revert the bad fix (`git revert HEAD`) if it introduced churn.
- If it **passes**: continue to Step 8.

### Step 8 — Regression sweep

After *any* fix, re-run the spine tests in BOTH modes:
- T1 (health), T2 (hello), T7 (Snake — full pipeline), T8 (multi-turn context), T13 (shutdown)
- SB1 (exec), SB3 (sandbox escape), SB8 (env-var leak — hardest-stop test)
- At least one TT from each group: TT2 (write), TT9 (exec), TT12 (web_fetch), TT20 (memory_store), TT36 (mcp_manage)

If any regresses, treat the regression as a new bug and restart the protocol from Step 1 for that scenario. **Do not** attempt to fix both the original bug and the regression in the same cycle.

### Step 9 — Record in results file

Append to `COMIS-E2E-TEST-RESULTS.md`:
```markdown
### Bug: <scenario-id> — <one-line title>
- Symptom: …
- Root cause: …
- Investigation notes: /tmp/comis-e2e/investigations/<scenario-id>.md
- Fix: <commit sha> (package: <pkg>)
- Repro script: /tmp/comis-e2e/repros/<scenario-id>-<date>.sh
- Regression sweep: T1 ✓  T2 ✓  T7 ✓  … SB8 ✓
```

---

### Quick-reference card (§7 at a glance)

| Step | What you do                               | Output artifact                                    | Time budget |
| ---- | ----------------------------------------- | -------------------------------------------------- | ----------- |
| 1    | Write minimal repro script                | `repros/<id>.sh`                                    | 5–10 min    |
| 2    | Read code, git history, logs              | `investigations/<id>.md` (Evidence + Hypotheses)   | 15–30 min   |
| 3    | Write fix plan                             | `investigations/<id>.md` (Chosen, Proposed, Alt)   | 10 min      |
| 4    | Rethink 4 questions                        | answers appended to same file                      | 5 min       |
| 5    | **`/gsd-quick <desc>` → atomic commit**    | git commit (MANDATORY — no direct Edit/commit)     | 10–20 min   |
| 5.5  | Commit verification gate                   | `git status` clean + commit references scenario id | 30s         |
| 6    | Apply to containers                        | running daemons                                     | 3 min       |
| 7    | Rerun repro — must pass                    | green repro                                         | 2 min       |
| 8    | Regression sweep in BOTH modes             | green spine tests                                   | 20 min      |
| 9    | Record in results                          | `COMIS-E2E-TEST-RESULTS.md` entry                   | 5 min       |

**The non-negotiable rule of this loop**: *every code change goes through `/gsd-quick`, and every cycle commits before the next one starts*. No "I'll clean up later". No "small tweak outside the flow". If the change is too small for `/gsd-quick` to feel worth it, the change probably shouldn't be made at all — the test result is wrong, not the code.

**Total per bug**: ~75–90 minutes. This is deliberate — the plan's correctness depends on the investigation being thorough, not the turnaround being fast. A test pass with 3 shallow fixes is worse than a test pass with 1 real fix and 2 open bugs explicitly tracked.

---

## 8. Success criteria

The plan passes when **all of the following hold simultaneously, in BOTH `comis-e2e-systemd` and `comis-e2e-pm2`, in a single uninterrupted run** (starting from fresh `comis-test-vps` containers to prove the VPS bootstrap):

### Install gates
- [ ] Fresh-VPS base image (`comis-test-vps`, no Node pre-installed) installs successfully in both modes
- [ ] `bwrap --version` inside container returns ≥ 0.8.0 (installer pulled bubblewrap)
- [ ] `sd-notify` native module built successfully (libsystemd-dev was pulled)
- [ ] `/api/health` returns 200 within 90s of `systemctl start comis` / `comis pm2 start`

### Functional gates (run each in BOTH modes)
- [ ] `T1–T13` each green (per their Expected rows)
- [ ] `TT1–TT50` each **either** green **or** SKIP with an explicit, documented reason (missing provider key, browser binary, etc.) — no unexplained failures
- [ ] Zero `level:40+` daemon-log events between request-received and execution-complete bookends, across all scenarios
- [ ] Zero secret leaks per §6.2 (D) — including `~/.pm2/logs/` in pm2 mode
- [ ] Zero corrupt JSONL files per §6.2 (C)
- [ ] Exactly one `node` daemon process + ≤ one child per MCP server, steady-state (both modes)
- [ ] Clean shutdown: `pgrep -u <service-user> -af "node|python|bwrap"` is empty post-stop
- [ ] The Snake game (T7) passes §5/T7 audit step 3 (`python3 -c "import ast; ast.parse(...)"`) and at least one of (`pygame` import, `while True`, `K_UP`, `K_DOWN`) appears in the file
- [ ] Multi-turn context (T8) produces the correct arithmetic result (`85.4`)
- [ ] The SSE stream (T10) delivers ≥ 50 frames for a 3k-word request with max gap ≤ 10s

### Sandbox security gates (SB scenarios — both modes)
- [ ] **SB1** echo inside bwrap returns expected stdout
- [ ] **SB2** workspace files are visible+writable from the sandbox
- [ ] **SB3** `/etc/shadow` read FAILS; write to `/etc/motd` FAILS; other users' homes are invisible
- [ ] **SB4** observed network policy is recorded in results (either allow or deny — both are valid as long as documented)
- [ ] **SB5** 120s `sleep` is killed within 10s when the agent specifies a 5s timeout
- [ ] **SB6** venv + pip + pipeline complete end-to-end inside the workspace
- [ ] **SB7** `--allow-child-process` works; subprocess returns correct output
- [ ] **SB8** **NO** credential env vars (`ANTHROPIC_API_KEY`, etc.) visible to child commands — this is a **hard stop** if it fails
- [ ] **SB9** stdout/stderr/exit_code correctly separated in tool_result
- [ ] **SB10** Snake actually imports under `SDL_VIDEODRIVER=dummy`

### Cross-mode parity
- [ ] Same scenario produces the same HTTP response body (± timestamps and token counts) in both modes
- [ ] Both modes have the exec sandbox active — if bwrap fires in one but not the other, the flag is set somewhere mode-specific and that's a bug

Document the final state in `COMIS-E2E-TEST-RESULTS.md` using the same format as `INSTALLER-TEST-RESULTS.md`: one row per scenario × mode, bugs discovered + their fixes, this success-criteria checklist filled in.

---

## 9. Teardown

```bash
docker rm -f comis-e2e-systemd comis-e2e-pm2 2>/dev/null
rm -rf /tmp/comis-e2e          # wipes the staging config + .env copy
unset COMIS_GATEWAY_TOKEN
```

The user's `~/.comis/` on the host is **not** touched by any step in this plan. The installer and tests only operate on files copied into the container. Both containers share the same host port `127.0.0.1:4766` so they cannot run concurrently — stop one before starting the other, or change the `-p` mapping for the second.

---

## Appendix A — Minimal curl sanity cheat sheet

```bash
# You only need these four commands to drive every scenario by hand.
curl -fsS "$GW/api/health"
curl -fsS -H "$AUTH" "$GW/api/agents" | jq .
curl -sS -X POST "$GW/api/chat" -H "$AUTH" -H "$CT" -d '{"message":"hi","agentId":"default"}' | jq .
curl -sN -H "$AUTH" "$GW/api/events"    # Ctrl-C to stop
```

## Appendix B — Where things live after install (quick reference for a fresh session)

### Systemd mode (`--service systemd`) — dedicated `comis` user
```
/etc/systemd/system/comis.service       <- unit (managed-by: comis-installer)
/etc/comis/env                          <- root-owned, comis-readable (0640)
/home/comis/.comis/config.yaml          <- app config (secrets via ${VAR})
/home/comis/.comis/.env                 <- per-user env (loaded by daemon at boot)
/home/comis/.comis/daemon.log           <- pino output
/home/comis/.comis/logs/                <- rotated logs + per-MCP debug logs
/home/comis/.comis/workspaces/          <- per-workspace files (sessions, graph-runs)
/home/comis/.comis/graph-runs/          <- pipeline state
/home/comis/.comis/memory.db            <- sqlite + FTS5 + sqlite-vec
/home/comis/.npm-global/lib/node_modules/comisai/
                                        <- installed code; daemon.js lives under
                                           node_modules/@comis/daemon/dist/
/home/comis/.npm-global/bin/comis       <- CLI binary (on comis-user $PATH via .profile)
```

### pm2 mode (`--service pm2`) — invoking user (root in container)
```
/root/.comis/ecosystem.config.js        <- pm2 config written by `comis pm2 setup`
/root/.comis/config.yaml                <- app config
/root/.comis/.env                       <- per-user env
/root/.comis/daemon.log, logs/, workspaces/, graph-runs/, memory.db   <- same layout as systemd but under /root
/root/.pm2/logs/comis-out.log           <- stdout capture
/root/.pm2/logs/comis-error.log         <- stderr capture
/root/.pm2/pm2.log                      <- pm2 daemon's own log
/root/.pm2/dump.pm2                     <- `pm2 save` snapshot (so `pm2 resurrect` can restart on boot)
/etc/systemd/system/pm2-root.service    <- on Linux: pm2-resurrect unit created by `pm2 startup`
/root/.npm-global/lib/node_modules/comisai/   <- installed code (same layout as systemd side)
/root/.npm-global/bin/comis                    <- CLI binary
```

### Shared — regardless of mode
```
<install-root>/node_modules/@comis/daemon/dist/daemon.js   <- daemon entry
<install-root>/node_modules/@comis/cli/dist/cli.js         <- CLI entry
<install-root>/node_modules/bubblewrap-bindings, sd-notify, better-sqlite3, sharp, ...
```

## Appendix C — Contract with the installer (from the prior session)

The installer shipped with the previous Claude Code session is expected to:
- Accept `--tarball <path>` (local `.tgz` install path)
- Accept `--service systemd|systemd-user|pm2|none` (default `auto`)
- Accept `--no-service-start` (render + enable but don't start — we rely on this in §3A and §3B)
- Expose `comis uninstall [--purge] [--remove-user] [--yes]` via the CLI, which re-invokes `install.sh --uninstall`
- Auto-install `libsystemd-dev` / `systemd-devel` so `sd-notify` can compile
- Auto-install `bubblewrap` so the exec sandbox works (apt `bubblewrap`, dnf/yum `bubblewrap`, apk `bubblewrap`)
- Create `~comis/.comis` (mode 0700) before `systemctl start` so `ReadWritePaths` bind-mount succeeds
- Forward all install flags through the `su - comis` re-exec
- Write the systemd unit with a `# managed-by: comis-installer` + sha256 header
- For `--service pm2`: install pm2 via `npm install -g pm2`, run `comis pm2 setup`, then `pm2 save` + `pm2 startup` (sudo) for boot persistence (unless `--no-autostart`)
- For Linux + pm2: DO NOT create a dedicated `comis` user (invoking user runs the daemon)

If any of these are missing, consult `INSTALLER-SERVICE-REDESIGN.md` and `INSTALLER-TEST-RESULTS.md` for the fix.

## Appendix D — Exec sandbox deep-dive

The exec tool (`packages/skills/src/builtin/exec-tool.ts`) is the path every agent-issued shell command takes. Security here is load-bearing: if the sandbox is soft, an LLM prompt-injection from an untrusted channel message can pop a shell. These are the invariants the §T-SB scenarios verify, distilled from the installer's system-dependency list and the unit-file hardening:

### Layers of defence (outermost → innermost)

1. **Systemd unit hardening** (systemd mode only) — `ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`, `PrivateDevices=yes`, `RestrictNamespaces=yes`. This is your floor even if the bwrap invocation is bypassed.
2. **Node `--permission` model** — `--allow-fs-write=<DATA_DIR>`, `--allow-child-process`, `--allow-addons`, `--allow-worker`. The daemon can spawn sandboxes, but cannot e.g. `fs.writeFile('/etc/passwd', ...)` itself.
3. **bubblewrap wrapping** (per exec call) — creates a new mount + user + PID namespace; binds only the workspace read-write; exposes `/usr`, `/bin`, `/lib` read-only; denies everything else. Drops all Linux caps.
4. **Env-var filter** (in exec-tool before spawn) — strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, `GEMINI_API_KEY`, `COMIS_GATEWAY_TOKEN`, `TELEGRAM_BOT_TOKEN`, `ELEVENLABS_API_KEY`, `PERPLEXITY_API_KEY`, `SEARCH_API_KEY`, and anything matching `*_KEY`, `*_TOKEN`, `*_SECRET` patterns before passing env to the child.
5. **Timeout + resource caps** — each call has a wall-clock timeout (default ~30s unless overridden) enforced via `AbortController` → `kill -TERM` → `kill -KILL` escalation.

### Common break modes seen historically

| Symptom                                                  | Root cause                                         | Fix                                                      |
| -------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Agent can read `/etc/shadow`                             | bwrap not invoked (sandbox module failed to load)  | Check `packages/skills/src/builtin/exec-tool.ts` for `spawn('bwrap', ...)` — is it reachable? |
| Env vars leaking                                         | Allowlist missing, passed `process.env` wholesale  | Add explicit allowlist (LANG, PATH, TERM, HOME, etc.) + denylist |
| `npx -y <pkg>` hangs forever inside sandbox              | bwrap denies tmp/cache dir where npm writes        | Bind `--tmpfs /tmp` + `--bind <workspace>/.npm $HOME/.npm` |
| Python in venv can't find system libs                    | `/lib64` or `/usr/lib/x86_64-linux-gnu` not bound  | Add `--ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64` |
| `--allow-child-process` warning drowns the logs          | Expected — Node is noisy about this flag           | Silencing is downstream of testing; ignore              |
| Sandbox adds > 500ms per call                            | Heavy namespace-setup each invocation              | Acceptable tradeoff for security; document              |

### Verifying the sandbox is actually active

During SB1 — while the command runs — shell into the container and check:
```bash
docker exec "$CN" bash -c '
    ps -eo pid,ppid,comm,args | grep -E "bwrap|sh.*-c" | grep -v grep
'
# Expect: at least one "bwrap" line wrapping the child "bash -c echo..."
```

If no `bwrap` process appears during a long-enough command (SB6 is good for this — venv install takes seconds), the sandbox is NOT active and every SB test that "passed" was a false positive.
