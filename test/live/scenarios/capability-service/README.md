# Capability-service live gates

Three scenarios share one harness. All of them are env-gated and **skip
silently** when a gate is unset — a run reporting `2 skipped` proves nothing.

| Scenario | Gate | What it proves |
|---|---|---|
| `e0-mechanics.test.ts` | `COMIS_E0_MECHANICS=1` + Linux | Deterministic delivery, held forge truth, mid-flight recovery and safe cleanup, using an in-process fixture worker |
| `e0-journey.test.ts` | `COMIS_LIVE=1` + `COMIS_E0_OBSERVE=1` + Linux | Non-gating real-worker custody observation |
| `wave4-join.test.ts` | `COMIS_LIVE=1` + Linux | Two real workers joined through the capability service |

Every scenario also needs `COMIS_DEV_CREW_BIN_DIR` pointing at a directory
holding the four companion binaries built for the host's architecture.

## Host prerequisites

Run once per host, as root:

```bash
sudo ./test/live/scenarios/capability-service/provision-reviewed-launchers.sh
```

This installs the reviewed launchers under `/usr/local/bin`. They are not
optional and they are not created by the tests. Two separate mechanisms read
them, and skipping this step fails both far from the cause:

- The harness computes the terminal-allowlist hash pin by **reading** the
  launcher file. An absent launcher throws `ENOENT` in `beforeAll` naming a
  path nothing in the repository creates.
- The companion **executes** `<launcher> --version` while composing its service
  and compares stdout to the exact pinned version. Any other answer — including
  a launcher that demands its reviewed token first, since `--version` is not
  that token — surfaces only as `Failure cause: codex_composition` behind an
  operator-socket timeout, several layers above the probe that refused.

The script provisions enough for the **deterministic** gate only. That gate
drives an in-process fixture worker and asserts no real harness process
participates, so where no harness is installed a probe stub answers the version
question and refuses every other invocation loudly. The real-worker scenarios
need the actual harness plus a launcher carrying role bootstraps, a
concurrent-start barrier and sibling-confinement evidence; that launcher belongs
with the scenario that drives it.

`test/architecture/live-reviewed-launcher-contract.test.ts` pins the
provisioner to the paths and versions these scenarios reference, so bumping
`--codex-version` in a scenario without moving the provisioner fails a gate
instead of a live run.

## Running the deterministic gate

```bash
COMIS_E0_MECHANICS=1 COMIS_DEV_CREW_BIN_DIR=/path/to/bin \
  npx vitest run test/live/scenarios/capability-service/e0-mechanics.test.ts \
  --config test/live/vitest.config.ts --retry=0
```

`--retry=0` is deliberate: the mechanics gate is deterministic, so a retry
would hide a real flake rather than absorb a transient one.

Record the protocol bundle digest the run used alongside the result. Evidence
ages against the digest, not the calendar — a passing campaign becomes stale
the moment the contract moves underneath it, and a result that does not name
its digest cannot be checked for that.
