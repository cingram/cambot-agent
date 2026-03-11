---
name: label-cleanup
description: Audit, consolidate, and clean up Gmail labels/folders. Finds empty labels, stale labels, duplicates, and proposes merges or deletions. Use when the user asks to "clean up labels", "organize folders", "fix my labels", "consolidate labels", or similar.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Gmail Label / Folder Cleanup

Audit all Gmail labels, identify waste and redundancy, propose a consolidation plan, execute after user approval.

## Tools

Analysis scripts live in `${CLAUDE_SKILL_DIR}/scripts/`. Run them via Bash:

```bash
# Analyze label data (reads JSON from stdin, writes analysis to stdout)
cat labels.json | python3 ${CLAUDE_SKILL_DIR}/scripts/analyze-labels.py

# Just show empty labels
cat labels.json | python3 ${CLAUDE_SKILL_DIR}/scripts/analyze-labels.py --only empty

# Just show similar/duplicate labels
cat labels.json | python3 ${CLAUDE_SKILL_DIR}/scripts/analyze-labels.py --only similar
```

Input format: JSON array of label objects from `list_gmail_labels`.
For the full analysis rules, see [reference.md](reference.md).

## Procedure

### Phase 1: Inventory

1. Use `list_gmail_labels` to fetch all labels
2. For each user-created label, use `search_gmail_messages` with `label:{name}` to get message counts and most recent date
3. Write inventory to `/workspace/group/cleanup/labels-inventory.json`

### Phase 2: Analyze

1. Pipe inventory through the analysis script:
   ```bash
   cat /workspace/group/cleanup/labels-inventory.json | python3 ${CLAUDE_SKILL_DIR}/scripts/analyze-labels.py > /workspace/group/cleanup/labels-analysis.json
   ```
2. Review the output — it flags: empty labels, stale labels, similar names, deeply nested labels, and oversized catch-alls

### Phase 3: Self-Critique

Review the proposed changes before presenting:
- Would merging these labels lose meaningful distinction?
- Are any "stale" labels seasonal (e.g., "Taxes 2024" — stale but intentional)?
- Are nested labels part of a deliberate hierarchy?
- Would the user recognize these groupings?

### Phase 4: Propose

Present to the user via `send_message`:
- **Summary stats**: total labels, user-created, system, empty, stale
- **Delete** — empty labels (0 messages)
- **Merge** — similar/duplicate labels with suggested target
- **Archive** — stale labels (no messages in 6+ months) — move emails to a parent label, then delete
- **Keep** — active labels that look healthy
- **Needs Review** — ambiguous cases shown individually
- Ask: "Reply with changes or approve to proceed."

### Phase 5: Execute

- Incorporate any user edits, re-present if they changed things
- On approval, execute in this order:
  1. **Merge first** — use `batch_modify_gmail_message_labels` to move emails from source label to target label
  2. **Delete empty** — use `manage_gmail_label` to remove labels with 0 messages
  3. **Rename** — use `manage_gmail_label` if consolidating names
- Report progress after each batch
- Save run summary to `/workspace/group/cleanup/labels-last-run.json`

## Rules

- **Never delete labels with messages without moving them first.**
- **Never touch system labels** (INBOX, SENT, TRASH, SPAM, STARRED, etc.).
- **Deterministic first.** The script handles pattern matching; only use AI for ambiguous cases.
- **Save your work.** Write intermediate results so interrupted runs can resume.
- **Preserve user intent.** When in doubt, keep the label and ask.
