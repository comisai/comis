#!/usr/bin/env python3
"""Validate a SKILL.md file against Comis skill manifest rules.

Checks frontmatter fields, name format, description length, body size,
content scanning patterns, and directory structure.

Usage:
    python3 validate-skill.py /path/to/skill-dir
    python3 validate-skill.py /path/to/SKILL.md
"""

import argparse
import os
import re
import sys
import json

# ---------------------------------------------------------------------------
# Constants matching Comis schema validation (schema-skills.ts, schema.ts)
# ---------------------------------------------------------------------------

NAME_REGEX = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
NAME_MAX = 64
DESC_MAX = 1024
BODY_MAX = 20_000

VALID_TOP_FIELDS = {
    "name", "description", "type", "version", "license",
    "userInvocable", "disableModelInvocation", "allowedTools",
    "argumentHint", "permissions", "inputSchema", "metadata", "comis",
}

VALID_COMIS_FIELDS = {
    "os", "requires", "skill-key", "primary-env", "command-dispatch",
}

VALID_PERMISSIONS_FIELDS = {"fsRead", "fsWrite", "net", "env"}

# Content scanning patterns matching the exact Comis scanner (injection-patterns.ts)
# These are applied AFTER stripping fenced code blocks to reduce false positives
# from documentation examples. The real scanner applies to the raw body.

# CRITICAL severity -- will block loading
CRITICAL_PATTERNS = [
    (r"\$\([^)]*(?:curl|wget|bash|sh|nc|ncat)\b[^)]*\)", "Exec injection: $(command) with dangerous binary"),
    (r"`[^`]*\b(?:curl|wget|bash|sh|nc|ncat)\b(?:\s+[^`]+)`", "Exec injection: backtick with dangerous binary"),
    (r"\beval\s*\(\s*[\"'`]", "Exec injection: eval() with string argument"),
    (r"\|\s*(?:bash|sh|zsh|ksh)\b", "Pipe to shell interpreter"),
    (r"stratum\+?(?:tcp|ssl)://", "Crypto mining: stratum pool"),
    (r"\b(?:xmrig|cgminer|bfgminer|ethminer|minerd|cpuminer)\b", "Crypto mining: miner binary"),
    (r"/dev/tcp/", "Reverse shell: /dev/tcp"),
    (r"\bnc\s+-e\b", "Reverse shell: nc -e"),
    (r"base64\s+(?:-d|--decode)\s*\|", "Obfuscated execution: base64 decode pipe"),
    (r"</available_skills>", "XML breakout: </available_skills>"),
    (r"</skill_invocation>", "XML breakout: </skill_invocation>"),
    (r"<system>", "XML breakout: <system>"),
    (r"</system>", "XML breakout: </system>"),
    (r"<tool_result>", "XML breakout: <tool_result>"),
]

# WARN severity -- logged but does not block loading
WARN_PATTERNS = [
    (r"\bprintenv\b", "Env harvesting: printenv"),
    (r"/proc/self/environ", "Env harvesting: /proc/self/environ"),
    (r"[A-Za-z0-9+/]{80,}={0,2}", "Long base64 string (80+ chars)"),
    (r"(?:\\x[0-9a-fA-F]{2}){20,}", "Long hex sequence (20+ pairs)"),
]


def strip_code_fences(text):
    """Remove fenced code blocks (```...```) to reduce false positives from examples."""
    return re.sub(r"```[^\n]*\n.*?```", "", text, flags=re.DOTALL)


def parse_frontmatter(content):
    """Parse YAML frontmatter from --- delimited block."""
    if not content.startswith("---"):
        return None, content, "File must start with '---'"

    lines = content.split("\n")
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        return None, content, "Missing closing '---' marker"

    yaml_block = "\n".join(lines[1:end_idx])
    body = "\n".join(lines[end_idx + 1:]).strip()

    # Simple YAML parsing (avoid external dependency)
    try:
        import yaml
        fm = yaml.safe_load(yaml_block)
    except ImportError:
        # Fallback: basic key-value parsing for simple frontmatter
        fm = {}
        for line in yaml_block.split("\n"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                key, _, value = line.partition(":")
                value = value.strip()
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]
                elif value.lower() == "true":
                    value = True
                elif value.lower() == "false":
                    value = False
                elif value.isdigit():
                    value = int(value)
                fm[key.strip()] = value
    except Exception as e:
        return None, body, f"YAML parse error: {e}"

    if not isinstance(fm, dict):
        return None, body, "Frontmatter must be a YAML object"

    return fm, body, None


def validate(path):
    """Validate a skill directory or SKILL.md file. Returns (errors, warnings)."""
    errors = []
    warnings = []

    # Resolve path
    if os.path.isdir(path):
        skill_dir = path
        skill_file = os.path.join(path, "SKILL.md")
    elif os.path.isfile(path):
        skill_file = path
        skill_dir = os.path.dirname(path)
    else:
        return [f"Path does not exist: {path}"], []

    if not os.path.isfile(skill_file):
        return [f"SKILL.md not found at: {skill_file}"], []

    with open(skill_file, "r") as f:
        content = f.read()

    # Parse frontmatter
    fm, body, parse_err = parse_frontmatter(content)
    if parse_err:
        errors.append(f"Frontmatter: {parse_err}")
        return errors, warnings
    if fm is None:
        errors.append("Frontmatter: empty or missing")
        return errors, warnings

    # Required fields
    if "name" not in fm:
        errors.append("Missing required field: name")
    else:
        name = str(fm["name"])
        if len(name) > NAME_MAX:
            errors.append(f"name too long: {len(name)} chars (max {NAME_MAX})")
        if not NAME_REGEX.match(name):
            errors.append(f"name '{name}' invalid: must be lowercase alphanumeric + hyphens, no consecutive/leading/trailing hyphens")
        if "--" in name:
            errors.append(f"name '{name}' contains consecutive hyphens")

    if "description" not in fm:
        errors.append("Missing required field: description")
    else:
        desc = str(fm["description"])
        if len(desc) > DESC_MAX:
            errors.append(f"description too long: {len(desc)} chars (max {DESC_MAX})")
        if len(desc) < 1:
            errors.append("description is empty")

    # Unknown top-level fields
    for key in fm:
        if key not in VALID_TOP_FIELDS:
            warnings.append(f"Unknown top-level field: '{key}' (will cause strict parse failure)")

    # Type field
    if "type" in fm and fm["type"] != "prompt":
        errors.append(f"type must be 'prompt', got '{fm['type']}'")

    # Boolean fields
    for field in ("userInvocable", "disableModelInvocation"):
        if field in fm and not isinstance(fm[field], bool):
            errors.append(f"{field} must be boolean, got {type(fm[field]).__name__}")

    # allowedTools
    if "allowedTools" in fm:
        if not isinstance(fm["allowedTools"], list):
            errors.append("allowedTools must be an array")

    # Permissions
    if "permissions" in fm:
        perms = fm["permissions"]
        if isinstance(perms, dict):
            for key in perms:
                if key not in VALID_PERMISSIONS_FIELDS:
                    warnings.append(f"Unknown permissions field: '{key}'")
        else:
            errors.append("permissions must be an object")

    # Comis namespace
    if "comis" in fm and fm["comis"] is not None:
        comis = fm["comis"]
        if isinstance(comis, dict):
            for key in comis:
                if key not in VALID_COMIS_FIELDS:
                    warnings.append(f"Unknown comis: field: '{key}'")
            if "requires" in comis and isinstance(comis["requires"], dict):
                for rk in comis["requires"]:
                    if rk not in ("bins", "env"):
                        warnings.append(f"Unknown comis.requires field: '{rk}'")
        else:
            errors.append("comis: must be an object (or omitted)")

    # Body checks
    if len(body) > BODY_MAX:
        warnings.append(f"Body is {len(body)} chars (max {BODY_MAX}) -- will be truncated at load time")

    body_lines = body.count("\n") + 1
    if body_lines > 500:
        warnings.append(f"Body is {body_lines} lines (recommended max: 500) -- consider using references/")

    # Content scanning (strip code fences to reduce false positives from examples)
    scannable = strip_code_fences(body)
    for pattern, desc in CRITICAL_PATTERNS:
        if re.search(pattern, scannable, re.IGNORECASE):
            errors.append(f"CRITICAL content scan: {desc}")

    for pattern, desc in WARN_PATTERNS:
        if re.search(pattern, scannable, re.IGNORECASE):
            warnings.append(f"Content scan warning: {desc}")

    # Also warn if the raw body (with code fences) would trigger the real scanner
    for pattern, desc in CRITICAL_PATTERNS:
        if re.search(pattern, body, re.IGNORECASE) and not re.search(pattern, scannable, re.IGNORECASE):
            warnings.append(f"Code fence contains scannable pattern (may trigger real scanner): {desc}")

    # Directory structure hints
    scripts_dir = os.path.join(skill_dir, "scripts")
    refs_dir = os.path.join(skill_dir, "references")
    assets_dir = os.path.join(skill_dir, "assets")

    if os.path.isdir(scripts_dir):
        scripts = [f for f in os.listdir(scripts_dir) if not f.startswith(".")]
        if scripts:
            # Check scripts are referenced in body
            for s in scripts:
                if s not in body:
                    warnings.append(f"Bundled script '{s}' not referenced in SKILL.md body")

    return errors, warnings


def main():
    p = argparse.ArgumentParser(description="Validate a Comis SKILL.md")
    p.add_argument("path", help="Path to skill directory or SKILL.md file")
    args = p.parse_args()

    errors, warnings = validate(args.path)

    if warnings:
        print(f"Warnings ({len(warnings)}):")
        for w in warnings:
            print(f"  ! {w}")
        print()

    if errors:
        print(f"Errors ({len(errors)}):")
        for e in errors:
            print(f"  X {e}")
        print()
        print("RESULT: INVALID")
        sys.exit(1)
    else:
        print("RESULT: VALID")
        sys.exit(0)


if __name__ == "__main__":
    main()
