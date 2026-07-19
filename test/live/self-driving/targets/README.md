# Self-driving targets

Runtime-contract targets exercise domain-neutral mechanics with synthetic data. Campaign targets describe concrete operator deployments to drive — their domain vocabulary is fixture content those drives configure into operator workspaces, never runtime specialization (the architecture gate scans the rest of the kit but not this folder for that reason).

Runtime-contract and worked-example targets:

- `generic-runtime-campaign.md` — end-to-end generic-agent boundary, security, locale, policy-snapshot, prompt-compiler, MCP-trust, health-surface, and restart-provenance acceptance.
- `EXAMPLE-cron-wake-gate.md` — scheduler and wake-gate mechanics.
- `EXAMPLE-verified-learning.md` — content-free learning and outcome evidence.
- `EXAMPLE-webhook-claude-gsd.md` — webhook lifecycle mechanics.
- `EXAMPLE-nvda-dag.md` — a worked single-use-case drive over the emulator (the pattern the campaigns build on).
- `EXAMPLE-autonomous-trading-system.md` — a worked autonomous multi-cron system build.
- `MEMORY-LEARNING-STRESS-CATALOG.md` — neutral memory and learning workloads.
- `adaptive-threat-hunting.md` — learning-loop stress over a security-ops workload.

Pinned marathon campaigns (multi-day, whole-system drives from one deployment corner each):

- `hebrew/` — the Hebrew-first campaign set (see `hebrew/README.md`).
- `english/` — English mirrors of the Hebrew set plus the English-primary `swe-factory-` and `unsandboxed-` campaigns (see `english/README.md` for the per-campaign table and hard gates).

Keep run artifacts under `../runs/<target>-<YYYYMMDD>/`. A run is complete only when its result log satisfies the stop condition in `../02-DISCIPLINE.md`.
