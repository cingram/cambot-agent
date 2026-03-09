/**
 * Basic client-side schedule format checks.
 *
 * Full validation (cron parsing, timezone resolution) happens server-side
 * in task-schedule.ts. This module only catches obviously malformed input
 * to give faster feedback before the round-trip.
 */

export interface ScheduleValidation {
  error?: string;
  resolvedValue?: string;
}

export function validateScheduleValue(
  scheduleType: string,
  scheduleValue: string,
): ScheduleValidation {
  if (scheduleType === 'cron') {
    // Basic cron format check: 5 or 6 space-separated fields
    const fields = scheduleValue.trim().split(/\s+/);
    if (fields.length < 5 || fields.length > 6) {
      return {
        error: `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
      };
    }
    return {};
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      return {
        error: `Invalid interval: "${scheduleValue}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
      };
    }
    return {};
  }

  if (scheduleType === 'once') {
    // Relative offset: +Ns, +Nm, +Nh
    const relMatch = scheduleValue.match(/^\+(\d+)(s|m|h)$/);
    if (relMatch) {
      const amount = parseInt(relMatch[1], 10);
      const unit = relMatch[2];
      const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
      const targetMs = Date.now() + amount * multiplier;
      return { resolvedValue: new Date(targetMs).toISOString() };
    }

    // Absolute timestamp: basic parsability check
    let value = scheduleValue;
    if (!/[Zz]$/.test(value) && !/[+-]\d{2}:\d{2}$/.test(value)) {
      value += 'Z';
    }
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return {
        error: `Invalid schedule value: "${scheduleValue}". Use relative like "+2m", "+1h" or absolute like "2026-02-01T15:30:00Z".`,
      };
    }
    return { resolvedValue: date.toISOString() };
  }

  return { error: `Unknown schedule type: ${scheduleType}` };
}
