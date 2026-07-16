---
name: Open Evidence Proposal
about: Propose a reproducible workload, attack path, learning failure, or integration result
title: "[Evidence] "
labels: ''
assignees: ''
---

> Comis Open Evidence is a planned public umbrella, not a shipped runner,
> certification, or formal governance program. Use the closest existing test or
> live harness and state only what the result proves.
>
> Do not publish an unpatched vulnerability, credential, private URL, message
> content, or identifying path. Report vulnerabilities privately through
> [SECURITY.md](https://github.com/comisai/comis/security/policy).

## Contribution Path

Choose the closest path:

- [ ] Workload
- [ ] Attack path that is safe to discuss publicly
- [ ] Learning failure
- [ ] Integration

## Question or Claim

What narrow behavior, boundary, or result should this contribution test?

## Minimal Setup

List the smallest safe configuration, fixture, or existing harness needed to
reproduce the result. State whether the run starts with a fresh or existing
session, memory store, or learned artifact.

## Reproduction Steps

1.
2.
3.

## Expected Runtime Property

What should remain under runtime control, stay recoverable, be rejected, or be
explained?

## Observed Result

What happened? Include deterministic assertions or bounded output when safe.

## Evidence Level

Choose the strongest level actually demonstrated. These are reporting labels,
not certification levels.

- [ ] Code or design trace only
- [ ] Deterministic unit or contract test
- [ ] Simulator or controlled harness
- [ ] Live integration run
- [ ] Independent reproduction

## Tested Profile

- **Operating system:**
- **Isolation or sandbox mode:**
- **Provider and model, if relevant:**
- **Tool and permission profile:**
- **Relevant configuration:**
- **Fresh or existing state:**

Do not include secrets or sensitive content.

## Evidence Artifacts

Link or attach the smallest safe test, trace, command output, or fixture needed
to review the result.

## Residual Risk

What does this evidence not prove? Note untested platforms, profiles, failure
modes, assumptions, and any risk that remains.
