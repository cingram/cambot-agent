# Email Cleanup — Reference

## Sender Engagement Tiering (Pass 1)

Sender tiers are computed from the **Sender Frequency Table** — aggregate stats per sender address.

### Metrics

| Metric | Formula |
|--------|---------|
| Reply rate | replies sent to sender / emails received from sender |
| Read rate | read emails from sender / total emails from sender |
| Received count | total emails from this sender in inbox |

### Tier Assignments

Evaluate in order — first match wins:

| Tier | Condition | Label |
|------|-----------|-------|
| 1 — High Signal | reply_rate > 0.25 OR sender in Contacts | Real person |
| 2 — Medium Signal | read_rate > 0.50 AND reply_rate < 0.25 | FYI / useful newsletter |
| 3 — Noise | read_rate < 0.50 AND reply_rate < 0.05 AND received > 10 | Marketing / automated |
| 4 — Unknown | received < 3 | Insufficient data |

### Age/Status Segments

| Segment | Condition | Disposition |
|---------|-----------|-------------|
| Stale Unread | unread AND age > 90 days | Archive candidate |
| Stale Read | read AND no reply AND age > 180 days | Archive candidate |
| Recent Unread | unread AND age <= 30 days | Needs attention |
| Active Thread | thread activity within 14 days | Preserve |

## Priority Scoring (Pass 4)

```
Priority Score = (tier_weight × 3) + (age_days × 0.5) + (thread_length × 0.2)
```

| Sender Tier | Weight |
|-------------|--------|
| Tier 1 | 10 |
| Tier 2 | 5 |
| Tier 4 / Unknown | 3 |

Higher score = more urgent. An important sender + old email = you're really late.

## Cambot Labels

| Label | Applied In | Meaning |
|-------|-----------|---------|
| `Cambot/Archived-Noise` | Pass 2 | Tier 3 sender bulk archive |
| `Cambot/Archived-Stale` | Pass 2 | Unread > 90 days |
| `Cambot/Archived-Old` | Pass 2 | Read, no reply, > 180 days |
| `Cambot/Needs-Response` | Pass 3 | Action required from client |
| `Cambot/Waiting-On-Them` | Pass 3 | Ball in other person's court |
| `Cambot/FYI` | Pass 3 | Informational, no action |
| `Cambot/Actionable` | Pass 3 | Non-urgent action item |
| `Cambot/Dead-Thread` | Pass 3 | Conversation over |

## Deterministic Classification Pipeline

Each email gets the **first confident match**. Pipeline runs in this order:

1. **Learned Rules** — user corrections from previous runs
2. **Sender Lookup** — domain/address pattern matching
3. **Header Analysis** — email header signals
4. **Subject Patterns** — regex on subject line
5. **Thread Inheritance** — inherit parent thread's category
6. **Attachment Type** — classify by attachment signals

Emails not matched by any rule get `classification: null` and are left for AI judgment.

### Learned Rules

File: `/workspace/group/cleanup/learned-rules.json`

```json
[
  { "field": "from", "pattern": "weekly@company.com", "category": "Internal Updates", "action": "archive" },
  { "field": "subject", "pattern": "standup notes", "category": "Internal Updates", "action": "keep" }
]
```

### Sender Lookup

| Pattern | Category |
|---------|----------|
| `noreply@*`, `no-reply@*` | Automated |
| `*@github.com` | Dev Notifications |
| `*@gitlab.com` | Dev Notifications |
| `*@bitbucket.org` | Dev Notifications |
| `*@linkedin.com` | Social |
| `*@facebook.com`, `*@facebookmail.com` | Social |
| `*@twitter.com`, `*@x.com` | Social |
| `*@*.substack.com` | Newsletters |
| Mailchimp, SendGrid, Constant Contact domains | Marketing |
| `*@calendar.google.com` | Calendar |

### Header Signals

| Header | Value | Category |
|--------|-------|----------|
| `List-Unsubscribe` | present | Newsletter / Mailing List |
| `Precedence` | `bulk` or `list` | Mass Email |
| `Auto-Submitted` | any value | Automated |
| `X-Auto-Response-Suppress` | any value | Automated |

### Subject Patterns

| Pattern (case-insensitive) | Category |
|---------------------------|----------|
| `your order`, `shipping`, `delivery`, `shipped`, `out for delivery` | Orders & Shipping |
| `receipt`, `invoice`, `payment`, `billing statement` | Receipts & Billing |
| `reset your password`, `verify your email`, `confirm your account`, `security alert` | Account Security |
| `invited you`, `shared a document`, `shared a file`, `commented on` | Collaboration |
| `accepted`, `declined`, `invitation:`, `calendar event` | Calendar |
| `unsubscribe`, `weekly digest`, `daily digest`, `newsletter` | Newsletter |

### Thread Inheritance

If `In-Reply-To` or `References` headers point to an already-classified email, inherit that classification. Confidence: high.

### Attachment Type

| Signal | Category |
|--------|----------|
| `.ics` file | Calendar |
| `.pdf` from commercial domain | Receipt / Invoice |
| Only images, from known marketing sender | Marketing |

## Classifier Output Format

```json
{
  "classification": {
    "category": "Newsletters",
    "action": "archive",
    "confidence": "high",
    "rule": "sender",
    "reason": "Matched *@*.substack.com"
  }
}
```

- `category` — the classification label
- `action` — `"archive"` | `"delete"` | `"label"` | `"keep"` | `"review"`
- `confidence` — `"high"` | `"medium"` | `"low"`
- `rule` — which pipeline stage matched
- `reason` — human-readable explanation

Unclassified emails have `classification: null`.

## Default Actions by Category

| Category | Default Action |
|----------|---------------|
| Automated | archive |
| Dev Notifications | archive + label |
| Social | archive |
| Newsletters | archive |
| Marketing | delete |
| Orders & Shipping | label + keep |
| Receipts & Billing | label + archive |
| Account Security | keep |
| Collaboration | keep |
| Calendar | archive |
| Needs Review | review |

## File Layout

All intermediate data stored in `/workspace/group/cleanup/`:

| File | Pass | Contents |
|------|------|----------|
| `emails.json` | 1 | Raw inbox data |
| `sender-frequency.json` | 1 | Sender engagement table |
| `classified.json` | 1 | Deterministic classifier output |
| `triage-report.json` | 1 | Pass 1 summary |
| `cleanup-report.json` | 2 | Pass 2 summary |
| `priority-dashboard.json` | 4 | Final priority list |
| `audit-log.json` | all | Running log of all actions taken |
| `learned-rules.json` | all | User corrections for future runs |
