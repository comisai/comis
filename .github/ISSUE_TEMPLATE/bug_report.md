---
name: Bug Report
about: Report a bug to help improve Comis
title: "[Bug] "
labels: bug
assignees: ''
---

If this report could reveal an unpatched vulnerability, do not continue in a
public issue. Follow the private disclosure process in
[SECURITY.md](https://github.com/comisai/comis/security/policy).

## Description

A clear and concise description of the bug.

## Steps to Reproduce

1.
2.
3.

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened.

## Environment

- **Operating system and version:**
- **Installation method:** <!-- npm, managed-host installer, Docker, source checkout, other -->
- **Node.js version:**
- **Comis version:**
- **Deployment/isolation mode:** <!-- Linux + Bubblewrap, macOS best-effort, container, no sandbox, unknown -->
- **Provider/model (if relevant):**
- **Messaging channel (if relevant):**

## Configuration

Share the smallest relevant configuration excerpt. Remove API keys, tokens, passwords, private URLs, message content, and other sensitive data.

## Logs / Screenshots

Paste relevant output from `comis doctor`, `comis status`, or daemon logs. **Remove tokens, keys, passwords, message content, private URLs, and filesystem paths that identify users.**

```
(paste logs here)
```

## Additional Context

Any other context about the problem.

## Evidence Profile (Optional)

If the bug concerns a security boundary, learning behavior, recovery, or an
integration, include:

- **Evidence level:** code trace, deterministic test, controlled harness, live
  integration run, or independent reproduction
- **Tested profile:** operating system, isolation mode, provider/model, tool and
  permission profile, and fresh or existing state
- **Residual risk:** what the reproduction does not test or prove
