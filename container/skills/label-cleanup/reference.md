# Label Cleanup — Analysis Reference

## Analysis Categories

Each label gets one of these flags:

| Flag | Meaning | Default Action |
|------|---------|---------------|
| `empty` | 0 messages | delete |
| `stale` | No messages newer than 6 months | archive + delete |
| `duplicate` | Nearly identical name to another label | merge |
| `similar` | Similar name suggests overlap | merge (review) |
| `nested-orphan` | Child label whose parent doesn't exist | rename or flatten |
| `oversized` | 1000+ messages, likely a catch-all | review |
| `healthy` | Active, reasonable size | keep |

## System Labels (Never Touch)

These are Gmail system labels — skip them entirely:

- `INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`
- `IMPORTANT`, `CATEGORY_PERSONAL`, `CATEGORY_SOCIAL`
- `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`
- Any label starting with `CHAT` or `VOICE`

## Similarity Detection

### Exact Duplicates (case-insensitive)
- `Projects` vs `projects` → merge

### Near Duplicates
- Singular vs plural: `Invoice` vs `Invoices`
- With/without separator: `Work Projects` vs `Work-Projects` vs `WorkProjects`
- Abbreviation: `Dev` vs `Development`

### Hierarchical Overlap
- `Work` and `Work/Projects` and `Work/Projects/2024` — check if parent is just a container
- Flat labels that could be nested: `Work Projects` alongside `Work/`

## Staleness Rules

| Condition | Classification |
|-----------|---------------|
| 0 messages | `empty` |
| All messages older than 6 months | `stale` |
| All messages older than 12 months | `very-stale` |
| Has messages in last 30 days | `active` |
| Has messages in last 6 months | `semi-active` |

## Merge Strategy

When merging labels A → B:
1. Pick the label with more messages as the target
2. If equal, pick the one with more recent messages
3. Use `batch_modify_gmail_message_labels` to add target label and remove source label
4. After all messages moved, delete source label

## Output Format

The analyzer outputs a JSON array:

```json
[
  {
    "label": "Old Projects",
    "id": "Label_123",
    "type": "user",
    "message_count": 0,
    "newest_message": null,
    "flag": "empty",
    "action": "delete",
    "confidence": "high",
    "reason": "Label has 0 messages",
    "merge_target": null
  },
  {
    "label": "Invoices",
    "id": "Label_456",
    "type": "user",
    "message_count": 15,
    "newest_message": "2025-01-15",
    "flag": "similar",
    "action": "merge",
    "confidence": "medium",
    "reason": "Similar to 'Invoice' (singular/plural)",
    "merge_target": "Invoice"
  }
]
```

## Common Gmail Label Patterns to Consolidate

| Pattern | Suggestion |
|---------|-----------|
| Year-based labels (`2020`, `2021`, `2022`) | Merge into `Archive/{year}` or delete if empty |
| Project + year (`Project-2023`, `Project-2024`) | Keep most recent, archive old |
| Service names (`GitHub`, `GitHub Notifications`) | Merge into one |
| Email/newsletter variants (`Newsletter`, `Newsletters`, `News`) | Merge into one |
| Status labels (`Todo`, `To Do`, `Action Required`) | Merge into one |
| People labels (`John`, `John Smith`) | Merge into one |
