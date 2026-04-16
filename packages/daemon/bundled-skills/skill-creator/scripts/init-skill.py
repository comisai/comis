#!/usr/bin/env python3
"""Initialize a new Comis skill from template.

Creates a skill directory with SKILL.md template and optional resource directories.

Usage:
    python3 init-skill.py <skill-name> [--path <dir>] [--resources scripts,references,assets] [--description "..."]

Examples:
    python3 init-skill.py my-skill
    python3 init-skill.py my-skill --path ~/.comis/skills
    python3 init-skill.py deploy-checker --resources scripts
    python3 init-skill.py api-helper --resources scripts,references
    python3 init-skill.py my-skill --description "Build dashboards with charts. Use when user mentions visualization."
"""

import argparse
import re
import sys
from pathlib import Path

MAX_NAME_LENGTH = 64
NAME_REGEX = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
ALLOWED_RESOURCES = {"scripts", "references", "assets"}

DEFAULT_DESCRIPTION = (
    "[TODO: What this skill does and when to use it. Be specific -- include trigger "
    "phrases so the agent recognizes when to activate. Example: 'Build dashboards "
    "with charts and filters. Use whenever the user mentions dashboards, data "
    "visualization, or metrics display -- even if they don't say dashboard explicitly.']"
)

SKILL_TEMPLATE = """---
name: {name}
description: {description}
---

# {title}

[TODO: 1-2 sentences explaining what this skill enables.]

## [TODO: Choose a structure]

Pick the pattern that best fits this skill's purpose:

- **Workflow-based** -- for sequential processes with clear steps
- **Task-based** -- for skills offering different operations/capabilities
- **Reference/guidelines** -- for standards, specs, or company policies
- **Capabilities-based** -- for integrated systems with interrelated features

Patterns can be mixed. Delete this section after choosing.

## [TODO: First main section]

[TODO: Add content. Include:
- Code samples for technical skills
- Decision trees for complex workflows
- Concrete examples with realistic user requests
- References to scripts/references/assets as needed]
"""


def normalize_name(raw):
    """Normalize a skill name to lowercase hyphen-case."""
    name = raw.strip().lower()
    name = re.sub(r"[^a-z0-9]+", "-", name)
    name = name.strip("-")
    name = re.sub(r"-{2,}", "-", name)
    return name


def title_case(name):
    """Convert hyphenated name to Title Case."""
    return " ".join(word.capitalize() for word in name.split("-"))


def main():
    p = argparse.ArgumentParser(description="Initialize a new Comis skill")
    p.add_argument("skill_name", help="Skill name (normalized to hyphen-case)")
    p.add_argument("--path", default=".", help="Parent directory for the skill (default: current dir)")
    p.add_argument("--resources", default="", help="Comma-separated: scripts,references,assets")
    p.add_argument("--description", default="", help="Skill description (skips TODO placeholder)")
    args = p.parse_args()

    name = normalize_name(args.skill_name)
    if not name:
        print("ERROR: Skill name must include at least one letter or digit.")
        sys.exit(1)
    if len(name) > MAX_NAME_LENGTH:
        print(f"ERROR: Name '{name}' is {len(name)} chars (max {MAX_NAME_LENGTH}).")
        sys.exit(1)
    if not NAME_REGEX.match(name):
        print(f"ERROR: Name '{name}' invalid (must be lowercase alphanumeric + hyphens).")
        sys.exit(1)
    if name != args.skill_name:
        print(f"Note: Normalized '{args.skill_name}' to '{name}'")

    # Parse resources
    resources = []
    if args.resources:
        for r in args.resources.split(","):
            r = r.strip()
            if r and r not in ALLOWED_RESOURCES:
                print(f"ERROR: Unknown resource type '{r}'. Allowed: {', '.join(sorted(ALLOWED_RESOURCES))}")
                sys.exit(1)
            if r:
                resources.append(r)

    # Create skill directory
    skill_dir = Path(args.path).resolve() / name
    if skill_dir.exists():
        print(f"ERROR: Directory already exists: {skill_dir}")
        sys.exit(1)

    skill_dir.mkdir(parents=True)
    print(f"Created: {skill_dir}/")

    # Write SKILL.md
    desc = args.description if args.description else DEFAULT_DESCRIPTION
    content = SKILL_TEMPLATE.format(name=name, title=title_case(name), description=desc)
    (skill_dir / "SKILL.md").write_text(content)
    print("Created: SKILL.md")

    # Create resource directories
    for r in resources:
        (skill_dir / r).mkdir()
        print(f"Created: {r}/")

    print(f"\nSkill '{name}' initialized at {skill_dir}")
    print("\nNext steps:")
    print("1. Edit SKILL.md -- fill in the TODO items")
    print("2. Add resources to scripts/, references/, assets/ as needed")
    print("3. Run validate-skill.py to check before use")


if __name__ == "__main__":
    main()
