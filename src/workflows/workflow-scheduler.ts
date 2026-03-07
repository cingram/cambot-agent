import { CronExpressionParser } from 'cron-parser';

import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from '../config/config.js';
import { logger } from '../logger.js';
import type { WorkflowService } from './workflow-service.js';

export interface WorkflowSchedulerDeps {
  workflowService: WorkflowService;
}

/** In-memory next-run times keyed by workflow ID. */
const nextRunTimes = new Map<string, Date>();

/** Track last-seen cron expressions to detect schedule changes. */
const lastSeenCron = new Map<string, string>();

/**
 * Scan workflow definitions and initialize (or refresh) next-run times
 * for workflows that have a cron schedule. Detects cron changes and
 * recomputes next-run times when the schedule is updated.
 */
export function syncScheduledWorkflows(deps: WorkflowSchedulerDeps): void {
  deps.workflowService.reloadDefinitions();
  const workflows = deps.workflowService.listWorkflows();

  // Remove entries for workflows that no longer exist or lost their schedule
  for (const id of nextRunTimes.keys()) {
    const wf = workflows.find(w => w.id === id);
    if (!wf || !wf.schedule?.cron) {
      nextRunTimes.delete(id);
      lastSeenCron.delete(id);
    }
  }

  for (const wf of workflows) {
    if (wf.enabled === false) continue;
    if (!wf.schedule?.cron) continue;

    // Skip if already tracked AND cron hasn't changed
    const prevCron = lastSeenCron.get(wf.id);
    if (nextRunTimes.has(wf.id) && prevCron === wf.schedule.cron) continue;

    try {
      const tz = wf.schedule.timezone || TIMEZONE;
      const interval = CronExpressionParser.parse(wf.schedule.cron, { tz });
      nextRunTimes.set(wf.id, interval.next().toDate());
      lastSeenCron.set(wf.id, wf.schedule.cron);
      logger.info(
        { workflowId: wf.id, cron: wf.schedule.cron, nextRun: nextRunTimes.get(wf.id)!.toISOString() },
        prevCron ? 'Scheduled workflow cron updated' : 'Scheduled workflow registered',
      );
    } catch (err) {
      logger.error({ workflowId: wf.id, cron: wf.schedule.cron, err }, 'Invalid cron expression');
    }
  }
}

let schedulerRunning = false;

export function startWorkflowSchedulerLoop(deps: WorkflowSchedulerDeps): void {
  if (schedulerRunning) {
    logger.debug('Workflow scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  // Initial sync
  syncScheduledWorkflows(deps);

  logger.info(
    { scheduledCount: nextRunTimes.size },
    'Workflow scheduler loop started',
  );

  const loop = async () => {
    try {
      // Re-sync in case definitions were reloaded
      syncScheduledWorkflows(deps);

      const now = new Date();

      for (const [workflowId, nextRun] of nextRunTimes) {
        if (nextRun > now) continue;

        logger.info(
          { workflowId, scheduledFor: nextRun.toISOString(), now: now.toISOString() },
          'Scheduled workflow due — processing',
        );

        const wf = deps.workflowService.getWorkflow(workflowId);
        if (!wf?.schedule?.cron) {
          logger.warn({ workflowId }, 'Scheduled workflow not found after reload — removing');
          nextRunTimes.delete(workflowId);
          continue;
        }

        try {
          const tz = wf.schedule.timezone || TIMEZONE;
          const interval = CronExpressionParser.parse(wf.schedule.cron, { tz });
          nextRunTimes.set(workflowId, interval.next().toDate());
        } catch {
          nextRunTimes.delete(workflowId);
          continue;
        }

        if (deps.workflowService.hasActiveRun(workflowId)) {
          logger.debug({ workflowId }, 'Skipping scheduled workflow — active run exists');
          continue;
        }

        logger.info({ workflowId, scheduledFor: nextRun.toISOString() }, 'Triggering scheduled workflow');

        deps.workflowService.runWorkflow(workflowId).catch(err => {
          logger.error({ workflowId, err }, 'Scheduled workflow run failed');
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error in workflow scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal — for tests only. */
export function _resetWorkflowSchedulerForTests(): void {
  schedulerRunning = false;
  nextRunTimes.clear();
  lastSeenCron.clear();
}

/** @internal — for tests only. */
export function _getNextRunTimes(): Map<string, Date> {
  return nextRunTimes;
}
