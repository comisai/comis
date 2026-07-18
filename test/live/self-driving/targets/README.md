# Self-driving targets

Targets in this repository exercise domain-neutral runtime contracts. Application-specific campaigns, personas, vendor integrations, and business acceptance criteria belong with the application or skill that owns them.

Available targets:

- `generic-runtime-campaign.md` — end-to-end generic-agent boundary, security, locale, policy-snapshot, prompt-compiler, MCP-trust, health-surface, and restart-provenance acceptance.
- `EXAMPLE-cron-wake-gate.md` — scheduler and wake-gate mechanics.
- `EXAMPLE-verified-learning.md` — content-free learning and outcome evidence.
- `EXAMPLE-webhook-claude-gsd.md` — webhook lifecycle mechanics.
- `MEMORY-LEARNING-STRESS-CATALOG.md` — neutral memory and learning workloads.

Keep run artifacts under `../runs/<target>-<YYYYMMDD>/`. A run is complete only when its result log satisfies the stop condition in `../02-DISCIPLINE.md`.
