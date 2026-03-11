# Email Cleanup — Classification Reference

## Pipeline Order

Each email gets the **first confident match**. The pipeline runs in this order:

1. **Learned Rules** — user corrections from previous runs
2. **Sender Lookup** — domain/address pattern matching
3. **Header Analysis** — email header signals
4. **Subject Patterns** — regex on subject line
5. **Thread Inheritance** — inherit parent thread's category
6. **Attachment Type** — classify by attachment signals

Emails not matched by any rule get `classification: null` and are left for AI judgment.

## Rule Details

### Learned Rules
File: `/workspace/group/cleanup/learned-rules.json`

User corrections from previous runs. Format:
```json
[
  { "field": "from", "pattern": "weekly@company.com", "category": "Internal Updates", "action": "archive" },
  { "field": "subject", "pattern": "standup notes", "category": "Internal Updates", "action": "keep" }
]
```

These always take priority — the user has explicitly told us how to classify these.

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

## Output Format

The classifier adds these fields to each email object:

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

- `category`: string — the classification label
- `action`: `"archive"` | `"delete"` | `"label"` | `"keep"` | `"review"` — suggested action
- `confidence`: `"high"` | `"medium"` | `"low"`
- `rule`: which pipeline stage matched (`"learned"`, `"sender"`, `"header"`, `"subject"`, `"thread"`, `"attachment"`)
- `reason`: human-readable explanation

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
