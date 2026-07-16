# Comis Threat Model

This document defines the security boundaries Comis intends to enforce and the
risks an operator must still manage. It describes the current implementation,
not a guarantee that every deployment is secure.

Comis is a self-hosted, multi-agent daemon. Its agent runtime uses the
`@earendil-works/pi-coding-agent` SDK while Comis owns its domain contracts,
ports, policy, storage, channel adapters, and orchestration layers.

The central assumption is that **the model can be steered by untrusted
content**. Inbound messages, fetched pages, email, transcripts, tool results,
and MCP output can contain prompt injection. Authentication alone does not
contain a steered agent, so Comis layers authorization, validation, credential
handling, auditing, and process isolation.

## Assets

- provider, channel, gateway, OAuth, and integration credentials;
- message history, memory, workspace files, and generated artifacts;
- cross-session learned guidance, its provenance, and correction history;
- gateway and administrative control-plane access;
- host filesystem, network access, and compute budget;
- agent identity, configuration, capabilities, and cross-agent boundaries.

## Trust boundaries

| Principal or zone | Treatment |
|---|---|
| Operator and host OS | Trusted. A malicious operator, root process, or compromised host is out of scope. |
| Gateway clients | Authenticated by scoped bearer token and, when configured, mTLS. The gateway binds to loopback by default. |
| Model and agent output | Semi-trusted. Tool requests and completed responses pass through policy/guard layers. |
| External content | Untrusted. Guarded ingestion paths wrap it as data before prompt assembly. |
| Learned state | Semi-trusted persistent model input. Candidate or active guidance can affect later model choices, but it is not runtime authority. |
| Built-in tools | Authorized per agent and constrained by the relevant tool implementation. Not every tool is an OS-sandboxed process. |
| Exec child process | Confined only when a supported sandbox provider is available and active. |
| MCP stdio server | Separate third-party process outside the exec sandbox. Its executable and host privileges are operator-controlled. |
| Other agents | Logically scoped by agent/tenant configuration, storage queries, workspaces, and capabilities. The shared host remains trusted. |
| Upstream providers and chat platforms | External systems that receive data the operator deliberately routes to them. |

## Default posture

- `security.storage` defaults to `encrypted`.
- The gateway binds to `127.0.0.1` unless explicitly changed.
- log redaction and security audit events are enabled.
- the approval workflow defaults to **disabled** with unmatched actions in
  `auto` mode.
- the default agent tool-policy profile is **`full`**.
- an omitted or empty `agents.<id>.secrets.allow` list means unrestricted
  access through that agent's scoped secret manager; least privilege requires
  a non-empty allowlist.
- prompt-skill `permissions` and `allowedTools` declarations are parsed as
  metadata but are not an enforced per-skill runtime boundary.
- cross-session learning is enabled by default. Candidate guidance can be
  available before active promotion, and the default `single_owner`
  corroboration mode is not independent-source corroboration.
- exec sandbox configuration defaults to `always`, but ordinary `exec`
  currently falls back to unsandboxed execution if no provider is available.
- the Node.js permission model is disabled by default.

Operators must not describe destructive actions as human-approved unless they
have enabled, configured, and tested the approval workflow. Operators must not
describe a process as sandboxed based only on configuration; the runtime
provider must be verified on the deployed host.

## Learned-state and cross-session boundary

Learned guidance is persistent input to later model turns. It must be treated
as a security boundary, even though it is not executable code or a permission
system.

- Candidate guidance may surface before active promotion and influence which
  already-authorized tool the model requests.
- The default `single_owner` corroboration mode accepts repeated qualifying
  observations from one explicitly trusted owner. That is not independent
  corroboration. Operators can select the stricter `distinct_sessions` mode.
- Static validation blocks selected critical patterns, but warning-level
  harmful or jailbreak-like language can pass and remain persuasive to the
  model.
- Recall is scoped to the tenant and agent, not to an individual sender or end
  user. Per-user confidentiality requires separate tenants, agents, or another
  isolation layer.
- A recorded correction is an input to the correction and demotion gates. It
  does not guarantee immediate demotion, retirement, or a durable behavior
  change.
- Learned documents are advisory Markdown with no direct script or dynamic
  replay path. Learned text cannot by itself execute a command or grant a
  capability, credential, lease, approval, or larger budget.

Learned text can still steer the model toward an action that is already within
its configured reach. Capability checks, origin checks, tool policy, secret
scope, approvals on supported paths, budgets, leases, and process isolation
remain the enforceable boundaries.

## Defended threats

| Threat | Primary controls | Residual risk |
|---|---|---|
| Prompt injection leading to tool abuse | external-content wrapping, tool policy, capabilities, action classification, optional approvals, tool-specific validation | default tool policy is broad; approvals are opt-in; models can still choose harmful actions within granted authority |
| Secret leakage in config, logs, memory, or completed output | encrypted store, secret references, scoped secret access, structured redaction, memory-write validation, output guard | host compromise defeats at-rest encryption when the host can read both key and database; an empty per-agent secret allowlist is unrestricted; streaming deltas can precede final scanning |
| Unauthorized gateway access | loopback default, scoped tokens, timing-safe comparison, optional mTLS | network exposure without TLS can disclose bearer tokens; operator configuration controls reachability |
| SSRF on guarded web-fetch paths | URL validation for private, loopback, link-local, and metadata ranges; broker network modes on applicable jailed paths | not every network-capable integration shares the same fetch path; DNS and upstream behavior remain part of the threat surface |
| Path traversal through Comis file tools | `safePath`, symlink-aware validation, workspace scoping | unsandboxed shell commands do not inherit file-tool path restrictions |
| Memory poisoning and learned-state steering | memory-write validation, trust labels, provenance, configured corroboration, correction history, trust-ranked recall | candidate guidance can surface before promotion; warning-level harmful language can pass validation; learned text can influence authorized tool choice |
| Cross-agent confused-deputy calls | capability gates, origin/trust checks, scoped stores and workspaces | all agents share the trusted daemon and host; configuration mistakes can grant excessive capability |
| Vulnerable MCP integrations | opt-in configuration, manifest/tool filtering, eligibility checks, result sanitization, circuit breakers, malware advisory checks for supported stdio paths | MCP stdio processes run outside the exec sandbox with the daemon account's host privileges |
| Dependency tampering | exact version pins, automated audits, CodeQL, release provenance, bundled workspace packages | upstream dependency and build-system compromise cannot be eliminated |

## Process-isolation boundary

### Ordinary exec

The exec sandbox covers shell commands launched through the `exec` tool. On
Linux, a working Bubblewrap provider creates the strongest supported boundary.
On macOS, `sandbox-exec` is deprecated and treated as best effort. If the
provider is missing or unavailable, ordinary `exec` currently uses the command
validator and then runs without OS-level isolation.

The default exec network mode is open. Broker-only or no-network modes apply
only to specific daemon-launched workflows that request those modes. Do not
generalize broker-mediated egress to every shell or tool call.

### Terminal and durable orchestration paths

Some terminal and orchestration surfaces require a Linux jail and fail closed
or downshift when that jail cannot be established. Their stronger behavior
does not change the ordinary exec fallback described above.

### MCP and in-process tools

MCP stdio servers, in-process Node tools, and browser processes are not wrapped
by the exec sandbox. They have separate validation and authorization controls,
but no claim that "all tools are sandboxed" is accurate.

## Credential boundary

The encrypted store uses AES-256-GCM and a master key held in
`~/.comis/.env`. This protects a copied `secrets.db` when the attacker does not
also possess the master key. It does not protect against a compromised host or
daemon account that can read both. Losing the key makes the encrypted database
unrecoverable because Comis has no key escrow.

The credential broker keeps configured API keys out of selected driven-CLI
processes and injects them only for matching upstream bindings. It does not
broker every provider, OAuth/subscription CLI, MCP server, or network request.

Per-agent secret scoping is opt-in least privilege. A non-empty
`agents.<id>.secrets.allow` list restricts resolution to matching secret names.
When the field is omitted or resolves to an empty list, the scoped manager is
unrestricted rather than deny-all.

Prompt-skill manifests can declare `permissions` and `allowedTools`, but those
fields are not currently wired to a per-skill authorization or process sandbox.
Use agent tool policy, capability gates, and tool-specific validation as the
enforceable controls.

## Approval and action-classification boundary

Unknown actions default to the destructive classification. Classification is
an input to policy and audit; it is not itself a pause. The human approval gate
runs only when `approvals.enabled: true` and the specific execution path calls
it. The schema accepts ordered rules and a default mode, but they are not a
universal action-policy evaluator.

## Output and streaming boundary

The output guard scans a completed response and can sanitize the final value.
Non-streaming delivery can use that sanitized value. Streaming HTTP/SSE token
deltas are emitted while the model is generating, before the completed scan;
already-emitted deltas cannot be retracted. Sensitive deployments should
disable streaming or place a buffering/filtering boundary in front of it.

## Explicitly out of scope

- a malicious operator, root access, or compromised host/daemon account;
- confidentiality for data intentionally sent to a model provider, messaging
  platform, MCP server, or other configured integration;
- perfect prompt-injection detection or correctness of model output;
- full Linux-equivalent isolation on macOS, Windows, or Docker Desktop;
- denial of service by an operator-authorized workload beyond configured
  runtime budgets and resource controls;
- compromise of Node.js, the OS kernel, container runtime, or hardware;
- physical attacks, side channels, and upstream service compromise.

## Operator verification

Before accepting untrusted input:

1. run on a supported Linux host and verify Bubblewrap in daemon logs;
2. narrow the default `full` tool policy;
3. configure a non-empty secret allowlist for every agent that does not need
   unrestricted credential access;
4. enable approvals and test each guarded path if human confirmation is required;
5. keep the gateway on loopback or add scoped authentication and TLS;
6. back up and restrict the master key separately from the encrypted database;
7. review each prompt skill and MCP server as untrusted third-party content or
   process code, regardless of manifest declarations;
8. disable streaming where pre-scan disclosure is unacceptable;
9. run `comis doctor`, `comis security audit`, and
   `comis secrets audit --check` after configuration or host changes.
10. review learning corroboration and recall scope, and use separate tenants or
    agents where users must not share learned guidance.

## Reporting vulnerabilities

Do not open a public issue. Follow the private reporting instructions in
[`SECURITY.md`](./SECURITY.md).
