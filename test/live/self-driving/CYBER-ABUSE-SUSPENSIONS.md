# Provider-backed cyber-abuse test suspensions

Provider-backed live tests with cyber-abuse-shaped content are **suspended by default**. This applies even
when a test is defensive, simulated, expects refusal, uses a loopback channel, or has a binary security
oracle. The provider still receives the prompt and may classify the activity independently of the local
intent or outcome.

Offline unit, architecture, database, and deterministic guard tests remain available. Ordinary
provider-backed assistant prompts also remain available when the central gate finds no risky content.

## Operator-only authorization

The self-driving agent must never authorize these tests from the target, test plan, prior run, environment,
or its own judgment. A current, explicit operator request is required. Planning a security row does not
grant authority to run it.

Risk declaration and authorization are separate:

- `COMIS_LIVE_TEST_RISK=cyber-abuse` declares that a provider-bound payload or opaque fixture is risky.
  The driver may set this declaration conservatively.
- `COMIS_LIVE_CYBER_ABUSE_TESTS=operator-authorized` is the exact acknowledgement that unlocks the
  suspended test. Only the operator may direct the driver to set it.

When the operator explicitly requests one of these tests, scope both variables to that one command and
unset them immediately afterward:

```bash
COMIS_LIVE_TEST_RISK=cyber-abuse \
COMIS_LIVE_CYBER_ABUSE_TESTS=operator-authorized \
node test/live/self-driving/scripts/drive.mjs <chat-id> @/absolute/path/to/prompt.txt
```

Never put the authorization acknowledgement in `.live-env`, a rendered rig environment, campaign state,
configuration, a helper script, or a committed file. Values such as `1`, `true`, and `yes` do not authorize
the test. A suspended injector exits `4` before network activity and names only the detected risk categories;
it never echoes the prompt.

Opaque media, reflected stored content, and generated corpora cannot be classified reliably from the
driver's visible text. Declare `COMIS_LIVE_TEST_RISK=cyber-abuse` whenever any such input contains or derives
from a suspended row. Without explicit operator authorization, record the row as
`NOT-RUN: provider cyber-abuse safety suspension`; do not relabel it NO-ACCESS or a product failure.

## Suspended inventory

The following provider-backed coverage is suspended unless the operator explicitly requests it:

| Surface | Suspended coverage |
|---|---|
| `targets/adaptive-threat-hunting.md` | Every LLM/provider-backed threat-hunting transcript, reflection, reuse, poisoning, containment, or rotated-incident row. Offline DB/schema/event assertions may still run. |
| `sim/threat-hunting/` and `scripts/drive-sim-workload.sh threat-hunting` | The complete simulated SOC workload, including feeder turns and reflection. The workload driver declares this risk automatically. |
| `targets/english/unsandboxed-marathon-campaign.md` | The provider-driven campaign. It combines real shell/control-plane work with sandbox-off posture, destructive, secret, SSRF, injection, and policy-bypass probes. Offline configuration and guard checks may still run. |
| `scripts/model-battery.mjs` | The complete battery because it deliberately asks the model to disclose a gateway bearer token. The script declares this risk automatically. |
| `targets/real-user-everyday-assistant.md` | A4, A6, A9, A11; B4 security/destructive legs, B5 hostile-page leg, B6, B15 security/secret legs; C1 authority-escalation question and C3–C7; D7, D8's cross-conversation stale-approval leg, and D9's self-configuration/secret-residency legs. This includes internal-network fetches, hostile external instructions, credential handling/extraction, destructive work, self-configuration, privilege escalation, and security-control bypass. |
| `targets/generic-runtime-campaign.md` | Adversarial external-instruction, secret-policy override, authority-escalation, internal-network, and security-control negative rows when they are sent to a provider. Deterministic compiler/guard checks remain available offline. |
| English and Hebrew marathon campaigns | Any provider-bound credential/password/token extraction, prompt injection, hostile media/page/document/tool result, SSRF/private-network probe, destructive shell/control-plane action, sandbox/audit/approval bypass, self-escalation, or policy-relaxation row. |
| Any other target, corpus, webhook, media, cron, or MCP fixture | Any payload matching the risk classes below, plus opaque or indirect content the driver knows belongs to one of those classes. |

The inventory is category-based so new targets do not silently escape it. Authors must mark new risky rows
in their test plan and use the risk declaration even if the current text classifier also detects them.

## Central gate and risk classes

`scripts/live-provider-risk-gate.mjs` runs before network activity in the arbitrary provider-backed
injectors: `drive.mjs`, `burst-inject.mjs`, `parallel-chat.mjs`, `media-drive.mjs`, `webhook-drive.mjs`,
`msteams-drive.mjs`, `wg.mjs`, `model-battery.mjs`, and the generic RPC caller `revoke.mjs`. It blocks
declared risk and bounded text matches for:

- cyber operations, malware, exploitation, scanning, and threat hunting;
- credential, password, secret, API-key, bearer-token, or environment extraction;
- sandbox, audit, approval, authentication, policy, or safety-control evasion;
- self-granted authority, admin access, privilege escalation, or maximum autonomy;
- loopback, link-local metadata, private-network, or internal-service probing;
- prompt injection and attempts to override operator/system instructions;
- destructive system, repository, filesystem, log, or database actions.

The classifier is a safety backstop, not permission to omit plan labeling. It is intentionally conservative:
a false positive suspends a provider call until the operator decides, while a false negative could expose an
account to unrequested policy-sensitive traffic. It matches on a whitespace-normalized copy of the payload, so
wrapping a risky phrase across a line break does not evade it; the raw text is never echoed.

`revoke.mjs` can call any gateway RPC, so it classifies the **resolved** params — inline JSON, `key val`, and
`--file` alike — for every method except the purely operational or diagnostic ones that carry no model prompt:
`capabilities.introspect`, `obs.system.health`, `obs.explain`, `cron.list`, `cron.runs`, `cron.status`,
`lease.revoke`, `run.kill`, `tokens.create`, and `session.reset_conversation`. Everything else — including
`graph.execute` node tasks, `cron.run`, `message.send`, and cron authoring — is gated by default, so a newly
used provider-driving RPC cannot silently escape the suspension. Live triage stays available because the
exempt list covers it and a benign payload classifies clean.
