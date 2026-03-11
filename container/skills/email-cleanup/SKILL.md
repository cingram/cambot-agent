---
name: email-cleanup
description: Clean up, classify, and organize the user's email inbox. Fetches emails, classifies them using deterministic rules and AI judgment, proposes a cleanup plan, and executes after user approval. Use when the user asks to "clean up email", "organize inbox", "triage email", "sort my mail", or similar.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Email Inbox Cleanup

Multi-phase inbox cleanup: fetch, classify, propose, approve, execute. Deterministic classification first, AI judgment second, user approval before any action.

## Tools

Deterministic classifiers live in `${CLAUDE_SKILL_DIR}/scripts/`. Run them via Bash:

```bash
# Classify a batch of emails (reads JSON from stdin, writes classified JSON to stdout)
cat emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py

# Just run sender lookup
cat emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py --only sender

# Just run header analysis
cat emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py --only header

# Just run subject patterns
cat emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py --only subject
```

Input format: JSON array of email objects from `check_email`.
Output format: same array with `classification` added to each object.

For the full classification pipeline and rule details, see [reference.md](reference.md).

## Procedure

### Phase 1: Fetch & Scope

1. Ask the user what timeframe and scope they want (or default to last 7 days)
2. Use `check_email` to fetch emails — page through results if needed
3. Write to `/workspace/group/cleanup/emails.json`

### Phase 2: Classify

1. Pipe emails through the deterministic classifier:
   ```bash
   cat /workspace/group/cleanup/emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py > /workspace/group/cleanup/classified.json
   ```
2. Check how many remain unclassified:
   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py --stats < /workspace/group/cleanup/classified.json
   ```
3. For unclassified emails, use your own AI judgment — batch 10-20 at a time
4. Use `delegate_to_worker` for parallel classification if 50+ unclassified

### Phase 3: Self-Critique

Review your groupings before presenting. Ask yourself:
- Any redundant categories? Merge them.
- Any too-broad categories? Split them.
- Emails that don't fit? Put in "Needs Review."
- Would the user understand these names?

Iterate once. Don't over-optimize.

### Phase 4: Propose

Present to the user via `send_message`:
- Category breakdown with counts
- 2-3 example emails per category
- Suggested action per category (archive, delete, label, keep)
- "Needs Review" list shown individually
- Ask: "Reply with changes or approve to proceed."

### Phase 5: Feedback & Execute

- Incorporate any user edits, re-present if they changed things
- On approval, execute actions via Gmail tools
- Report progress every 20 emails
- Save run summary to `/workspace/group/cleanup/last-run.json`

## Rules

- **Never delete without approval.** Archive over delete for borderline cases.
- **Deterministic first.** Only use AI for what rules can't classify.
- **Save your work.** Write intermediate results so interrupted runs can resume.
- **Learn from corrections.** Save user corrections to `/workspace/group/cleanup/learned-rules.json` — the classifier reads these on next run.
