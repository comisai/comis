<!-- Keep the five required H2 headings below when automation updates a PR body. -->

## Description

What does this PR do?

## Related Issue

Fixes #

Behavior, architecture, and security changes require a linked issue. For a
small change limited to documentation, typos, formatting, or neutral test
fixtures that cannot change runtime behavior or security expectations, write
`N/A: <reason>`.

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation
- [ ] Refactor

## Checklist

- [ ] Targeted checks for the changed area pass
- [ ] Full repository validation passes (`pnpm validate`)
- [ ] New or changed behavior has a test that demonstrated the RED state before the production change
- [ ] Documentation updated (if applicable)
- [ ] No secrets or credentials committed
- [ ] Security implications considered
- [ ] The change is focused on one concern and links the related issue, or states the allowed `N/A` reason

## RED Test Proof

_Required for all `packages/*/src/**` changes. Paste the failing test output
(test name + assertion error) from before the production patch._
_Exempt: pure docs, comments, formatting, build-tooling/CI/config edits._

```
(paste failing test output here, or write "EXEMPT: <reason>")
```

## Evidence and Residual Risk

Complete this section for changes to behavior, security boundaries, governed
learning, recovery, integrations, or Comis Open Evidence material.

- **Contribution path:** workload, public attack path, learning failure,
  integration, or not applicable
- **Evidence level:** code trace, deterministic test, controlled harness, live
  integration run, or independent reproduction
- **Tested profile:** operating system, isolation mode, provider/model, tool and
  permission profile, and fresh or existing state
- **Residual risk:** what this PR and its tests do not prove

Do not include credentials or sensitive content. Report unpatched
vulnerabilities privately through `SECURITY.md`.

## Screenshots

If applicable (UI changes).

## Additional Notes

Anything reviewers should know.
