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
COMPATIBILITY_MAX = 500

# The authored on-disk frontmatter carries EXACTLY these six top-level fields.
# Every platform extension rides under one metadata.comis JSON string, and the
# version under metadata.version. This validator mirrors that shipped rule, so a
# manifest it accepts is a manifest the platform accepts.
VALID_TOP_FIELDS = {
    "name", "description", "license", "compatibility", "metadata", "allowed-tools",
}

# Extension keys whose authored home moved under metadata.comis (the version
# under metadata.version). Present at the top level, they still load -- read with
# a deprecation warning naming the new home -- and are never rewritten. The value
# is the clause completing "Top-level '<key>' is read with a deprecation warning; ".
PRE_MIGRATION_HOMES = {
    "type": "it is no longer an authored field (skills are prompt-only)",
    "version": "author it under metadata.version",
    "allowedTools": "author it as the allowed-tools space-separated string",
    "userInvocable": "author it under metadata.comis",
    "disableModelInvocation": "author it under metadata.comis",
    "argumentHint": "author it under metadata.comis",
    "permissions": "author it under metadata.comis",
    "inputSchema": "author it under metadata.comis",
    "comis": "author it under metadata.comis",
    "mcpServers": "author it under metadata.comis",
}

VALID_COMIS_FIELDS = {
    "os", "requires", "skill-key", "primary-env", "command-dispatch", "capability",
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


# Sentinel returned as `fm` when the frontmatter block is present but was not
# parsed because PyYAML is absent. The canonical frontmatter nests the version
# and the platform extensions under `metadata`, which a line-based reader cannot
# represent -- so structural checks are SKIPPED (with a clear note) rather than
# run against a parser that would false-reject the very format this validator
# is meant to bless.
YAML_UNAVAILABLE = object()


def parse_frontmatter(content):
    """Parse YAML frontmatter from a --- delimited block.

    Returns (fm, body, error) where `fm` is the parsed dict, None (empty /
    non-object frontmatter), or the YAML_UNAVAILABLE sentinel when PyYAML is
    not installed.
    """
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

    # A real YAML parser is required to read the nested metadata carrier.
    try:
        import yaml
    except ImportError:
        return YAML_UNAVAILABLE, body, None

    try:
        fm = yaml.safe_load(yaml_block)
    except Exception as e:
        return None, body, f"YAML parse error: {e}"

    if not isinstance(fm, dict):
        return None, body, "Frontmatter must be a YAML object"

    return fm, body, None


def check_extension_fields(fields, errors, warnings):
    """Validate the platform extension fields wherever they are carried: at the
    top level (pre-migration form) or inside the parsed metadata.comis bag. Known
    extension keys are accepted; only unknown sub-keys draw a warning."""
    for field in ("userInvocable", "disableModelInvocation"):
        if field in fields and not isinstance(fields[field], bool):
            errors.append(f"{field} must be boolean, got {type(fields[field]).__name__}")

    if "permissions" in fields:
        perms = fields["permissions"]
        if isinstance(perms, dict):
            for key in perms:
                if key not in VALID_PERMISSIONS_FIELDS:
                    warnings.append(f"Unknown permissions field: '{key}'")
        else:
            errors.append("permissions must be an object")

    if "comis" in fields and fields["comis"] is not None:
        comis = fields["comis"]
        if isinstance(comis, dict):
            for key in comis:
                if key not in VALID_COMIS_FIELDS:
                    warnings.append(f"Unknown comis field: '{key}'")
            if "requires" in comis and isinstance(comis["requires"], dict):
                for rk in comis["requires"]:
                    if rk not in ("bins", "env"):
                        warnings.append(f"Unknown comis.requires field: '{rk}'")
        else:
            errors.append("comis must be an object (or omitted)")


def check_metadata_comis(meta, errors, warnings):
    """Validate the metadata.comis JSON-string carrier: it parses to an object
    and carries the platform extension fields. Mirrors the platform's honest
    failure, naming the key -- no eval, no reviver."""
    if "comis" not in meta:
        return
    raw = meta["comis"]
    if not isinstance(raw, str):
        errors.append("metadata.comis must be a JSON string carrying the platform extension fields")
        return
    try:
        bag = json.loads(raw)
    except (ValueError, TypeError) as e:
        errors.append(f"metadata.comis is not valid JSON: {e}")
        return
    if not isinstance(bag, dict):
        errors.append("metadata.comis must be a JSON object carrying the platform extension fields")
        return
    if any(k == "__proto__" for k in bag):
        errors.append("metadata.comis carries a prototype-polluting __proto__ key and was refused")
        return
    check_extension_fields(bag, errors, warnings)


def scan_content(body, errors, warnings):
    """Body-size advisories + the content-security scan. Needs only the body, so
    it runs whether or not the frontmatter could be structurally parsed."""
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


def check_dir_structure(skill_dir, body, warnings):
    """Advisory: a bundled script should be referenced in the SKILL.md body."""
    scripts_dir = os.path.join(skill_dir, "scripts")
    if os.path.isdir(scripts_dir):
        scripts = [f for f in os.listdir(scripts_dir) if not f.startswith(".")]
        for s in scripts:
            if s not in body:
                warnings.append(f"Bundled script '{s}' not referenced in SKILL.md body")


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
    if fm is YAML_UNAVAILABLE:
        # No YAML parser: skip the structural field checks (they need a real
        # parse of the nested metadata carrier) but still run the content scan.
        warnings.append(
            "PyYAML is not installed, so structural frontmatter validation was skipped; "
            "install it (pip install pyyaml) for the full field checks. The content security scan still ran."
        )
        scan_content(body, errors, warnings)
        check_dir_structure(skill_dir, body, warnings)
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

    # Top-level field set. The authored frontmatter carries exactly the six spec
    # fields; every platform extension rides under metadata.comis. A pre-migration
    # top-level extension key still loads (read with a deprecation warning naming
    # its authored home); a genuinely unknown key is rejected by strict validation.
    for key in fm:
        if key in VALID_TOP_FIELDS:
            continue
        clause = PRE_MIGRATION_HOMES.get(key)
        if clause is not None:
            warnings.append(f"Top-level '{key}' is read with a deprecation warning; {clause}.")
        else:
            warnings.append(f"Unknown top-level field: '{key}' (rejected by strict validation)")

    # A pre-migration top-level 'type' still loads, but must be 'prompt' if present.
    if "type" in fm and fm["type"] != "prompt":
        errors.append(f"type must be 'prompt', got '{fm['type']}'")

    # allowed-tools is a space-separated string (the authored form).
    if "allowed-tools" in fm and not isinstance(fm["allowed-tools"], str):
        errors.append("allowed-tools must be a space-separated string")

    # compatibility is free prose; a long note draws an advisory warning only.
    if "compatibility" in fm:
        compat = fm["compatibility"]
        if not isinstance(compat, str):
            errors.append("compatibility must be a string")
        elif len(compat) > COMPATIBILITY_MAX:
            warnings.append(f"compatibility is {len(compat)} chars (recommended max: {COMPATIBILITY_MAX})")

    # metadata is a string map carrying the version and the metadata.comis bag.
    if "metadata" in fm and fm["metadata"] is not None:
        meta = fm["metadata"]
        if isinstance(meta, dict):
            check_metadata_comis(meta, errors, warnings)
        else:
            errors.append("metadata must be an object (or omitted)")

    # Platform extension fields are validated wherever they are carried: inside
    # the parsed metadata.comis bag (spec-pure form) and, read-compat, at the top
    # level (pre-migration form).
    check_extension_fields(fm, errors, warnings)

    scan_content(body, errors, warnings)
    check_dir_structure(skill_dir, body, warnings)
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
