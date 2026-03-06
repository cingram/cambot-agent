# Request Lifecycle Audit Logging

## Overview

CamBot records a tamper-evident audit trail for every message that flows through the system. From the moment an HTTP webhook arrives to the final delivery confirmation, each step is captured as a structured security event with SHA-256 chain hashing. An auditor can reconstruct the complete chain of custody for any message using a single correlation ID.

Audit events are stored in the existing `security_events` table alongside anomaly detection and cost alerts. This is intentional — a single chain hash covers all security-relevant activity, making selective deletion or tampering detectable.

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Audit log tampering | SHA-256 chain hashing — each event's hash includes the previous event's hash. `verifyChain()` detects any modification, insertion, or deletion. |
| Selective event deletion | Chain break is immediately detectable. The `prev_hash` linkage creates a blockchain-style append-only structure. |
| Log injection via message content | Message text is never stored in audit events. Only `contentLength` (integer) is recorded. |
| Replay attacks on webhooks | `audit.webhook_dedup` events record when duplicate webhook IDs are suppressed. |
| Unauthorized access attempts | `audit.webhook_auth_failed` events record source IP, failed header, and request path at `warning` severity. |
| Cross-tenant data leakage | Correlation IDs are scoped per channel and chat. `queryByCorrelation()` returns only events sharing the exact correlation ID. |
| Audit system blocking the pipeline | All audit writes are fire-and-forget with try/catch. A database failure in the audit layer never blocks message processing. |

## Architecture

### Storage

Audit events reuse the `security_events` table (SQLite, schema v19):

```sql
CREATE TABLE security_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL,          -- ISO 8601 UTC
  severity      TEXT NOT NULL,          -- info | warning | critical | emergency
  event_type    TEXT NOT NULL,          -- audit.* namespace
  source        TEXT NOT NULL,          -- channel name or 'agent'
  description   TEXT NOT NULL,          -- human-readable summary
  details       TEXT,                   -- JSON payload (structured metadata)
  session_key   TEXT,
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolved_at   TEXT,
  chain_hash    TEXT NOT NULL,          -- SHA-256(prev_hash | event_data)
  prev_hash     TEXT,                   -- previous event's chain_hash
  correlation_id TEXT                   -- cross-event linking (v19)
);

CREATE INDEX idx_security_events_correlation_id ON security_events(correlation_id);
```

The `correlation_id` column (added in migration v19) enables lifecycle reconstruction. It is intentionally excluded from the chain hash computation — it is metadata for querying, not content that affects integrity verification.

### Chain Hashing

Every security event is chained using SHA-256:

```
GENESIS | {severity, event_type, source, description, timestamp} → hash₁
hash₁  | {severity, event_type, source, description, timestamp} → hash₂
hash₂  | {severity, event_type, source, description, timestamp} → hash₃
```

The hash input is deterministically serialized (sorted keys, JSON stringified) to ensure reproducibility. Verification walks the entire chain and recomputes each hash:

```typescript
const result = securityEventStore.verifyChain(db);
// Returns null if chain is intact
// Returns { brokenAtId, expected, actual } if tampered
```

Fields included in the hash: `severity`, `event_type`, `source`, `description`, `timestamp`.

Fields excluded from the hash: `details` (JSON payload), `correlation_id`, `session_key`, `resolved`, `resolved_at`. These are queryable metadata that do not affect chain integrity.

### Correlation ID Format

Deterministic IDs reconstructable from message data — no centralized ID generation required:

| Format | When Used | Example |
|--------|-----------|---------|
| `{channel}:{chatJid}:{messageId}` | After message parsing | `imessage:im:+15551234567:msg_abc` |
| `{channel}:webhook:{webhookId}` | At webhook receipt (before messageId known) | `imessage:webhook:wh_abc123` |
| `{channel}:{chatJid}` | Outbound-only (no inbound messageId) | `discord:dc:12345` |

Any handler in the pipeline can reconstruct the same correlation ID from the same inputs. This enables distributed correlation without shared state.

## Event Taxonomy

All audit events use the `audit.*` prefix in `event_type`. Message content (text) is never recorded — only `contentLength`.

### Critical Priority

| Event Type | Severity | Source | Trigger | Details Payload |
|-----------|----------|--------|---------|-----------------|
| `audit.webhook_received` | info | `{channel}` | HTTP request arrives at webhook endpoint | `sourceIp`, `method`, `path`, `userAgent`, `authProvided`, `authValid`, `responseCode`, `durationMs`, `webhookId`, `contentLength` |
| `audit.webhook_auth_failed` | **warning** | `{channel}` | Webhook authentication header missing or invalid | `sourceIp`, `headerName`, `path` |

### High Priority

| Event Type | Severity | Source | Trigger | Details Payload |
|-----------|----------|--------|---------|-----------------|
| `audit.message_inbound` | info | `{channel}` | Message parsed from webhook/socket/poll | `chatJid`, `sender`, `senderName`, `messageId`, `channel`, `isGroup`, `contentLength`, `webhookId` |
| `audit.message_outbound` | info | `agent` | Agent produces a response | `chatJid`, `agentName`, `contentLength` |
| `audit.authorization_decision` | info | `{channel}` | Registered group lookup completes | `chatJid`, `sender`, `messageId`, `decision` (`allowed` or `dropped_unregistered`), `groupFolder` |

### Medium Priority

| Event Type | Severity | Source | Trigger | Details Payload |
|-----------|----------|--------|---------|-----------------|
| `audit.delivery_result` | info | `{channel}` | Provider API returns after send attempt | `chatJid`, `accepted`, `providerMessageId`, `error`, `durationMs` |
| `audit.session_lifecycle` | info | `agent` | Agent session starts or ends | `groupFolder`, `chatJid`, `sessionKey`, `action` (`start` or `end`), `success` |
| `audit.webhook_dedup` | info | `{channel}` | Duplicate webhook ID detected and suppressed | `webhookId` |

## Data Flow

A complete iMessage lifecycle generates the following audit trail:

```
1. HTTP POST /webhook/loopmessage
   ├── AUDIT: audit.webhook_received     (correlation: imessage:webhook:{webhookId})
   │   IF auth fails:
   │   └── AUDIT: audit.webhook_auth_failed  (severity: warning)
   │
2. Provider parses payload
   │   IF duplicate webhookId:
   │   └── AUDIT: audit.webhook_dedup
   │
3. Channel handleInbound()
   ├── Group registration check
   └── AUDIT: audit.authorization_decision  (correlation: imessage:{chatJid}:{messageId})
       ├── decision: allowed → continues
       └── decision: dropped_unregistered → lifecycle ends
   │
4. Bus: message.inbound
   └── AUDIT: audit.message_inbound
   │
5. Agent session
   ├── AUDIT: audit.session_lifecycle (action: start)
   ├── Agent processing...
   │
6. Bus: message.outbound
   └── AUDIT: audit.message_outbound
   │
7. Channel delivery
   ├── Provider.send() → API call
   ├── AUDIT: audit.delivery_result (accepted/failed)
   └── AUDIT: audit.session_lifecycle (action: end)
```

## Channel Coverage

| Channel | webhook_received | webhook_auth_failed | message_inbound | authorization_decision | message_outbound | delivery_result | session_lifecycle |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **iMessage** | Yes (HTTP) | Yes | Yes | Yes | Yes | Yes | Yes |
| **Web** | Yes (HTTP) | -- | Yes | Yes | Yes | Yes | Yes |
| **WhatsApp** | -- (socket) | -- | Yes | Yes | Yes | Yes | Yes |
| **Discord** | -- (gateway) | -- | Yes | Yes | Yes | Yes | Yes |
| **Telegram** | -- (long poll) | -- | Yes | Yes | Yes | Yes | Yes |
| **Email** | -- (poll) | -- | Yes | Yes | Yes | Yes | Yes |
| **CLI** | -- (stdin) | -- | Yes | -- | Yes | Yes | Yes |
| **File** | -- (outbound only) | -- | -- | -- | -- | Yes | -- |

Channels without HTTP inbound (WhatsApp, Discord, Telegram) still emit all applicable audit events — they simply have no network metadata in the webhook fields.

## Querying Audit Data

### Reconstruct a message lifecycle

```sql
SELECT * FROM security_events
WHERE correlation_id = 'imessage:im:+15551234567:msg_abc'
ORDER BY timestamp ASC;
```

Or via the store API:

```typescript
const lifecycle = securityEventStore.queryByCorrelation(db, 'imessage:im:+15551234567:msg_abc');
```

### Find all failed auth attempts

```sql
SELECT timestamp, source,
       json_extract(details, '$.sourceIp') AS ip,
       json_extract(details, '$.path') AS path
FROM security_events
WHERE event_type = 'audit.webhook_auth_failed'
ORDER BY timestamp DESC;
```

### Find dropped (unauthorized) messages

```sql
SELECT timestamp, source,
       json_extract(details, '$.sender') AS sender,
       json_extract(details, '$.chatJid') AS chat
FROM security_events
WHERE event_type = 'audit.authorization_decision'
  AND json_extract(details, '$.decision') = 'dropped_unregistered'
ORDER BY timestamp DESC;
```

### Find delivery failures

```sql
SELECT timestamp, source,
       json_extract(details, '$.chatJid') AS chat,
       json_extract(details, '$.error') AS error,
       json_extract(details, '$.durationMs') AS duration_ms
FROM security_events
WHERE event_type = 'audit.delivery_result'
  AND json_extract(details, '$.accepted') = 0
ORDER BY timestamp DESC;
```

### Verify chain integrity

```typescript
const broken = securityEventStore.verifyChain(db);
if (broken) {
  console.error(`Tamper detected at event ${broken.brokenAtId}`);
  console.error(`Expected hash: ${broken.expected}`);
  console.error(`Actual hash:   ${broken.actual}`);
}
```

### Audit event volume by type

```sql
SELECT event_type, COUNT(*) AS count,
       MIN(timestamp) AS first_seen,
       MAX(timestamp) AS last_seen
FROM security_events
WHERE event_type LIKE 'audit.%'
GROUP BY event_type
ORDER BY count DESC;
```

## Data Privacy

| Data Category | Stored | Not Stored |
|--------------|--------|------------|
| Message metadata | Sender ID, chat ID, message ID, content length, timestamps | Message text, attachments, media |
| Network metadata | Source IP, User-Agent, HTTP method, path, response code | Request body, response body, headers (except auth header name) |
| Auth metadata | Whether auth was provided, whether it was valid, which header was checked | Auth token values, credentials |
| Delivery metadata | Provider message ID, accepted/rejected, error message, duration | Response body from provider |

Message content (text, images, files) is never written to audit events. The `contentLength` field records only the byte count.

## Implementation Files

| File | Package | Purpose |
|------|---------|---------|
| `src/schema.ts` | cambot-core | Schema v19 migration (correlation_id column + index) |
| `src/security/security-events.ts` | cambot-core | Store: insert, query, queryByCorrelation, verifyChain |
| `src/security/chain-hash.ts` | cambot-core | SHA-256 chain hash computation |
| `src/audit/correlation.ts` | cambot-agent | Deterministic correlation ID builders |
| `src/audit/audit-emitter.ts` | cambot-agent | Fire-and-forget audit event factory (8 methods) |
| `src/orchestrator/app.ts` | cambot-agent | Wires audit emitter, routes channel audit events |
| `src/orchestrator/bus-handlers.ts` | cambot-agent | Bus handlers for inbound/outbound audit at priority 200 |
| `src/utils/lifecycle-interceptor.ts` | cambot-agent | Session start/end audit |
| `src/types.ts` | cambot-channels | ChannelAuditEvent interface, onAuditEvent callback |

## QA Verification

Automated test script: `bun run test:audit`

```bash
bun run test:audit           # Phases 1-4 (in-memory, no side effects)
bun run test:audit -- --live # Phases 1-5 (includes live DB read-only check)
```

| Phase | What It Verifies |
|-------|-----------------|
| 1. Unit tests | 33 vitest tests: correlation ID formats, all 8 emitter methods, integration lifecycle scenarios, fire-and-forget error handling |
| 2. Schema migration | SCHEMA_VERSION=19, baseline CREATE TABLE includes correlation_id, ALTER TABLE migration path from v18 |
| 3. Core store tests | cambot-core: insert with correlationId, null default, chain hash exclusion, query filters, queryByCorrelation ordering |
| 4. Smoke tests | In-memory lifecycle simulations: full iMessage flow, dropped messages, auth failures, multi-channel isolation, 100-event stress test, dedup |
| 5. Live DB check | Schema version, column presence, event counts, chain integrity, event type distribution (opt-in, read-only) |

## Design Decisions

**Why reuse `security_events` instead of a separate `audit_log` table?**
A separate table would require its own chain hash — splitting the tamper-evident chain into two independent chains. An attacker could delete all audit events without breaking the security event chain. A single table means a single chain covers everything.

**Why is `correlation_id` excluded from the chain hash?**
Correlation IDs are queryable metadata, not content. Including them in the hash would mean that any future correlation ID scheme change would break the chain for historical events. The hash covers the immutable audit content (what happened, when, where, severity).

**Why fire-and-forget?**
Audit logging must never block the message pipeline. A database lock, disk full, or SQLite busy error in the audit layer should not prevent a user's message from being processed. All emitter methods wrap inserts in try/catch and log warnings on failure.

**Why deterministic correlation IDs instead of UUIDs?**
Any handler in the pipeline can reconstruct the correlation ID from message data without receiving it from a previous handler. This eliminates the need to thread a correlation context object through every function call. It also means correlation IDs are verifiable — given the message data, you can independently confirm the correlation ID is correct.
