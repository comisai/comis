# Capability-service protocol artifacts

`@comis/capability-service-sdk` is a private workspace package. It is not part
of the `comisai` npm umbrella and is not published as a standalone npm package.
External capability services consume the generated `protocol/` directory from
pinned GitHub release artifacts.

The source of truth is the strict Zod schema set in `src/`. Regenerate and check
the committed, language-neutral JSON bundle with:

```sh
pnpm capability-protocol:generate
pnpm capability-protocol:check
```

`protocol/manifest.json` records the exact protocol identifier, method and
error catalogs, retryability, limits, every artifact hash, and the overall
bundle digest. The overall digest is SHA-256 over lexically ordered records of
`relative-path`, a NUL byte, the artifact SHA-256, and a newline. The manifest's
own `bundleDigest` field is not an artifact and therefore cannot contribute to
its own digest.

Capability services that request the `attention_response` scope may call
`managedRuns.receiveAttentionResponse` with an exact managed-run ID and external
decision key. The response remains `pending` until the owner replies; the first
successful receive marks the private response delivered and returns it only on
the authenticated owner-private control connection.

Fixtures carry `__BUNDLE_DIGEST__` where a wire example needs the enclosing
bundle digest. A fixture host replaces that token with the manifest digest
before validation or transmission; the committed fixture bytes remain stable
and avoid a self-referential hash.

## Standalone fixture host

The daemon package exposes a test-only runnable host for cross-language client
conformance. Give it an existing canonical owner-only directory:

```sh
pnpm capability-service-fixture-host --directory /absolute/private/fixture-dir
```

The process creates `capability-service.sock` and a generated bearer file beneath
that directory, both mode `0600`. Its single stdout line is readiness JSON carrying
the socket path, service instance, exact protocol identity/digest, and credential
source path; it never prints the credential value. SIGINT or SIGTERM removes both
files before exit.

Each connection carries exactly one newline-terminated JSON-RPC request and receives
one newline-terminated JSON-RPC response. The request object includes a top-level
`bearer` transport field in addition to the pinned `jsonrpc`, `id`, `method`, and
`params` fields. The host timing-safely authenticates and strips `bearer` before
validating the remaining request against the pinned method schema. This transport
field is not part of a method DTO and does not change the protocol bundle digest.
