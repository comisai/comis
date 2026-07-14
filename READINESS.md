# Release Readiness and Limitations

Comis is under active development. This page describes the evidence available in the repository and the checks operators must perform for their own deployment; it is not a production certification.

## Repository Validation

The standard validation command is:

```bash
pnpm validate
```

It checks documentation syntax, performs a clean build, verifies dependency cycles and project references, runs the security-focused linter, and executes the test suite with coverage gates. Integration, packaging, end-to-end, and live-provider checks are separate commands because they require additional host capabilities, services, or credentials.

## Environment-Dependent Validation

Before relying on Comis, verify the exact combination you plan to operate:

- Model and media providers with your selected models, account permissions, limits, and fallback configuration.
- Messaging adapters with the platform permissions, webhook or socket configuration, media types, and interaction features you need.
- Linux tool isolation with Bubblewrap. macOS isolation is best-effort and does not provide the same boundary.
- Container networking, persistent volumes, encrypted-secret backup and recovery, gateway authentication, and service restart behavior.
- Browser, speech, image, video, document, vector-search, and MCP dependencies enabled for your deployment.

## Current Limitations

- Backward compatibility is not supported during active development; releases may include breaking API or configuration changes.
- Not every provider, channel, model, operating system, and deployment combination is exercised by live tests in CI.
- The OpenAI-shaped HTTP endpoints are experimental and are not a general compatibility guarantee.
- Code extensions require source changes through ports, adapters, hooks, or tools; prompt skills are the supported content-level extension surface.
- Approval requests cover explicitly wired paths when enabled; they are not a universal policy engine.
- Streaming consumers can receive response deltas before the completed response passes its final output scan.
- The ordinary `exec` tool can run on the host when its sandbox is disabled or unavailable.

Read the [threat model](THREAT_MODEL.md) before enabling shell, browser, network, or third-party integrations. For installation and operation guidance, use the [documentation](https://docs.comis.ai).
