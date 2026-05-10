---
name: stub-skill
description: "Stub for tests"
type: prompt
userInvocable: true
comis:
  capability:
    summary: "Stub summary"
    cluster: "test-cluster"
---

# Stub Skill

This is a stub skill used to exercise the discover.ts frontmatter
priority chain (`comis.capability.summary` over `frontmatter.description`).

The body needs at least three lines so the SKILL.md file is non-empty.
