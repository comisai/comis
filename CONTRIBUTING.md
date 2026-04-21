# Contributing to Comis

Thank you for your interest in contributing to Comis. Every contribution helps improve the platform, whether it is a bug report, feature request, documentation update, or code change. We appreciate your time and effort.

## Code of Conduct

This project follows a Code of Conduct to ensure a welcoming and inclusive environment for everyone. Please read and follow the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/comis.git
   cd comis
   ```
3. **Install dependencies** using pnpm:
   ```bash
   pnpm install
   ```
4. **Build** all packages:
   ```bash
   pnpm build
   ```
5. **Run tests** to verify everything works:
   ```bash
   pnpm test
   ```

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

## Pull Requests

1. Create your branch from `main`
2. Fill out the [PR template](.github/PULL_REQUEST_TEMPLATE.md) completely
3. Ensure all tests pass (`pnpm test`)
4. Ensure linting passes (`pnpm lint:security`)
5. Keep PRs focused -- one feature or fix per pull request
6. Security-sensitive changes require additional review from maintainers

## Reporting Bugs

Use the [Bug Report](https://github.com/comisai/comis/issues/new?template=bug_report.md) issue template. Include:

- A clear description of the bug
- Steps to reproduce the issue
- Expected vs. actual behavior
- Your environment details (Linux distro, Node.js version, Comis version)
- Relevant logs or screenshots (redact any sensitive information)

## Requesting Features

Use the [Feature Request](https://github.com/comisai/comis/issues/new?template=feature_request.md) issue template. Describe:

- The problem your feature would solve
- Your proposed solution
- Alternatives you have considered
- Which package(s) would be affected

## Security Vulnerabilities

Do **not** open public GitHub issues for security vulnerabilities. Instead, follow the responsible disclosure process described in [SECURITY.md](SECURITY.md). Security reports are handled with priority and confidentiality.

## Project Structure

Comis is a pnpm monorepo with 13 packages in the `packages/` directory. Each package has its own `package.json`, source code, and tests. See the [Developer Guide](https://docs.comis.ai/developer-guide) for detailed architecture documentation and package descriptions.

```
comis/
  packages/
    core/        # Core domain logic, event bus, ports
    shared/      # Shared types, utilities, constants
    cli/         # Command-line interface
    agent/       # AI agent lifecycle and routing
    memory/      # Storage, embeddings, RAG
    channels/    # Chat platform adapters
    skills/      # Skill system and sandbox
    gateway/     # HTTP gateway and API
    daemon/      # Background process management
    scheduler/   # Task scheduling
    infra/       # Infrastructure utilities
    web/         # Web UI
```

## License

By contributing to Comis, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
