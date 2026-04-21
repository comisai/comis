# Security Policy

Comis is a security-first platform. Security is built into the architecture at every layer, and we treat all vulnerability reports with priority and confidentiality.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

To report a vulnerability, email **security@comis.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could achieve)
- Any suggested fixes (optional)

### Response Timeline

- **48 hours** -- Acknowledgment of your report
- **7 days** -- Initial assessment and severity classification
- **30 days** -- Target for fix development and release (critical issues prioritized)

## Security Features

Comis includes several built-in security mechanisms:

- **Sandboxed Execution** -- Skills run in isolated-vm sandboxes with memory and CPU limits
- **Security Linting** -- ESLint rules that ban eval, unsafe path operations, and direct process.env access
- **Safe Path Resolution** -- Utilities that prevent directory traversal and symlink attacks
- **Action Classification** -- Permission system that categorizes agent behaviors by risk level
- **Audit Logging** -- Comprehensive logging of all agent actions and security-relevant events
- **Node.js Permission Model** -- Integration with Node.js experimental permission restrictions for filesystem and network access

## Disclosure Policy

We follow coordinated disclosure:

1. Reporter submits vulnerability privately
2. We acknowledge and assess the report
3. We develop and test a fix
4. We release the fix
5. We publicly disclose the vulnerability with credit to the reporter

Reporters are credited in the release notes unless they prefer to remain anonymous.
