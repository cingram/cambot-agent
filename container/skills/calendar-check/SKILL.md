---
name: calendar-check
description: Format calendar and task output as a clean, scannable schedule summary. Use when checking the calendar, listing events, giving a daily briefing, or answering "what's on my calendar". Produces a consistent layout with time blocks, conflict warnings, and due tasks.
allowed-tools: Bash, Read, Write
---

# Calendar Check — Output Formatter

After fetching calendar events (via `get_events`) and tasks (via `list_tasks` / `list_task_lists`), format the output using this structure. Do NOT improvise the layout — follow the template exactly.

## Output Template

```
{day_header}

{time_block}
...

{conflicts_section}     ← only if conflicts exist
{tasks_section}          ← only if tasks due today/overdue
{free_time_section}      ← only if user asked about availability
```

## Day Header

One line per day. Use the weekday name + date. Mark today explicitly.

```
--- Today, Thursday Mar 13 ---
--- Tomorrow, Friday Mar 14 ---
--- Saturday Mar 15 ---
```

## Time Blocks

Each event gets one compact block. Sort chronologically within each day.

```
10:00 – 11:00  Team Standup
               3 attendees · Google Meet
               meet.google.com/abc-defg-hij

14:30 – 15:00  1:1 with Sarah
               2 attendees · Zoom
               zoom.us/j/123456

All day         Company Holiday
```

Rules:
- Times in 24h local format (container TZ is set)
- Bold the event title when sending via `send_message` (use `*Title*` for WhatsApp markdown)
- Show attendee count (including you), not full attendee list — unless 3 or fewer, then list names
- Show meeting platform (Google Meet, Zoom, Teams) extracted from the conference link or location
- Show the meeting link on its own line, plain text (no markdown link syntax — WhatsApp doesn't support it)
- For all-day events, use `All day` instead of a time range
- Omit location line entirely if there's no location or meeting link
- Omit attendee line for events with only you

## Conflict Warnings

If two events overlap in time, add a conflict section after the affected day:

```
!! Conflict: 14:00–15:00 Design Review overlaps with 14:30–15:00 1:1 with Sarah
```

## Tasks Section

Group overdue tasks first, then today's tasks.

```
Tasks:
  ! Overdue: Submit expense report (due Mar 11)
  - Review PR #142 (due today)
  - Update project brief (due today)
```

## Free Time Section

Only include when the user explicitly asks about availability or free time.

```
Free slots today:
  09:00 – 10:00 (1h)
  11:00 – 14:30 (3h 30m)
  15:00 – 17:00 (2h)
```

Use `query_freebusy` to compute free slots against working hours (09:00–17:00 by default).

## Empty Calendar

If no events exist for a requested day:

```
--- Today, Thursday Mar 13 ---
No events scheduled. Calendar is clear.
```

## Notification Integration

When this skill runs as part of a scheduled task (chatJid starts with `system:`), also call `submit_notification` for each event using these priority levels:

| Condition | Priority |
|-----------|----------|
| Starts within 1 hour | `high` |
| Today, > 1 hour away | `normal` |
| Tomorrow | `low` |
| All-day / FYI | `info` |
| Scheduling conflict | `high` (category: `calendar-conflict`) |
| Overdue task | `high` (category: `task-due`) |
| Task due today | `normal` (category: `task-due`) |

Always pass a `dedup_key` to prevent duplicate notifications across runs:
- Calendar events: `calendar-event:{eventId}` (use the Google Calendar event ID)
- Calendar conflicts: `calendar-conflict:{eventId1}:{eventId2}`
- Tasks: `task-due:{taskId}`

If a pending notification with the same key already exists, the system updates it in place rather than creating a duplicate.

Payload shape for calendar events:
```json
{ "title": "...", "startTime": "ISO", "endTime": "ISO", "attendees": [...], "meetingLink": "..." }
```

Group back-to-back events (gap < 15 min) into a single notification (use the first event's ID as the dedup key).

## Tone

Lead with the schedule, not preamble. No "Here's your calendar" or "Let me check" — just the formatted output. If there are conflicts or overdue tasks, mention them first before the schedule.
