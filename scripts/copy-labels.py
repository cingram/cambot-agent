#!/usr/bin/env python3
"""
Copy Gmail labels from one account to another.

Reads user-created labels from the source account and creates them
in the target account. Skips system labels and labels that already exist.
Preserves nested label hierarchy (e.g., "Work/Projects/Active").

Reuses workspace-mcp OAuth tokens — both accounts must be authenticated.

Usage:
    uv run --with google-auth --with google-api-python-client scripts/copy-labels.py
    uv run --with google-auth --with google-api-python-client scripts/copy-labels.py --dry-run
    uv run --with google-auth --with google-api-python-client scripts/copy-labels.py --source other@gmail.com --target test@gmail.com
"""

import argparse
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SOURCE_EMAIL = "cameroningram62@gmail.com"
TARGET_EMAIL = "camingram810@gmail.com"

# System labels that can't be created
SYSTEM_LABELS = {
    "INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "STARRED", "UNREAD",
    "IMPORTANT", "CHAT", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
}


def get_credentials(email: str) -> Credentials:
    token_path = Path.home() / ".google_workspace_mcp" / "credentials" / f"{email}.json"
    if not token_path.exists():
        print(f"ERROR: No credentials found for {email}")
        print(f"Expected at: {token_path}")
        print(f"Run google-auth.py for this account first.")
        sys.exit(1)

    creds = Credentials.from_authorized_user_file(str(token_path))
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        return creds

    print(f"ERROR: Credentials for {email} are expired and can't be refreshed.")
    sys.exit(1)


def get_user_labels(service) -> list[dict]:
    """Get all user-created labels (excludes system labels)."""
    results = service.users().labels().list(userId="me").execute()
    labels = results.get("labels", [])
    return [l for l in labels if l["type"] == "user"]


def main():
    parser = argparse.ArgumentParser(description="Copy Gmail labels between accounts")
    parser.add_argument("--source", default=SOURCE_EMAIL, help=f"Source email (default: {SOURCE_EMAIL})")
    parser.add_argument("--target", default=TARGET_EMAIL, help=f"Target email (default: {TARGET_EMAIL})")
    parser.add_argument("--dry-run", action="store_true", help="Preview without creating labels")
    args = parser.parse_args()

    print(f"Source: {args.source}")
    print(f"Target: {args.target}\n")

    # Authenticate both accounts
    print("Authenticating source account...")
    source_creds = get_credentials(args.source)
    source_service = build("gmail", "v1", credentials=source_creds)

    print("Authenticating target account...")
    target_creds = get_credentials(args.target)
    target_service = build("gmail", "v1", credentials=target_creds)

    # Get labels from both accounts
    print("\nFetching source labels...")
    source_labels = get_user_labels(source_service)
    print(f"  Found {len(source_labels)} user labels\n")

    print("Fetching target labels...")
    target_labels = get_user_labels(target_service)
    existing_names = {l["name"] for l in target_labels}
    print(f"  Found {len(target_labels)} existing labels\n")

    # Sort by name so parent labels get created before children
    source_labels.sort(key=lambda l: l["name"])

    created = 0
    skipped = 0

    for label in source_labels:
        name = label["name"]

        if name in existing_names:
            print(f"  SKIP (exists): {name}")
            skipped += 1
            continue

        if args.dry_run:
            print(f"  WOULD CREATE: {name}")
            created += 1
            continue

        try:
            body = {
                "name": name,
                "labelListVisibility": label.get("labelListVisibility", "labelShow"),
                "messageListVisibility": label.get("messageListVisibility", "show"),
            }
            # Copy color if present
            if "color" in label:
                body["color"] = label["color"]

            target_service.users().labels().create(userId="me", body=body).execute()
            existing_names.add(name)
            print(f"  CREATED: {name}")
            created += 1
        except Exception as e:
            print(f"  ERROR creating '{name}': {e}")

    action = "would be created" if args.dry_run else "created"
    print(f"\nDone! {created} labels {action}, {skipped} skipped (already exist).")


if __name__ == "__main__":
    main()
