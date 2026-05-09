---
name: comis-capability-skill
description: "Manifest-driven skill — cluster from comis.capability metadata"
type: prompt
userInvocable: true
comis:
  capability:
    cluster: data-fetching-financial
    summary: "Manifest-driven skill that supplies the cluster via comis.capability metadata"
    replacesPackages:
      - manifest-replaceable-pkg
---

# Comis Capability Skill

Phase 24 fixture B. The cluster assignment comes from the `comis.capability` block in this manifest's frontmatter (no operator hint exists for this skill in `tooling-config.yaml`).
