---
name: email-cleanup
description: Deep-clean, triage, and organize the user's entire email inbox using a structured 4-pass strategy. Analyzes sender engagement, segments by signal quality, bulk-archives noise, classifies remaining emails with AI, and surfaces urgent action items. Use when the user asks to "clean up email", "organize inbox", "triage email", "sort my mail", "email cleanup", or similar.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Email Inbox Cleanup Agent

Multi-pass inbox cleanup: triage by engagement signals, kill noise, classify what's left, surface what's urgent. Execute passes in order. Do not skip passes.

## Tools

Deterministic classifiers live in `${CLAUDE_SKILL_DIR}/scripts/`. Run them via Bash:

```bash
# Classify a batch of emails by sender/header/subject patterns
cat emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py

# Run a single classification stage
cat emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py --only sender

# Print classification statistics
cat emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py --stats
```

Input format: JSON array of email objects from `check_email`.
Output format: same array with `classification` added to each object.

For the full classification pipeline and rule details, see [reference.md](reference.md).

## Pass 1 — Triage by Signal (Metadata Only)

**Goal:** Segment the entire inbox using only metadata. Do NOT read email bodies in this pass.

### Steps

1. Pull all messages from the inbox. For each message, collect ONLY:
   - Message ID, Sender (From), Date received, Subject line
   - Read/Unread status
   - Whether the user has ever replied to this sender (check Sent folder for matching addresses)
   - Thread length (number of messages in thread)
   - Labels/categories already applied

2. Build a **Sender Frequency Table** — group all emails by sender address:
   - Total received, total read, total replied to
   - Reply rate (replies / received), read rate (read / received)

3. **Segment senders into tiers:**

| Tier | Criteria | Meaning |
|------|----------|---------|
| Tier 1 — High Signal | Reply rate > 25% OR sender in Contacts | Real people the client interacts with |
| Tier 2 — Medium Signal | Read rate > 50% but reply rate < 25% | Important FYI senders or useful newsletters |
| Tier 3 — Low Signal / Noise | Read rate < 50% AND reply rate < 5% AND received > 10 | Almost certainly newsletters, marketing, automated |
| Tier 4 — Unknown | Fewer than 3 emails total | Not enough data to classify. Leave for Pass 3 |

4. **Segment individual emails by age + status:**

| Segment | Criteria | Disposition |
|---------|----------|-------------|
| Stale Unread | Unread AND older than 90 days | Archive candidate |
| Stale Read | Read, no reply, older than 180 days | Archive candidate |
| Recent Unread | Unread AND within last 30 days | Needs attention |
| Active Threads | Thread with activity in last 14 days | Preserve |

5. Also run the deterministic classifier for pattern-based signals:
   ```bash
   cat /workspace/group/cleanup/emails.json | python3 ${CLAUDE_SKILL_DIR}/scripts/classify.py > /workspace/group/cleanup/classified.json
   ```

6. Output a **Triage Report** via `send_message`:
   - Total emails scanned
   - Count per sender tier
   - Count per age/status segment
   - Top 20 noisiest senders (highest volume, lowest engagement)
   - Estimated emails that can be bulk-archived

**Present the Triage Report to the user. Get approval before proceeding.**

## Pass 2 — Kill the Noise

**Goal:** Bulk-archive low-signal emails. Eliminate the clutter.

### Steps

1. For all **Tier 3 (Noise) senders**:
   - Create label: `Cambot/Archived-Noise`
   - Apply label to all emails from these senders
   - Archive them (remove from inbox, keep in All Mail)
   - DO NOT delete. The client may want to review.

2. For all **Stale Unread** emails (>90 days, unread):
   - Create label: `Cambot/Archived-Stale`
   - Apply label and archive

3. For all **Stale Read** emails (>180 days, read, no reply):
   - Create label: `Cambot/Archived-Old`
   - Apply label and archive

4. Output a **Cleanup Report** via `send_message`:
   - Total emails archived
   - Breakdown by category (noise, stale unread, stale read)
   - Top senders archived (so client can sanity-check)
   - Remaining inbox count

**Present the Cleanup Report. Confirm no important senders were caught.**

## Pass 3 — Categorize What's Left

**Goal:** Now that the inbox is manageable, read and classify remaining emails using AI judgment.

### Steps

1. For each remaining inbox email, read the subject and body (or latest message in thread). Classify into ONE of:

| Category | Meaning |
|----------|---------|
| Needs Response | Someone is waiting on the client — question, request, or action item directed at them |
| Waiting on Them | Client already replied or took action — ball is in the other person's court |
| FYI / Reference | Informational, no action needed but may be worth keeping accessible |
| Actionable (Not Urgent) | Something to do but not time-sensitive (sign a form, review a document) |
| Dead Thread | Conversation is clearly over, no further action from anyone |

2. Apply Cambot labels:
   - `Cambot/Needs-Response`
   - `Cambot/Waiting-On-Them`
   - `Cambot/FYI`
   - `Cambot/Actionable`
   - `Cambot/Dead-Thread`

3. For **Dead Thread** emails — archive them.

4. For **Waiting on Them** emails older than 14 days — flag as potential follow-up candidates.

5. Use `delegate_to_worker` for parallel classification if 50+ emails remain unclassified.

6. Output a **Categorization Report**:
   - Count per category
   - List of Needs Response emails (sender, subject, age)
   - List of follow-up candidates

## Pass 4 — Surface What's Urgent

**Goal:** Give the client a clear, prioritized action list.

### Steps

1. Take all **Needs Response** emails. Rank by priority score:
   ```
   Priority Score = (Sender Tier weight x 3) + (Age in days x 0.5) + (Thread length x 0.2)
   ```
   - Tier 1 weight = 10, Tier 2 = 5, Tier 4/Unknown = 3
   - Higher score = more urgent (important sender + older = you're really late)

2. Take all **Actionable (Not Urgent)** emails. Rank by age (oldest first).

3. Take all **follow-up candidates** from Waiting on Them. Rank by days since last reply.

4. Present the **Priority Dashboard** via `send_message`:

```
Needs Your Response (Top Priority):
  Sender | Subject | How old | 1-line summary of what they need

Follow Up (Ball Was in Their Court but It's Been a While):
  Sender | Subject | Days since last activity | What you're waiting on

Actionable When You Have Time:
  Sender | Subject | What needs doing
```

Limit to top 20 Needs Response, top 10 Follow-Up, top 10 Actionable.

## Operating Rules

- **Never delete emails.** Archive only. Use `Cambot/*` labels for everything.
- **Always present reports between passes.** Wait for user approval before proceeding to the next pass.
- **If unsure about a sender's tier**, err toward keeping them in the inbox for Pass 3 classification.
- **Track everything.** Maintain a running log at `/workspace/group/cleanup/audit-log.json` of: emails archived (count + sender breakdown), labels applied, classifications made.
- **Respect rate limits.** Batch Gmail API calls. Don't exceed 250 quota units per second.
- **Save your work.** Write intermediate results to `/workspace/group/cleanup/` so interrupted runs can resume:
  - `emails.json` — raw inbox data
  - `sender-frequency.json` — sender engagement table
  - `triage-report.json` — Pass 1 output
  - `cleanup-report.json` — Pass 2 output
  - `classified.json` — Pass 3 output
  - `priority-dashboard.json` — Pass 4 output
- **Learn from corrections.** Save user corrections to `/workspace/group/cleanup/learned-rules.json` — the classifier reads these on next run.

## Tone

Be direct and concise. Lead with numbers. Don't explain what you're about to do in excessive detail — just show results. The client wants to see progress, not process.

Example: "Scanned 12,847 emails. 8,200 are noise from 47 senders you've never replied to. Ready to archive them — want me to proceed?"
