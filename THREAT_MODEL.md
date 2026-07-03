# Comis Threat Model

> **Status:** Living document. Last reviewed 2026-06-04.
> **Companion docs:** vulnerability reporting and disclosure live in [`SECURITY.md`](./SECURITY.md); deeper mechanism docs live under [`docs/security/`](./docs/security/). This file is the canonical statement of *what Comis defends, what it does not, and where the residual risk is.*

Comis is a **headless, multi-agent daemon** that connects autonomous AI agents to chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email). It runs on a single trusted host, is mTLS/token-gated, binds to loopback by default, and is designed so that an operator can run *multiple agents and multiple operators* against one install with isolated memory, budgets, and tool policies per agent.

The defining assumption of this threat model is unusual and load-bearing: **the LLM agent is treated as a potential adversary.** A model can be steered by prompt injection embedded in any content it reads (an inbound chat message, a fetched web page, an email, a transcript, an MCP tool result). So the security architecture is built to contain what a *steered* agent can do — not merely to authenticate the humans talking to it.

---

## 1. System & deployment model

| Deployment | How it runs | Notes |
|---|---|---|
| **Direct / systemd (production)** | `node --permission …/daemon.js` with `COMIS_CONFIG_PATHS` set | The Node permission model restricts filesystem/network at the runtime level; the published install and VPS path use this. |
| **Docker** | Non-root `USER comis` (uid 1000), exact-pinned image | Kernel sandbox (bubblewrap) availability depends on the host/container config. |
| **pm2 (development only)** | Convenience wrapper | Not a production path. |

Data lives in `~/.comis` (config, SQLite memory DB, the master key in `~/.comis/.env` at mode `0600`, OAuth/session state). The gateway defaults to **`127.0.0.1:4766`** (secure-by-default; `0.0.0.0` is an explicit opt-in).

---

## 2. Trust boundaries

| Zone / principal | Trust | Rationale |
|---|---|---|
| **Operator + host OS** | **Trusted** | Holds the master key, config, and the SQLite DB. Comis does not defend against a malicious operator or a compromised host. |
| **Gateway / RPC / WS clients** (CLI, web dashboard, MCP clients) | **Authenticated** | mTLS and/or scoped, constant-time bearer tokens. No human passwords — identity is cryptographic. |
| **The LLM agent + model provider** | **Semi-trusted / potentially steered** | Treated as a confused-deputy risk: its *output and tool requests* are constrained, classified, and filtered. |
| **Tools / skills executing agent intent** | **Confined** | Run under a kernel sandbox with broker-mediated egress; classified by risk; destructive actions gated. |
| **External content** (inbound messages, web-fetch, email, transcripts, MCP results) | **Untrusted** | Wrapped as data before reaching a prompt; never placed in the system role. |
| **Upstream APIs** (model providers, channel platforms, web) | **External** | Reached only through the credential broker (for keyed APIs) or validated URLs. |
| **Other agents in the fleet** | **Mutually isolated** | Per-agent scoped secrets, config, workspace, and budgets. |

---

## 3. What Comis defends against (in scope)

For each threat, the primary control(s):

| Threat | Primary control(s) |
|---|---|
| **Prompt-injection → tool/shell abuse** | Kernel sandbox (`bwrap` / `sandbox-exec`), runtime **action classification** (destructive ⇒ confirmation), broker-only network egress, `OutputGuard` on responses |
| **Secret exfiltration** (to the model, into logs, over the wire, into memory) | `SecretManager` (no-enumeration), the **credential broker** (the agent only ever holds a placeholder), Pino auto-redaction, `OutputGuard` + secret-egress scrubber, `MemoryWriteValidator` |
| **Unauthorized gateway / RPC access** | mTLS (`mtls-verifier`) + scoped, `timingSafeEqual` tokens (`token-auth`), loopback-by-default bind |
| **SSRF from agent web tools** | `validateUrl()` (blocks private/loopback/link-local + cloud-metadata ranges) **and** kernel broker-only egress |
| **Memory poisoning** | `validateMemoryWrite()` — `clean` ⇒ store, `warn` ⇒ store at downgraded `external` trust, `critical` ⇒ block; trust-ranked recall |
| **Malicious / vulnerable MCP servers** | OSV (`MAL-*`) pre-spawn scan, sandboxed spawn, circuit breakers, resource probes; the MCP **server** endpoint is default-deny with per-client allowlists + rate limits |
| **Supply-chain tampering** | Exact-pinned deps (no `^`/`~`), bundled `private` workspace packages, **sigstore provenance** (GitHub OIDC), `pnpm audit --prod`, CodeQL |
| **Cross-agent interference** | `ScopedSecretManager` + per-agent config/workspace/budgets; `secret:accessed` audit events |
| **Path traversal / symlink escape** | `safePath()` (ESLint-enforced; raw `path.join` is banned) |
| **Credential leakage via logs** | "never log secrets" rule + Pino redaction (`apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, `cookie`, `webhookSecret`, 3 levels deep) |

---

## 4. What Comis explicitly does NOT defend against (out of scope)

Stated plainly, in the spirit of an honest threat model:

- **A compromised host or malicious operator.** The operator holds the master key, config, and DB. Root-on-the-box ends the game.
- **Full kernel sandboxing on non-Linux hosts.** The kernel sandbox (`bwrap`) is **Linux-only**. macOS uses `sandbox-exec` (best-effort SBPL); Docker-Desktop/Windows run the `exec`/`terminal` tools **unsandboxed**. See §8.
- **The `exec` tool on a host with no sandbox provider** — it currently **fails open** (runs `/bin/bash -c` directly). See §8.
- **A fully adversarial model provider** beyond what injection-wrapping and the output guard catch. Provider output is semi-trusted, not zero-trusted.
- **Brokering OAuth / subscription-token CLIs.** The credential broker injects header/query API-key and bearer credentials for configured host+path bindings; OAuth-flow CLIs are not yet brokered. See §8.
- **Resource exhaustion / DoS from the operator's own agents.** Per-agent budgets exist as a cost/safety aid, not a hard security boundary.
- **Confidentiality of data the operator deliberately routes to third-party model providers or chat platforms.** That is an operator policy choice.
- **Physical access, side channels, and compromise of Node.js / the OS itself.**

---

## 5. Threat model by surface

### 5.1 Agent action classification (the runtime risk tier)

Every agent-driven action is classified by `ActionClassifier` into one of three tiers. **Unknown actions default to `destructive` (fail-closed).** The registry is **locked after bootstrap** so a malicious plugin cannot downgrade a classification at runtime.

| Class | Disposition | Examples |
|---|---|---|
| `read` | No side effects — auto-approved | `file.read`, `web.fetch`, `web.search`, `memory.search`, `session.history`, `channels.list` |
| `mutate` | Reversible side effects — logged, auto-approved | `file.write`, `message.send`, `memory.store`, `browser.navigate`, `model.switch`, `discord.pin` |
| `destructive` | Irreversible / high-risk — **requires confirmation** | `file.delete`, `memory.clear`, `system.exec`, `system.shutdown`, `tokens.revoke`, `channels.disable`, `agents.delete`, `discord.ban` |

Confirmation gating for `destructive` actions is described in [`docs/security/approvals.mdx`](./docs/security/approvals.mdx). Classified `audit:event` actions and the security-decision events (secret access, injection detection, injection-rate breach, canary leaks, implied-tool-call isolation, command blocks, and sandbox-downgrade refusals) are persisted to a durable, queryable audit — the `obs_audit_events` SQLite table plus the `0600` `security-audit.jsonl` — and surfaced via `comis security audit-log` / `obs.audit.query` (`docs/security/audit.mdx`).

### 5.2 Tool / shell execution confinement

| Layer | Control | Residual risk |
|---|---|---|
| Kernel isolation | Linux `bwrap --unshare-all` (mount/PID/user/cgroup/IPC/net namespaces), `--die-with-parent`, `--new-session`, `--proc`/`--dev`, tmpfs `/tmp`; macOS `sandbox-exec` (deny-default SBPL) | Non-Linux is best-effort; absent provider ⇒ `exec` fails open (§8) |
| Network egress | `broker-only` mode: `--unshare-net` + bind-mount **only** the broker unix socket — egress is kernel-impossible except through the broker | — |
| Filesystem | Workspace bind is the only general RW; system paths read-only; `~/.ssh`/`~/.gnupg` never mounted | `bash` in an unsandboxed deployment bypasses path confinement (§8) |
| Command firewall | `exec-security`: shell-quote state machine, compound-command splitting, `SAFE_ENV_VARS` allowlist (fail-closed), protected-path + redirect-target guards | String-parsing heuristics are defense-in-depth behind the sandbox, not a sole control |

See [`docs/security/sandbox.mdx`](./docs/security/sandbox.mdx) and [`docs/security/exec-sandbox.mdx`](./docs/security/exec-sandbox.mdx).

### 5.3 Secrets — at rest and in transit

- **At rest:** `SecretsCrypto` uses **AES-256-GCM** with a per-encryption random salt and **HKDF-SHA256** key derivation; the 32-byte master key lives in `~/.comis/.env` at `0600`, written atomically.
- **No enumeration:** `SecretManager` exposes `get`/`has`/`require`/`keys` only — there is no `getAll()`. `ScopedSecretManager` glob-filters keys per agent and emits `secret:accessed` audit events. Platform secrets are never resolvable through user-facing secret-ref tools.
- **In transit (the credential broker):** driven CLIs receive a **placeholder** key. The broker (`NodeMitmBroker`) terminates the CONNECT tunnel with its own CA, matches host+path against a binding allow-list, swaps the placeholder for the real secret resolved from `SecretManager`, and forwards. It **fails closed** (407/403/502 with the client socket destroyed *before* any upstream connection — zero upstream bytes on a gate failure), caps headers at 8 KB (request-smuggling defense), and never passes the secret to a logger or event payload (`broker:injected`/`broker:denied`/`broker:egressBlocked` carry `ruleKind`+`host`, never the secret).

See [`docs/security/secrets.mdx`](./docs/security/secrets.mdx) and [`docs/security/credential-broker.mdx`](./docs/security/credential-broker.mdx).

### 5.4 Gateway / RPC / network

- **mTLS** (`mtls-verifier`): cert/key/CA PEM + X.509 expiry validated at startup (fail-fast).
- **Scoped tokens** (`token-auth`): compared with `timingSafeEqual`; scopes `rpc` / `ws` / `admin` / `mcp-client`; no-enumeration `TokenStore.verify`.
- **Secure-by-default bind:** `127.0.0.1:4766`.
- **MCP server endpoint:** default-deny tool exposure, per-client allowlists, `admin`+`mcp-client` co-issuance blocked (schema *and* endpoint — defense-in-depth), 30 calls/min/tool.

See [`docs/security/hardening.mdx`](./docs/security/hardening.mdx).

### 5.5 Prompt injection & untrusted content

- **Input:** `wrapExternalContent()` wraps every external text flow (chat, email, web-fetch, transcripts, MCP results) as delimited *data* (using a per-request `contentDelimiter` carried on the request context) — never placed in the system role.
- **Pattern library:** a 70+ entry injection-pattern set (invisible characters, jailbreak phrasings, role-markers, prompt-extraction, dangerous commands) feeds the input-side guards and `validateMemoryWrite`; an injection rate-limiter throttles repeated attempts.
- **Output:** `OutputGuard` scans model output for secret formats (AWS/GitHub/Slack/Anthropic/OpenAI/Telegram/Discord/Google keys, JWTs, DB connection strings), redacts criticals, detects canary leakage, and flags prompt-extraction attempts.
- **Canary:** `CanaryToken` issues a deterministic HMAC-SHA256 per-session canary that survives context compaction; leakage is detected by the output guard and redacted.

### 5.6 Memory poisoning

`validateMemoryWrite()` runs before every agent-visible memory store: a secret-egress scan (redaction ⇒ `critical` ⇒ blocked), then suspicious-pattern detection (`critical` ⇒ blocked; jailbreak patterns ⇒ stored at downgraded `external` trust). Recall is trust-ranked (`system > learned > external`), and `external`-trust content cannot be written into the user-representation/relationship tables.

### 5.7 MCP (client + server)

- **As client:** pre-spawn OSV vulnerability scan (`MAL-*` advisories), sandboxed subprocess spawn with resource probes, circuit breakers, redirect policy, result sanitization, and a full OAuth subsystem (device-flow / browser-callback / token-store).
- **As server:** the gateway MCP endpoint is default-deny (§5.4).

### 5.8 Supply chain

The supply chain *is* part of the threat model. All `dependencies`/`devDependencies` are **exact-pinned** (no `^`/`~`); `@comis/*` workspace packages are `private` and bundled via `bundledDependencies` (no runtime `npm install` of plugins); releases are **sigstore-attested via GitHub OIDC** (`pnpm publish --provenance`); `pnpm audit --prod` and CodeQL run in CI. **Accurate dependency posture:** Comis owns its *domain types* (e.g. `NormalizedMessage`, `ChannelPort`, `ExecutionGraph`) in-tree, but the agent **runtime** is built on the pi-mono SDK (`@earendil-works/pi-coding-agent` and siblings) and depends on provider/channel SDKs (`openai`, `@google/genai`, `discord.js`, `@slack/*`, …). These are exact-pinned and bundled — *part of* the threat model, not something Comis is independent of (see §8).

---

## 6. Defense-in-depth summary

| Layer | Controls |
|---|---|
| **Compile-time / CI** | `eslint-plugin-security` + custom rules (ban `eval`/`Function()`, raw `path.join`, direct `process.env`, empty `.catch`, `"[REDACTED]"` literal); ~70 architecture tests incl. a TypeChecker **secret-residency** walker (proves RPC handlers don't retain plaintext secrets); CodeQL; `pnpm audit --prod` |
| **Runtime** | Kernel sandbox + broker-only egress; `ActionClassifier` (fail-closed, locked registry); `SecretManager` no-enumeration; `validateUrl` SSRF guard; `OutputGuard` + `CanaryToken`; `validateMemoryWrite`; Pino redaction; Node `--permission` model |
| **Supply chain** | Exact pins, bundled private packages, sigstore provenance, MCP OSV scan |

The engineering **Risk Tiers** (AGENTS.md §4) escalate review for changes under `core/src/security/*`, `core/src/ports/*`, `gateway/*`, `daemon/*`, `core/src/config/`, `core/src/domain/`, and `injection-patterns.ts` — these are **High** tier and require boundary + failure-mode tests and downstream-consumer review.

---

## 7. Known limitations & gaps (honest)

Severity is the impact *if* the precondition is met.

| # | Gap | Severity | Status / mitigation |
|---|---|---|---|
| G1 | **Kernel sandbox is Linux-only.** macOS uses best-effort `sandbox-exec`; Docker-Desktop/Windows run `exec`/`terminal` tools unsandboxed. | High (non-Linux) | Documented; Linux is the supported production target. Operators on other platforms should treat tool execution as unconfined. Known gap — not yet tracked as a standalone issue; Linux is the documented production target. |
| G2 | **`exec` tool fails *open* when no sandbox provider is detected** (runs `/bin/bash -c` directly), unlike the `terminal` driver which fails closed. | High (misconfigured host) | Make `exec` fail closed to match the terminal driver. Defense-in-depth (command firewall, secret-egress scrubber, `SecretManager`) still applies. Known gap — not yet tracked as a standalone issue. |
| G3 | **Credential broker does not broker OAuth / subscription-token CLIs** — only header/query API-key + bearer injection for configured bindings. | Medium | OAuth CLIs run with their own token handling outside the broker's per-request injection. Known gap — not yet tracked; the credential broker's scope is defined in AGENTS.md §3.4. |
| G4 | **DNS-rebinding TOCTOU window** in `validateUrl` (resolve-then-fetch). | Low–Medium | Broker-only egress eliminates it for sandboxed tools; non-sandboxed fetch paths retain a narrow window. Known gap — not yet tracked; broker-only egress mitigates for sandboxed tool paths. |
| G5 | **File-size governance debt** — a number of `deferred` allowlist entries exceed the 800-line cap (e.g. the daemon composition root). | Low | Tracked via `test/architecture/file-size.test.ts` fileSizeAllowlist (shrink-only entries marked `deferred`). |
| G6 | **Documentation accuracy.** Two public claims are easy to overstate and are pinned by a CI guard (`security-doc-claims.test.ts`): skills are sandboxed by OS-level `bwrap`/`sandbox-exec` (not `isolated-vm`), and the agent runtime is built on `@earendil-works/pi-coding-agent` (Comis is not SDK-free). This file is the source of truth for both. | — | CI-guarded against regression. |

Self-reported benchmark figures (memory accuracy, cache savings) are **self-authored, small-N, and LLM-judged** — directional, not independent guarantees; see the project's `known-limitations` reference.

---

## 8. Reporting a vulnerability

Do **not** open public issues for vulnerabilities. Use the private reporting channel and follow the coordinated-disclosure process and response SLA documented in [`SECURITY.md`](./SECURITY.md).

---

## 9. References

- [`SECURITY.md`](./SECURITY.md) — reporting & disclosure policy
- [`docs/security/index.mdx`](./docs/security/index.mdx) — security overview
- [`docs/security/defense-in-depth.mdx`](./docs/security/defense-in-depth.mdx)
- [`docs/security/sandbox.mdx`](./docs/security/sandbox.mdx) · [`exec-sandbox.mdx`](./docs/security/exec-sandbox.mdx)
- [`docs/security/credential-broker.mdx`](./docs/security/credential-broker.mdx) · [`secrets.mdx`](./docs/security/secrets.mdx) · [`oauth.mdx`](./docs/security/oauth.mdx)
- [`docs/security/approvals.mdx`](./docs/security/approvals.mdx) · [`audit.mdx`](./docs/security/audit.mdx) · [`hardening.mdx`](./docs/security/hardening.mdx)
- `AGENTS.md` §2.2 (ESLint-enforced security), §4 (Risk Tiers) — engineering protocol
