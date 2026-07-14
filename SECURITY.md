# Security Policy

Comis is a security-first platform. We treat vulnerability reports as
confidential and coordinate fixes through private channels.

For the full trust model — trust boundaries, what Comis does and does not defend against, and known limitations — see [THREAT_MODEL.md](./THREAT_MODEL.md).

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

**Preferred:** Use GitHub's private vulnerability reporting. Open the repo's [Security tab](https://github.com/comisai/comis/security) and click **"Report a vulnerability"**. This creates a private draft advisory visible only to maintainers and the reporter, and lets us coordinate the fix, request a CVE, and publish disclosure in one place.

**Fallback:** If GitHub private reporting is unavailable, email
**security@comis.ai**. Do not include live credentials or sensitive production
data. If you do not receive an acknowledgement, use GitHub private reporting
when it becomes available; the address is a fallback, not an encrypted channel.

In either channel, please include:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could achieve)
- Any suggested fixes (optional)

### Response Timeline

- **48 hours** -- Acknowledgment of your report
- **7 days** -- Initial assessment and severity classification
- **30 days** -- Target for fix development and release (critical issues prioritized)

## Security Features

Comis includes several security mechanisms, with deployment-dependent limits:

- **Exec Isolation** -- Shell commands launched through the `exec` tool use
  Linux Bubblewrap when available or best-effort macOS `sandbox-exec`. Ordinary
  `exec` currently falls back to unsandboxed execution if no provider is
  available. MCP stdio servers and in-process tools are outside this sandbox.
- **Security Linting** -- ESLint rules that ban eval, unsafe path operations, and direct process.env access
- **Safe Path Resolution** -- Utilities that prevent directory traversal and symlink attacks
- **Action Classification** -- Agent actions are categorized by risk. Human
  approval is a separate workflow and is disabled by default.
- **Tool Policy** -- Per-agent profiles and allow/deny rules constrain tool
  availability. The default profile is `full`, so operators should narrow it
  for untrusted users.
- **Audit Logging** -- Structured, content-free security-decision events support
  investigation; the audit log is not a complete transcript of every action.
- **Credential Protection** -- Encrypted storage is the setup default. The
  master key is stored separately in `~/.comis/.env`; a compromised host that
  can read both key and database can decrypt the credentials.
- **Output Guarding** -- Completed responses are scanned for secret-shaped
  content and canary leakage. Streaming deltas may be emitted before the final
  scan and cannot be retracted.
- **Node.js Permission Model** -- Optional filesystem/network restrictions;
  disabled by default and intended for tested Linux deployments.

## Disclosure Policy

We follow coordinated disclosure:

1. Reporter submits vulnerability privately
2. We acknowledge and assess the report
3. We develop and test a fix
4. We release the fix
5. We publicly disclose the vulnerability with credit to the reporter

Reporters are credited in the release notes unless they prefer to remain anonymous.
