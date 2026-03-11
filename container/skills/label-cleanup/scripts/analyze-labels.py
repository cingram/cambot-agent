#!/usr/bin/env python3
"""
Deterministic Gmail label analyzer.

Reads JSON label inventory from stdin, writes analysis to stdout.
Each label gets a flag (empty, stale, duplicate, similar, healthy, etc.)
and a suggested action.

Usage:
    cat labels.json | python3 analyze-labels.py
    cat labels.json | python3 analyze-labels.py --only empty
    cat labels.json | python3 analyze-labels.py --only similar
    cat labels.json | python3 analyze-labels.py --stats
"""

import json
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

# System labels — never touch
SYSTEM_LABELS = {
    "INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "STARRED", "UNREAD",
    "IMPORTANT", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
    "CHAT", "VOICE",
}

# Staleness thresholds (days)
STALE_DAYS = 180       # 6 months
VERY_STALE_DAYS = 365  # 12 months
ACTIVE_DAYS = 30       # 1 month

# Oversized threshold
OVERSIZED_COUNT = 1000


@dataclass
class LabelAnalysis:
    label: str
    id: str
    type: str
    message_count: int
    newest_message: str | None
    flag: str
    action: str
    confidence: str
    reason: str
    merge_target: str | None = None


def is_system_label(label: dict) -> bool:
    """Check if a label is a system label."""
    name = label.get("name", "")
    label_type = label.get("type", "")
    if label_type == "system":
        return True
    upper = name.upper().replace(" ", "_")
    return upper in SYSTEM_LABELS or any(upper.startswith(s) for s in ("CHAT", "VOICE"))


def normalize_name(name: str) -> str:
    """Normalize a label name for comparison."""
    # Lowercase, strip separators, strip trailing s (simple plural)
    n = name.lower().strip()
    n = re.sub(r"[-_/\s]+", " ", n)
    return n


def strip_plural(name: str) -> str:
    """Remove trailing 's' for singular/plural matching."""
    n = normalize_name(name)
    if n.endswith("ies"):
        return n[:-3] + "y"
    if n.endswith("es") and not n.endswith("ses"):
        return n[:-2]
    if n.endswith("s") and not n.endswith("ss"):
        return n[:-1]
    return n


def days_since(date_str: str | None) -> int | None:
    """Days since a date string (ISO format)."""
    if not date_str:
        return None
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        return delta.days
    except (ValueError, TypeError):
        return None


def find_similar_pairs(labels: list[dict]) -> dict[str, list[str]]:
    """Find groups of labels with similar names."""
    user_labels = [l for l in labels if not is_system_label(l)]

    # Group by normalized name (exact match after normalization)
    by_normalized: dict[str, list[str]] = {}
    for l in user_labels:
        key = normalize_name(l["name"])
        by_normalized.setdefault(key, []).append(l["name"])

    # Group by singular form (catches plural variants)
    by_singular: dict[str, list[str]] = {}
    for l in user_labels:
        key = strip_plural(l["name"])
        by_singular.setdefault(key, []).append(l["name"])

    # Merge groups
    similar: dict[str, list[str]] = {}
    for key, names in by_normalized.items():
        if len(names) > 1:
            canonical = min(names, key=len)
            similar[canonical] = names
    for key, names in by_singular.items():
        if len(names) > 1:
            # Only add if not already covered
            already_covered = any(
                set(names).issubset(set(group))
                for group in similar.values()
            )
            if not already_covered:
                canonical = min(names, key=len)
                similar[canonical] = names

    return similar


def find_nested_orphans(labels: list[dict]) -> set[str]:
    """Find child labels whose parent label doesn't exist."""
    all_names = {l["name"] for l in labels}
    orphans = set()
    for l in labels:
        name = l["name"]
        if "/" in name:
            parent = name.rsplit("/", 1)[0]
            if parent not in all_names:
                orphans.add(name)
    return orphans


def analyze_label(
    label: dict,
    similar_groups: dict[str, list[str]],
    orphans: set[str],
) -> LabelAnalysis | None:
    """Analyze a single label and return its analysis."""
    name = label.get("name", "")
    label_id = label.get("id", "")
    label_type = label.get("type", "user")
    count = label.get("message_count", label.get("messagesTotal", 0)) or 0
    newest = label.get("newest_message", None)

    if is_system_label(label):
        return None

    # Empty
    if count == 0:
        return LabelAnalysis(
            label=name, id=label_id, type=label_type,
            message_count=count, newest_message=newest,
            flag="empty", action="delete", confidence="high",
            reason="Label has 0 messages",
        )

    # Staleness
    age = days_since(newest)
    if age is not None and age > VERY_STALE_DAYS:
        return LabelAnalysis(
            label=name, id=label_id, type=label_type,
            message_count=count, newest_message=newest,
            flag="very-stale", action="archive", confidence="high",
            reason=f"No messages in {age} days (>{VERY_STALE_DAYS}d)",
        )
    if age is not None and age > STALE_DAYS:
        return LabelAnalysis(
            label=name, id=label_id, type=label_type,
            message_count=count, newest_message=newest,
            flag="stale", action="archive", confidence="medium",
            reason=f"No messages in {age} days (>{STALE_DAYS}d)",
        )

    # Similar/duplicate
    for canonical, group in similar_groups.items():
        if name in group and name != canonical:
            return LabelAnalysis(
                label=name, id=label_id, type=label_type,
                message_count=count, newest_message=newest,
                flag="similar", action="merge", confidence="medium",
                reason=f"Similar to '{canonical}' — consider merging",
                merge_target=canonical,
            )

    # Nested orphan
    if name in orphans:
        return LabelAnalysis(
            label=name, id=label_id, type=label_type,
            message_count=count, newest_message=newest,
            flag="nested-orphan", action="review", confidence="low",
            reason=f"Parent label '{name.rsplit('/', 1)[0]}' does not exist",
        )

    # Oversized
    if count > OVERSIZED_COUNT:
        return LabelAnalysis(
            label=name, id=label_id, type=label_type,
            message_count=count, newest_message=newest,
            flag="oversized", action="review", confidence="low",
            reason=f"{count} messages — may be a catch-all",
        )

    # Healthy
    return LabelAnalysis(
        label=name, id=label_id, type=label_type,
        message_count=count, newest_message=newest,
        flag="healthy", action="keep", confidence="high",
        reason="Active label with reasonable size",
    )


def run_analysis(labels: list[dict], only: str | None = None) -> list[dict]:
    """Analyze all labels."""
    similar_groups = find_similar_pairs(labels)
    orphans = find_nested_orphans(labels)

    results = []
    for label in labels:
        analysis = analyze_label(label, similar_groups, orphans)
        if analysis is None:
            continue
        if only and analysis.flag != only:
            continue
        results.append(asdict(analysis))

    # Sort: actionable items first (delete, merge, archive), then review, then keep
    priority = {"delete": 0, "merge": 1, "archive": 2, "review": 3, "keep": 4}
    results.sort(key=lambda r: (priority.get(r["action"], 5), r["label"]))
    return results


def print_stats(results: list[dict]) -> None:
    """Print analysis statistics."""
    total = len(results)
    by_flag: dict[str, int] = {}
    by_action: dict[str, int] = {}
    for r in results:
        by_flag[r["flag"]] = by_flag.get(r["flag"], 0) + 1
        by_action[r["action"]] = by_action.get(r["action"], 0) + 1

    print(f"Total user labels: {total}")
    print()
    print("By status:")
    for flag, count in sorted(by_flag.items(), key=lambda x: -x[1]):
        print(f"  {flag}: {count}")
    print()
    print("Suggested actions:")
    for action, count in sorted(by_action.items(), key=lambda x: -x[1]):
        print(f"  {action}: {count}")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Gmail label analyzer")
    parser.add_argument("--only", choices=["empty", "stale", "very-stale", "similar", "nested-orphan", "oversized", "healthy"],
                        help="Show only labels with this flag")
    parser.add_argument("--stats", action="store_true", help="Print statistics instead of full analysis")
    args = parser.parse_args()

    labels = json.load(sys.stdin)
    if not isinstance(labels, list):
        print("Error: expected JSON array of label objects", file=sys.stderr)
        sys.exit(1)

    results = run_analysis(labels, only=args.only)

    if args.stats:
        print_stats(results)
    else:
        json.dump(results, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
