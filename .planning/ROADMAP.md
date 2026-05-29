# Roadmap: Comis

**Last reorganized:** 2026-05-29 (v1.4 Credential Broker — planning)

Comis is a security-first AI agent platform connecting AI agents to chat channels
(Discord, Telegram, Slack, WhatsApp, Signal, iMessage, IRC, LINE, Email). TypeScript
monorepo, 15 packages, hexagonal architecture. See `.planning/PROJECT.md` for current
state and `.planning/MILESTONES.md` for the full shipped history.

## Milestones

- ✅ **v1.0 — Observability & Troubleshooting** — shipped 2026-05-25 — `milestones/v1.0-ROADMAP.md`
- ✅ **v1.1 — MCP Hardening** — shipped 2026-05-26 — `milestones/v1.1-ROADMAP.md`
- ✅ **v1.2 — MCP Hardening II** — shipped 2026-05-28 — `milestones/v1.2-REQUIREMENTS.md`
- ✅ **v1.3 — MCP OAuth Handoff & Device-Flow** — shipped 2026-05-29 — `milestones/v1.3-ROADMAP.md`
- 🚧 **v1.4 — Credential Broker** — in progress (planning 2026-05-29)

---

## 🚧 v1.4 — Credential Broker

**Milestone Goal:** Let the `exec` sandbox drive API-key CLIs (Claude Code included) with the credential never inside the namespace — injected at the network boundary by an in-daemon MITM broker, made non-bypassable by kernel-enforced egress. Design spec: `.planning/design/credential-broker-implementation-tdd-2026-05-29.md`.

### Phases

- [x] **Phase 1: Injection Engine** - Provider-agnostic matcher, injection rules, default-Bearer, optional presets (design P0) — verified PASSED 4/4 (2026-05-29)
- [x] **Phase 2: Broker Core** - Single-use sessions, fail-closed request handling, injection wiring (design P1) — verified PASSED 7/7 (2026-05-29)
- [x] **Phase 3: CA Manager** - Own CA, bounded leaf-cert cache, ALPN-pin to http/1.1 (design P2) — verified PASSED 12/12 (2026-05-29)
- [x] **Phase 4: Finalizer Interface** - Body-aware finalizer stage; AWS SigV4 as tested no-op (design P3) — verified PASSED 7/7 (2026-05-30)
- [ ] **Phase 5: Forced Egress + Secure Credential Home** - Egress spike gate, --unshare-net, ~/.claude bind removal, per-spawn proxy env (design P4)
- [ ] **Phase 6: End-to-End + Observability** - Drive Claude Code via broker, broker:* events, property-tested non-leakage (design P5)
- [ ] **Phase 7: Documentation** - Mintlify docs, README benefit blocks, website updates — publish-gated on Phase 5 (design P6–P8)

### Phase Details

#### Phase 1: Injection Engine
**Goal**: A pure, exhaustively-tested provider-agnostic injection engine is available for the broker to consume — any host works via config with no curated entry, default-Bearer for the common case, with optional Anthropic/Finnhub presets as convenience sugar.
**Depends on**: Nothing (first phase)
**Requirements**: INJECT-01, INJECT-02, INJECT-03, INJECT-04
**Success Criteria** (what must be TRUE):
  1. An operator config binding with only a `secretRef` and no explicit rule causes `Authorization: Bearer <secret>` to be injected — no curated entry, no code change required for any host.
  2. All injection rule kinds (`setHeader` raw/bearer with `removeAuthorization`, `replaceHeader`, `removeHeader`, `setParam`) pass their edge-case matrix: `replaceHeader` is a no-op when the header is absent; `setParam` preserves existing query bytes verbatim and retains the URL fragment.
  3. Host matching rejects the bare suffix itself, mid-string containment, and non-suffix patterns; CONNECT authority normalization handles bracketed IPv6, FQDN trailing dot, and port stripping correctly.
  4. `expandPreset("anthropic", ref)` produces a binding identical to the equivalent hand-written config; the catalog module tree imports nothing from `@comis/skills` or `@comis/infra` (architecture guard passes).
**Plans**: 4 plans
Plans:
- [x] 01-01-PLAN.md — Provider-catalog types, matcher, injection engine (RED/GREEN TDD)
- [x] 01-02-PLAN.md — Path policy, resolveBinding, default-Bearer (RED/GREEN TDD)
- [x] 01-03-PLAN.md — CONNECT authority normalization, IPv6 edge cases (RED/GREEN TDD)
- [x] 01-04-PLAN.md — Presets, barrel exports, catalog-purity architecture guard

#### Phase 2: Broker Core
**Goal**: The in-daemon MITM broker accepts driven-CLI connections, issues and validates single-use timing-safe session tokens, resolves secrets per-request from SecretManager, injects credentials, and fails closed in every error scenario — a missing secret never forwards the request.
**Depends on**: Phase 1
**Requirements**: BROKER-01, BROKER-02, BROKER-03
**Success Criteria** (what must be TRUE):
  1. A request carrying a missing or forged `Proxy-Authorization` token is refused with 407 and never forwarded; a consumed (single-use) or torn-down token produces the same 407.
  2. The placeholder value sent by the driven-CLI never reaches the upstream fixture — the broker substitutes the real secret resolved per-request from SecretManager, which is never cached to disk.
  3. A `SecretManager.get` miss returns 502 with zero upstream calls; an unlisted host returns 403; a path violating `pathPolicy` returns 403 — fail-closed in all three cases.
  4. Every secret resolution emits a `secret:accessed` audit event with `agentId` (platform-secret bypass audited, never silent).
**Plans**: 4 plans
Plans:
- [ ] 02-01-PLAN.md — Compile prerequisites: exports/security.ts re-exports + CaManagerPort stub
- [ ] 02-02-PLAN.md — TDD: SessionManager single-use timing-safe token lifecycle (BROKER-01)
- [ ] 02-03-PLAN.md — TDD: NodeMitmBroker CONNECT proxy, fail-closed, injection, audit (BROKER-01..03)
- [ ] 02-04-PLAN.md — Barrel wiring + pnpm validate gate

#### Phase 3: CA Manager
**Goal**: The broker can terminate TLS for any allow-listed hostname using a self-signed CA and per-host leaf certs — a client trusting `NODE_EXTRA_CA_CERTS` pointing at the broker CA completes the full TLS handshake, and the leaf-cert cache is bounded to prevent unbounded memory growth.
**Depends on**: Phase 1
**Requirements**: CA-01, CA-02
**Success Criteria** (what must be TRUE):
  1. The broker CA key file is written with mode `0o600`; restarting the daemon reuses the same CA (same issuer DN) rather than regenerating.
  2. A leaf cert within one hour of expiry is automatically re-minted; the cache enforces a hard cap and evicts entries past it (no unbounded growth, unlike OneCLI's `DashMap`).
  3. Every leaf cert has `SAN = dnsName(hostname)` and the TLS server context advertises only `http/1.1` (ALPN-pinned, no h2 MITM surface).
  4. A TLS client configured with `NODE_EXTRA_CA_CERTS=<broker-ca.pem>` completes a full handshake end-to-end through the broker.
**Plans**: 3 plans
Plans:
**Wave 1**
- [x] 03-01-PLAN.md — Supply-chain gate: 12 exact-pinned deps + pnpm install + pnpm cycles

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 03-02-PLAN.md — TDD: NodeCaManager CA-01/CA-02 (0o600, idempotent reuse, bounded cache, refresh buffer, SAN, ALPN, E2E handshake)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 03-03-PLAN.md — Barrel wiring + broker TLS-upgrade seam + pnpm validate gate

#### Phase 4: Finalizer Interface
**Goal**: A body-aware finalizer stage runs after header/param injection; the AWS SigV4 finalizer ships as a tested no-op pass-through that logs the deferral, leaving the pipeline wired and the interface verified without executing signing.
**Depends on**: Phase 2
**Requirements**: FINAL-01
**Success Criteria** (what must be TRUE):
  1. The finalizer runs after injection (ordering verified via spy); requests with no finalizer rule pass body and headers through byte-identical.
  2. The `awsSigV4` finalizer leaves body and headers unchanged and logs `step="finalizer_skipped" hint="sigv4 deferred"` — the interface is exercised and the deferral is observable in logs.
  3. A request body exceeding the cap returns 413 (body-size cap enforced at the finalizer stage).
**Plans**: 3 plans
Plans:
**Wave 1** *(independent, can run in parallel)*
- [x] 04-01-PLAN.md — broker:denied reason union extension (body_too_large) in events-infra.ts
- [x] 04-02-PLAN.md — finalizer-stage.ts TDD: bufferBody, runFinalizer, runAwsSigV4Finalizer (RED/GREEN unit tests)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 04-03-PLAN.md — mitm-broker.ts Step 6.5 seam wiring + integration tests FINAL-01a/b/c/d

#### Phase 5: Forced Egress + Secure Credential Home
**Goal**: The credentialed sandbox is kernel-locked to the broker as its only egress path — a direct connection to any non-broker host has no route, and the `~/.claude` binds are removed so no credential file is reachable inside the sandbox. The forced-egress spike (design R1) is the **first deliverable** of this phase and gates all subsequent work; if rootless `--unshare-net` + broker-only routing is not achievable on the production host class, the phase stops and the broker design is reconsidered.
**Depends on**: Phase 2, Phase 3, Phase 4
**Requirements**: EGRESS-01, EGRESS-02, EGRESS-03, EGRESS-04
**Success Criteria** (what must be TRUE):
  1. The forced-egress spike is validated on the production host class (rootless bwrap): `--unshare-net` + broker-only routing is confirmed achievable (slirp4netns, veth+nftables, or unix-shim) before any P4 implementation commits. *(Hard gate: failure stops the milestone and triggers design reconsideration.)*
  2. Under the secure profile, `exec curl example.com` fails with no-route while a driven-CLI request through the broker succeeds — the broker is the only reachable egress.
  3. `exec env`, `exec cat /proc/self/environ`, and `exec cat ~/.claude/.credentials.json` inside the secure sandbox reveal no key, no placeholder, and no credential file (`~/.claude` RW binds absent).
  4. Only the driven-CLI spawn receives `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and the placeholder key; a sibling general `exec` in the same session receives none of these (property-tested across all spawn paths).
  5. A WebSocket upgrade from the credentialed sandbox under broker-only egress fails with a documented, actionable error rather than silently hanging (fail-closed WS guard, EGRESS-04).
**Plans**: 5 plans
Plans:
**Wave 1** *(independent, can run in parallel)*
- [ ] 05-01-PLAN.md — Interface contracts: broker:denied reason union, SandboxOptions.network, ExecToolDeps.brokerSpawnEnv
- [ ] 05-02-PLAN.md — R1 spike Linux-gated integration harness (bwrap-egress-integration.test.ts, skip-on-darwin)

**Wave 2** *(blocked on Wave 1 completion)*
- [ ] 05-03-PLAN.md — TDD: bwrap secure profile (--unshare-net, secureCredentialHome, credential bind removal) (EGRESS-01/02/03)
- [ ] 05-04-PLAN.md — TDD: WS upgrade fail-closed guard + additive startUnixSocket (EGRESS-04, EGRESS-01 seam)

**Wave 3** *(blocked on Wave 2 completion)*
- [ ] 05-05-PLAN.md — TDD: buildExecEnv brokerSpawnEnv merge-last + pnpm validate gate (EGRESS-03)

#### Phase 6: End-to-End + Observability
**Goal**: An agent can drive Claude Code through the broker against a fixture upstream that receives the real key, while the broker emits a complete, redaction-by-construction `broker:*` event taxonomy and non-leakage is property-tested — no sentinel secret ever appears in any log or event under any path.
**Depends on**: Phase 5
**Requirements**: E2E-01, OBS-01, OBS-02
**Success Criteria** (what must be TRUE):
  1. An end-to-end test drives `claude -p` through the broker; the fixture upstream receives `x-api-key: <REAL>` and responds 200; a sibling `exec` in the same session cannot recover the key via env, proc, file, or curl-to-self.
  2. All seven `broker:*` event types (`session_opened`, `session_closed`, `request`, `injected`, `denied`, `credential_unavailable`, `egress_blocked`) are emitted with correct structural fields and no secret values; `broker:egress_blocked` carries a hash of the target host, not the plaintext hostname.
  3. Every pipeline log stage carries `traceId`, `agentId`, and `step`; every failure log carries `err`, `errorKind`, and a non-empty `hint`; param-injection hosts never emit a full URL in any log or event.
  4. A property test with a sentinel secret confirms it never appears in any captured log line or bus event across all broker code paths, including query-param injection.
**Plans**: TBD

#### Phase 7: Documentation
**Goal**: Technical docs (`docs/`, Mintlify), README benefit blocks, and website (`website/`, Astro) all land with claims verified against shipped P0–P5 code, Mintlify and Astro builds clean, no broken internal links, and the publish gate honored — containment claims ("non-bypassable", "kernel-locked egress") appear only after Phase 5 is green on the production host class.
**Depends on**: Phase 5, Phase 6
**Requirements**: DOCS-01, DOCS-02, DOCS-03
**Success Criteria** (what must be TRUE):
  1. `docs/security/credential-broker.mdx` is registered in `docs.json` under the Security tab, the Mintlify build passes clean, and every reference (flag names, config keys, event names) is verified against the shipped codebase.
  2. README blocks 1–5 are pasted with all `‹…›` placeholders resolved to real values (provider count, deep-dive URL, egress mechanism name); the publish-gate checklist from the README benefit draft is fully ticked; containment claims are present only because Phase 5 is green.
  3. `pnpm --filter comis-website build` runs clean; the homepage Security, Features, and Comparison components reflect the broker differentiator; `comis.ai/security` resolves and carries the broker deep-dive section; no unverified numbers across docs, README, or website. The `executor.broker` config example is byte-identical across all three surfaces.
**Plans**: TBD
**UI hint**: yes

### Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Injection Engine | 4/4 | Complete    | 2026-05-29 |
| 2. Broker Core | 4/4 | Complete    | 2026-05-29 |
| 3. CA Manager | 3/3 | Complete    | 2026-05-29 |
| 4. Finalizer Interface | 3/3 | Complete    | 2026-05-29 |
| 5. Forced Egress + Secure Credential Home | 0/5 | Not started | - |
| 6. End-to-End + Observability | 0/TBD | Not started | - |
| 7. Documentation | 0/TBD | Not started | - |

---

## Shipped Milestone Detail

<details>
<summary>✅ v1.3 — MCP OAuth Handoff & Device-Flow (2 phases, 13 plans) — SHIPPED 2026-05-29</summary>

- [x] Phase `01-handoff-mcp-oauth-handoff` — Structural OAuth handoff (R11), RPC-boundary tag (R8.4′), URL/short-code preservation (R9-EDGE), token-store memoize (R8.1/8.3), output-guard lock (R4.6), warm-venv seed (R7.3) — verified PASSED 11/11 (2026-05-28)
- [x] Phase 9 `09-oauth-device-flow` — RFC 8628 device-authorization grant for headless/VPS (DEVAUTH-01..06) — verified PASSED 5/5 + 6/6, operator-verified live VPS install (2026-05-29)

Full detail: `milestones/v1.3-REQUIREMENTS.md` + the per-phase `VERIFICATION.md` files.

</details>

<details>
<summary>✅ v1.0 — Observability Initiative (Phases 1–6 + M3) — SHIPPED 2026-05-25</summary>

Trace propagation & lifecycle envelopes, trajectory bridge expansion (18→55 events) +
defense-in-depth payload bounding, boot invariants + dedup detector, session DAG + bundle
exporter, trajectory pointer + platform-aware redaction, operator `comis trace` CLI +
`/export-trajectory`, log rotation + alert budget, `step:` pipeline discipline, operator docs.

Full detail: `milestones/v1.3-ROADMAP.md` (the original "Observability Initiative" roadmap,
archived at v1.3 close — see its header note). Its Phases 7–8 entries are stale/abandoned;
the M3 deliverables they describe actually shipped under v1.0.

</details>
