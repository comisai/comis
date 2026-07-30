#!/usr/bin/env python3
"""Digest daemon NDJSON logs into LLM-friendly summaries.

Usage:
    # Full summary (errors, warnings, timeline, slow ops)
    python3 log-digest.py ~/.comis/logs/daemon.log

    # Errors and warnings only
    python3 log-digest.py ~/.comis/logs/daemon.log --level warn

    # Filter by module
    python3 log-digest.py ~/.comis/logs/daemon.log --module agent

    # Time window
    python3 log-digest.py ~/.comis/logs/daemon.log --after "2026-03-20T16:00:00Z"

    # Raw filtered lines (pipe to clipboard or file for LLM)
    python3 log-digest.py ~/.comis/logs/daemon.log --raw --level error

    # Last N lines
    python3 log-digest.py ~/.comis/logs/daemon.log --tail 200

    # Compact one-liner per entry
    python3 log-digest.py ~/.comis/logs/daemon.log --compact --level warn
"""

import argparse
import json
import sys
from collections import Counter

LEVEL_NAMES = {10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL"}
LEVEL_FROM_NAME = {v.lower(): k for k, v in LEVEL_NAMES.items()}


def parse_args():
    p = argparse.ArgumentParser(description="Digest daemon logs for LLM analysis")
    p.add_argument("logfile", help="Path to NDJSON log file")
    p.add_argument("--level", default=None, help="Minimum level: trace/debug/info/warn/error/fatal")
    p.add_argument("--module", default=None, help="Filter by module name")
    p.add_argument("--after", default=None, help="Only entries after this ISO timestamp")
    p.add_argument("--before", default=None, help="Only entries before this ISO timestamp")
    p.add_argument("--search", default=None, help="Search msg field (case-insensitive substring)")
    p.add_argument("--raw", action="store_true", help="Output filtered lines as JSON (for LLM context)")
    p.add_argument("--tail", type=int, default=None, help="Only process last N lines")
    p.add_argument("--slow", type=int, default=1000, help="Threshold (ms) for slow operations (default: 1000)")
    p.add_argument("--compact", action="store_true", help="Compact output: one line per entry with key fields only")
    return p.parse_args()


def read_lines(path, tail=None):
    if tail:
        with open(path, "r") as f:
            lines = f.readlines()
        return lines[-tail:]
    else:
        with open(path, "r") as f:
            return f.readlines()


def parse_entry(line):
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def matches_filters(entry, args, min_level):
    if entry is None:
        return False
    level = entry.get("level", 0)
    if min_level is not None and level < min_level:
        return False
    if args.module and entry.get("module") != args.module:
        return False
    if args.after and entry.get("time", "") < args.after:
        return False
    if args.before and entry.get("time", "") > args.before:
        return False
    if args.search and args.search.lower() not in entry.get("msg", "").lower():
        return False
    return True


def compact_line(entry):
    """One-line summary: time level module msg + key fields."""
    t = entry.get("time", "?")[:19]
    lvl = LEVEL_NAMES.get(entry.get("level", 0), "?")
    mod = entry.get("module", "-")
    msg = entry.get("msg", "")
    extras = []
    for k in ("durationMs", "err", "hint", "errorKind", "agentId", "toolName", "method", "channelType"):
        if k in entry:
            val = entry[k]
            if isinstance(val, dict):
                val = val.get("message", str(val)[:80])
            extras.append(f"{k}={val}")
    extra_str = f"  [{', '.join(extras)}]" if extras else ""
    return f"{t} {lvl:5s} [{mod}] {msg}{extra_str}"


def print_summary(entries, args):
    if not entries:
        print("No matching log entries found.")
        return

    level_counts = Counter(LEVEL_NAMES.get(e.get("level", 0), "UNKNOWN") for e in entries)
    module_counts = Counter(e.get("module", "unknown") for e in entries)
    times = [e.get("time", "") for e in entries if e.get("time")]
    time_range = f"{times[0]} -> {times[-1]}" if times else "unknown"

    print(f"=== Log Digest ({len(entries)} entries) ===")
    print(f"Time range: {time_range}")
    print()

    print("Level distribution:")
    for lvl in ("FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"):
        if level_counts.get(lvl, 0) > 0:
            print(f"  {lvl:6s}: {level_counts[lvl]}")
    print()

    print(f"Top modules (of {len(module_counts)}):")
    for mod, count in module_counts.most_common(10):
        print(f"  {mod}: {count}")
    print()

    problems = [e for e in entries if e.get("level", 0) >= 40]
    if problems:
        print(f"=== Errors & Warnings ({len(problems)}) ===")
        for e in problems:
            print(compact_line(e))
        print()

    slow = [e for e in entries if e.get("durationMs", 0) >= args.slow]
    if slow:
        slow.sort(key=lambda e: e.get("durationMs", 0), reverse=True)
        print(f"=== Slow Operations (>= {args.slow}ms, showing top 20) ===")
        for e in slow[:20]:
            print(compact_line(e))
        print()

    error_msgs = Counter()
    for e in entries:
        if e.get("level", 0) >= 40:
            msg = e.get("msg", "unknown")
            error_msgs[msg] += 1
    if error_msgs:
        print(f"=== Unique Error/Warn Messages ===")
        for msg, count in error_msgs.most_common(20):
            print(f"  [{count}x] {msg}")
        print()


def main():
    args = parse_args()
    min_level = LEVEL_FROM_NAME.get(args.level.lower()) if args.level else None

    lines = read_lines(args.logfile, tail=args.tail)
    entries = []
    for line in lines:
        entry = parse_entry(line.strip())
        if matches_filters(entry, args, min_level):
            entries.append(entry)

    if args.raw:
        for e in entries:
            print(json.dumps(e, ensure_ascii=False))
    elif args.compact:
        for e in entries:
            print(compact_line(e))
    else:
        print_summary(entries, args)


if __name__ == "__main__":
    main()
