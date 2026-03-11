#!/usr/bin/env python3
"""
Deterministic email classifier.

Reads JSON email array from stdin, writes classified JSON to stdout.
Each email gets a `classification` field added (or null if no rule matched).

Usage:
    cat emails.json | python3 classify.py
    cat emails.json | python3 classify.py --only sender
    cat emails.json | python3 classify.py --stats
"""

import json
import re
import sys
from pathlib import Path
from dataclasses import dataclass

CLEANUP_DIR = Path("/workspace/group/cleanup")
LEARNED_RULES_FILE = CLEANUP_DIR / "learned-rules.json"

# --- Sender patterns ---

SENDER_PATTERNS: list[tuple[str, str, str]] = [
    # (regex on from address, category, default action)
    (r"noreply@|no-reply@", "Automated", "archive"),
    (r"@github\.com$", "Dev Notifications", "archive"),
    (r"@gitlab\.com$", "Dev Notifications", "archive"),
    (r"@bitbucket\.org$", "Dev Notifications", "archive"),
    (r"@linkedin\.com$", "Social", "archive"),
    (r"@(facebook|facebookmail)\.com$", "Social", "archive"),
    (r"@(twitter|x)\.com$", "Social", "archive"),
    (r"\.substack\.com$", "Newsletters", "archive"),
    (r"@calendar\.google\.com$", "Calendar", "archive"),
    # Marketing ESPs
    (r"@.*\.(mailchimp|sendgrid|constantcontact|mailgun|campaign-archive)\.com$", "Marketing", "delete"),
    (r"@.*\.list-manage\.com$", "Marketing", "delete"),
]

# --- Subject patterns ---

SUBJECT_PATTERNS: list[tuple[str, str, str]] = [
    (r"your order|shipping|delivery|shipped|out for delivery|tracking number", "Orders & Shipping", "keep"),
    (r"receipt|invoice|payment|billing statement|your .+ bill", "Receipts & Billing", "archive"),
    (r"reset your password|verify your (email|account)|confirm your account|security alert|suspicious sign.in", "Account Security", "keep"),
    (r"invited you|shared a (document|file|folder)|commented on|mentioned you", "Collaboration", "keep"),
    (r"accepted|declined|invitation:|calendar event|rsvp", "Calendar", "archive"),
    (r"unsubscribe|weekly digest|daily digest|newsletter|weekly roundup", "Newsletters", "archive"),
]

# --- Header signals ---

HEADER_SIGNALS: list[tuple[str, str | None, str, str]] = [
    # (header name, value pattern or None for presence check, category, action)
    ("list-unsubscribe", None, "Newsletters", "archive"),
    ("precedence", r"bulk|list", "Mass Email", "archive"),
    ("auto-submitted", None, "Automated", "archive"),
    ("x-auto-response-suppress", None, "Automated", "archive"),
]

# --- Attachment signals ---

ATTACHMENT_SIGNALS: list[tuple[str, str, str]] = [
    (r"\.ics$", "Calendar", "archive"),
    (r"\.pdf$", "Receipts & Billing", "archive"),
]


@dataclass
class Classification:
    category: str
    action: str
    confidence: str
    rule: str
    reason: str

    def to_dict(self) -> dict:
        return {
            "category": self.category,
            "action": self.action,
            "confidence": self.confidence,
            "rule": self.rule,
            "reason": self.reason,
        }


def load_learned_rules() -> list[dict]:
    if LEARNED_RULES_FILE.exists():
        try:
            return json.loads(LEARNED_RULES_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return []
    return []


def classify_learned(email: dict, rules: list[dict]) -> Classification | None:
    for rule in rules:
        field = rule.get("field", "")
        pattern = rule.get("pattern", "")
        value = _get_email_field(email, field)
        if value and re.search(pattern, value, re.IGNORECASE):
            return Classification(
                category=rule["category"],
                action=rule.get("action", "archive"),
                confidence="high",
                rule="learned",
                reason=f"Learned rule: {field} matches '{pattern}'",
            )
    return None


def classify_sender(email: dict) -> Classification | None:
    sender = _get_email_field(email, "from") or ""
    for pattern, category, action in SENDER_PATTERNS:
        if re.search(pattern, sender, re.IGNORECASE):
            return Classification(
                category=category,
                action=action,
                confidence="high",
                rule="sender",
                reason=f"Sender matches {pattern}",
            )
    return None


def classify_header(email: dict) -> Classification | None:
    headers = email.get("headers", {})
    if not headers:
        return None
    for header_name, value_pattern, category, action in HEADER_SIGNALS:
        header_val = headers.get(header_name, headers.get(header_name.title(), ""))
        if not header_val:
            # Try case-insensitive lookup
            for k, v in headers.items():
                if k.lower() == header_name.lower():
                    header_val = v
                    break
        if header_val:
            if value_pattern is None or re.search(value_pattern, str(header_val), re.IGNORECASE):
                return Classification(
                    category=category,
                    action=action,
                    confidence="high",
                    rule="header",
                    reason=f"Header '{header_name}' present" + (f" (matches {value_pattern})" if value_pattern else ""),
                )
    return None


def classify_subject(email: dict) -> Classification | None:
    subject = _get_email_field(email, "subject") or ""
    for pattern, category, action in SUBJECT_PATTERNS:
        if re.search(pattern, subject, re.IGNORECASE):
            return Classification(
                category=category,
                action=action,
                confidence="medium",
                rule="subject",
                reason=f"Subject matches pattern: {pattern}",
            )
    return None


def classify_thread(email: dict, classified: dict[str, Classification]) -> Classification | None:
    # Check if this email references an already-classified thread
    refs = email.get("references", email.get("in_reply_to", ""))
    if not refs:
        return None
    ref_ids = refs.split() if isinstance(refs, str) else refs
    for ref_id in ref_ids:
        if ref_id in classified:
            parent = classified[ref_id]
            return Classification(
                category=parent.category,
                action=parent.action,
                confidence="high",
                rule="thread",
                reason=f"Thread inherits from parent: {ref_id}",
            )
    return None


def classify_attachment(email: dict) -> Classification | None:
    attachments = email.get("attachments", [])
    if not attachments:
        return None
    for att in attachments:
        filename = att if isinstance(att, str) else att.get("filename", att.get("name", ""))
        for pattern, category, action in ATTACHMENT_SIGNALS:
            if re.search(pattern, filename, re.IGNORECASE):
                return Classification(
                    category=category,
                    action=action,
                    confidence="medium",
                    rule="attachment",
                    reason=f"Attachment '{filename}' matches {pattern}",
                )
    return None


def _get_email_field(email: dict, field: str) -> str | None:
    """Get a field from an email, handling nested structures."""
    if field in email:
        return str(email[field])
    # Try common nested paths
    for key in ["payload", "metadata", "envelope"]:
        if key in email and isinstance(email[key], dict) and field in email[key]:
            return str(email[key][field])
    return None


def classify_email(
    email: dict,
    learned_rules: list[dict],
    classified_threads: dict[str, Classification],
    only: str | None = None,
) -> Classification | None:
    """Run the classification pipeline. Returns first confident match or None."""
    stages: list[tuple[str, callable]] = [
        ("learned", lambda e: classify_learned(e, learned_rules)),
        ("sender", classify_sender),
        ("header", classify_header),
        ("subject", classify_subject),
        ("thread", lambda e: classify_thread(e, classified_threads)),
        ("attachment", classify_attachment),
    ]

    for stage_name, classifier in stages:
        if only and stage_name != only:
            continue
        result = classifier(email)
        if result:
            return result
    return None


def run_pipeline(emails: list[dict], only: str | None = None) -> list[dict]:
    """Classify all emails and return them with classification added."""
    learned_rules = load_learned_rules()
    classified_threads: dict[str, Classification] = {}

    for email in emails:
        result = classify_email(email, learned_rules, classified_threads, only)
        email["classification"] = result.to_dict() if result else None

        # Track for thread inheritance
        msg_id = email.get("message_id", email.get("id", ""))
        if msg_id and result:
            classified_threads[msg_id] = result

    return emails


def print_stats(emails: list[dict]) -> None:
    """Print classification statistics."""
    total = len(emails)
    classified = sum(1 for e in emails if e.get("classification"))
    unclassified = total - classified

    by_rule: dict[str, int] = {}
    by_category: dict[str, int] = {}
    for e in emails:
        c = e.get("classification")
        if c:
            by_rule[c["rule"]] = by_rule.get(c["rule"], 0) + 1
            by_category[c["category"]] = by_category.get(c["category"], 0) + 1

    print(f"Total: {total}")
    print(f"Classified: {classified} ({classified/total*100:.0f}%)" if total else "Classified: 0")
    print(f"Unclassified: {unclassified} (need AI)")
    print()
    print("By rule:")
    for rule, count in sorted(by_rule.items(), key=lambda x: -x[1]):
        print(f"  {rule}: {count}")
    print()
    print("By category:")
    for cat, count in sorted(by_category.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {count}")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Deterministic email classifier")
    parser.add_argument("--only", choices=["learned", "sender", "header", "subject", "thread", "attachment"],
                        help="Run only a specific classification stage")
    parser.add_argument("--stats", action="store_true", help="Print statistics instead of classified output")
    args = parser.parse_args()

    emails = json.load(sys.stdin)

    if not isinstance(emails, list):
        print("Error: expected JSON array of email objects", file=sys.stderr)
        sys.exit(1)

    classified = run_pipeline(emails, only=args.only)

    if args.stats:
        print_stats(classified)
    else:
        json.dump(classified, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
