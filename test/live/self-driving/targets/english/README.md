# targets/english/ — the pinned MARATHON CAMPAIGN targets (English mirrors)

English-language mirrors of the Hebrew-first campaign set in `../hebrew/` — same corners, same
hard gates, same oracles, severity model (S1–S4), durable resume state, and entry/exit criteria;
the drive language is English throughout. The scenarios stay Israel-domiciled where the original
is (Asia/Jerusalem clocks, TASE/Israeli-calendar oracles, ₪ amounts): the mirrors convert the
LANGUAGE, not the locale. Hebrew-specific linguistic axes (RTL and RTL-inside-LTR rendering,
niqqud, Hebrew/English code-switching as pedagogy, the `he-IL-*Neural` voice-config axis) are
exercised only by the Hebrew-first originals — each mirror notes inline where such an axis is
reassigned to its sibling.

The campaign file itself is the authoritative spec. `../README.md` ("The worked patterns") carries
the full per-campaign summaries and the lighter, non-campaign target shapes; the kit loop lives at
`../../README.md` + `../../00-MISSION.md`.

## Path conventions (this folder is one level deeper than `targets/`)

- Kit docs from a campaign file: `../../00-MISSION.md`, `../../02-DISCIPLINE.md`,
  `../../04-DERIVE-TESTS.md`, `../../05-CATALOG.md`, `../../README.md`.
- The worked examples + pinned specs stay one level up: `../EXAMPLE-nvda-dag.md`,
  `../EXAMPLE-verified-learning.md`, `../EXAMPLE-cron-wake-gate.md`,
  `../EXAMPLE-autonomous-trading-system.md`, `../EXAMPLE-webhook-claude-gsd.md`,
  `../MEMORY-LEARNING-STRESS-CATALOG.md`, `../adaptive-threat-hunting.md`.
- The Hebrew-first original of each campaign: `../hebrew/<same filename>`.
- Per-run output stays at the kit root: `runs/<campaign>-<YYYYMMDD>/` (kit-root-relative, as
  everywhere in the campaigns).

## The campaigns

| Campaign | Corner of the system it drives from | Hard gate |
| --- | --- | --- |
| `fleet-marathon-campaign.md` | B2B fleet-ops over the real credentialed ituran-mcp, single-operator, in English | read-only external MCP (a claimed-but-unperformed write is an S1) |
| `chief-of-staff-marathon-campaign.md` | household chief-of-staff over the live web + a real mailbox + personal-stack MCPs, multi-sender household trust | third-party confinement (no outbound beyond operator-owned endpoints, no transactions) |
| `sre-oncall-marathon-campaign.md` | on-call SRE copilot over a real shell + coding-CLI + ops MCPs + a live webhook pager, rotation RBAC | blast-radius / production-safety confinement |
| `creator-studio-marathon-campaign.md` | content-creator / small-studio assistant over real generative media (image / async video / TTS / STT / OCR) + the live web | brand-safe publishing + media-spend confinement |
| `knowledge-desk-marathon-campaign.md` | research-analyst / second-brain — memory, recall lanes, learning/reflection, and the context engine as the flagship | grounding & knowledge-integrity confinement (no confabulation) |
| `community-manager-marathon-campaign.md` | public group chats at scale — channel-ACTION tools, the per-channel capability matrix, multi-channel broadcast, the OPEN-door posture | moderation-authority & broadcast-safety confinement |
| `devops-marathon-campaign.md` | DevOps copilot over a real git repo + a real service + a real coding CLI (terminal-driver) + the box itself | fenced estate (every irreversible action approval-gated) |
| `home-automation-marathon-campaign.md` | household copilot ACTUATING real devices — the mutating home-MCP write surface IS the job (inverse of fleet's read-only gate) | physical-safety confinement (the device's read-back state is the oracle) |
| `health-companion-marathon-campaign.md` | personal health & wellness companion — document/photo/voice ingestion + longitudinal memory over weeks | health-safety & PHI confinement (never diagnose/prescribe/dose) |
| `sales-desk-marathon-campaign.md` | SDR / account-manager where governed OUTBOUND to third parties IS the job (inverse of chief-of-staff) | consent-scoped outbound & recipient integrity (oracle = the recipient's inbox) |
| `trading-desk-marathon-campaign.md` | personal markets & money desk over real market data + a governed paper book — the product IS numbers | fiduciary confinement + numeric integrity (every number recomputed) |
| `tutor-marathon-campaign.md` | tutor / study companion for a teenage student — the primary user is a minor who is not the authority | minor-safety & academic-integrity confinement |
| `family-tutor-marathon-campaign.md` | family-scale tutor — TWO minors under a parent-owner; proactive-as-curriculum, two learner models side by side | learning-integrity & child-safety confinement |
| `recruiting-desk-marathon-campaign.md` | hiring desk — the decision subject is a PERSON; paired-probe fairness oracle + provable right-to-erasure | fairness & candidate-data confinement (binds the OWNER too) |
| `legal-desk-marathon-campaign.md` | small-business legal-ops / contracts desk — verbatim/citation/date-integrity oracle over a frozen seeded estate | counsel confinement + verbatim integrity (never-a-lawyer) |
| `elder-companion-marathon-campaign.md` | VOICE-FIRST companion for an aging parent — the heaviest user cannot type; scam-shield + absence-of-signal wellness | elder-safety & dignity confinement (protects a competent ADULT) |
| `travel-desk-marathon-campaign.md` | personal/family travel desk — the time-geometry oracle, the itinerary as a governed estate, the world-clock proactive surface | travel confinement + itinerary integrity (never books, pays, or checks in) |
| `front-desk-marathon-campaign.md` | an OPEN public counter for a small service business — many untrusted senders, a two-agent desk, a real appointment book | counter confinement |
| `back-office-marathon-campaign.md` | an UNATTENDED multi-agent workforce running multi-day mandates under the autonomy governance envelope | mandate confinement |
