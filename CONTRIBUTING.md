# Contributing to Comis

Thank you for your interest in contributing to Comis. Every contribution helps improve the platform, whether it is a bug report, feature request, documentation update, or code change. We appreciate your time and effort.

## Code of Conduct

This project follows a Code of Conduct to ensure a welcoming and inclusive environment for everyone. Please read and follow the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Getting Started

Prerequisites: Git, Node.js **22.19 or newer**, and pnpm **10.34.4** (the version pinned in `package.json`).

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/comis.git
   cd comis
   ```
3. **Activate the pinned pnpm version** and install dependencies:
   ```bash
   corepack enable
   corepack prepare pnpm@10.34.4 --activate
   pnpm install
   ```
4. **Run the repository validation suite**:
   ```bash
   pnpm validate
   ```

The Astro marketing site is a separate npm project. For website changes, also run `npm ci` and `npm run validate` from `website/`.

## Development Workflow

### Branch Naming

Create branches from `main` using the following naming conventions:

- `feature/<description>` -- new features or enhancements
- `fix/<description>` -- bug fixes
- `docs/<description>` -- documentation changes

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Format your commit messages as:

```
<type>(<scope>): <description>
```

Types:

| Type | Usage |
| --- | --- |
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `chore` | Build process, tooling, or dependency updates |

Examples:

```
feat(agent): add session timeout configuration
fix(channels): handle Discord rate limit responses
docs(skills): update sandbox security documentation
```

### Linting

Run the security-focused linter before committing:

```bash
pnpm lint:security
```

This runs ESLint with `eslint-plugin-security` rules that catch common security issues in JavaScript and TypeScript code.

### Contribution Bar

Every fix and every feature in `packages/*/src/**` starts with a failing test that
fails on the pre-patch code, then a production patch that flips it to green. The
failing test output (test name + assertion error) goes in the **RED Test Proof**
section of the PR template — it is the proof of the red state. Exempt from TDD:
pure docs, comments, formatting, and build-tooling/CI/config edits.

Before opening a PR, run the full validation suite:

```bash
pnpm validate
```

This runs: `docs:check && build:clean && cycles && cycles:refs && lint:security && test:coverage`.
All gates must pass before a code change is submitted.

**Allowlists are shrink-only.** If a PR adds a new entry to any architecture allowlist
(`test/support/architecture-allowlist.ts`, lint suppression comments, etc.), it will
not be merged. Remove an allowlist entry only when you have fixed the underlying issue.

## Pull Requests

1. Create your branch from `main`
2. Fill out the [PR template](.github/PULL_REQUEST_TEMPLATE.md) completely, including
   the **RED Test Proof** section (paste failing test output, or write `EXEMPT: <reason>`
   for docs/CI/config-only changes)
3. `pnpm validate` passes (clean build, cycles, lint:security, test:coverage)
4. Keep PRs focused -- one feature or fix per pull request
5. Security-sensitive changes require additional review from maintainers
6. Link to the GitHub issue this PR addresses (required — see AI-Generated and Bulk PRs below)

## AI-Generated and Bulk PRs

AI assistance is welcome for research, drafting, and understanding the codebase.
However:

- **File an issue first.** Before opening any PR — AI-generated or otherwise — open
  a GitHub issue describing the problem or feature. PRs that arrive without a linked
  issue will be closed pending one.
- **Bulk agent PRs are closed unreviewed.** PRs that appear to be auto-generated in
  bulk (multiple PRs from the same account in a short window, boilerplate descriptions,
  no linked issue) will be closed without review.
- **Quality bar is the same regardless of authorship.** An AI-assisted PR must meet
  the same contribution bar as a human-authored one: tests-first RED with proof,
  shrink-only allowlists, `pnpm lint:security`, `pnpm validate`.

The intent is not to block AI assistance but to prevent low-effort submissions that
consume reviewer time without meeting the project's quality standards.

## Reporting Bugs

Use the [Bug Report](https://github.com/comisai/comis/issues/new?template=bug_report.md) issue template. Include:

- A clear description of the bug
- Steps to reproduce the issue
- Expected vs. actual behavior
- Your environment details (operating system, installation method, Node.js version, and Comis version)
- Relevant logs or screenshots (redact any sensitive information)

## Requesting Features

Use the [Feature Request](https://github.com/comisai/comis/issues/new?template=feature_request.md) issue template. Describe:

- The problem your feature would solve
- Your proposed solution
- Alternatives you have considered
- Which user-facing area would be affected

## Security Vulnerabilities

Do **not** open public GitHub issues for security vulnerabilities. Instead, follow the responsible disclosure process described in [SECURITY.md](SECURITY.md). Security reports are handled with priority and confidentiality.

## Project Structure

Comis is a pnpm monorepo with 16 packages in the `packages/` directory. Each package has its own `package.json`, source code, and tests. See the [Developer Guide](https://docs.comis.ai/developer-guide) for detailed architecture documentation and package descriptions.

```
comis/
  packages/
    core/          # Core domain logic, event bus, ports
    shared/        # Shared types, utilities, constants
    cli/           # Command-line interface
    agent/         # AI execution, models, sessions, and safety
    memory/        # Storage, embeddings, RAG
    channels/      # Chat platform adapters
    skills/        # Skill system and sandbox
    gateway/       # HTTP gateway and API
    daemon/        # Background process management
    scheduler/     # Task scheduling
    infra/         # Infrastructure utilities
    web/           # Web UI
    comis/         # Umbrella published package (bundles all @comis/* deps)
    observability/      # Diagnostics and trace persistence
    observability-otel/ # Optional OpenTelemetry and Prometheus exporters
    orchestrator/       # Inbound and execution coordination
```

## License

By contributing to Comis, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
