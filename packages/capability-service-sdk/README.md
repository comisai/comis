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

Fixtures carry `__BUNDLE_DIGEST__` where a wire example needs the enclosing
bundle digest. A fixture host replaces that token with the manifest digest
before validation or transmission; the committed fixture bytes remain stable
and avoid a self-referential hash.
