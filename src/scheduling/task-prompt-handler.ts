/**
 * Task Prompt Handler — Routes TaskPrompt bus events to agents.
 *
 * When a scheduled task fires, the scheduler emits a TaskPrompt event.
 * This handler picks it up and routes it:
 *   - agent_id set → spawns the named persistent agent
 *   - no agent_id  → runs the default container pipeline
 *
 * After execution, logs the run and calculates the next fire time.
 */
import { CronExpressionParser } from 'cron-parser';

import type { AgentRepository } from '../db/agent-repository.js';
import type { ContainerSpawner } from '../agents/persistent-agent-spawner.js';
import type { MessageBus, ScheduledTask } from '../types.js';
import { TaskPrompt } from '../bus/events/task-prompt.js';
import { logger } from '../logger.js';
import {
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from '../db/index.js';
import { TIMEZONE } from '../config/config.js';

export interface DefaultPipelineResult {
  result: string | null;
  error: string | null;
}

export interface TaskPromptHandlerDeps {
  messageBus: MessageBus;
  getAgentRepo: () => AgentRepository | null;
  getSpawner: () => ContainerSpawner | null;
  runDefaultPipeline: (task: ScheduledTask) => Promise<DefaultPipelineResult>;
}

export interface TaskPromptHandler {
  destroy(): void;
}

export function createTaskPromptHandler(deps: TaskPromptHandlerDeps): TaskPromptHandler {
  const { messageBus } = deps;

  const unsubscribe = messageBus.on(
    TaskPrompt,
    async (event) => {
      const startTime = Date.now();
      const task = getTaskById(event.taskId);
      if (!task) {
        logger.warn({ taskId: event.taskId }, 'TaskPrompt received for unknown task');
        return;
      }

      let result: string | null = null;
      let error: string | null = null;

      const agentRepo = deps.getAgentRepo();
      const spawner = deps.getSpawner();

      if (event.agentId && agentRepo && spawner) {
        const agent = agentRepo.getById(event.agentId);
        if (!agent) {
          error = `Agent "${event.agentId}" not found`;
          logger.error({ agentId: event.agentId, taskId: event.taskId }, error);
        } else {
          try {
            logger.info(
              { taskId: event.taskId, agentId: agent.id },
              'Routing task to persistent agent',
            );
            const execResult = await spawner.spawn(
              agent,
              event.prompt,
              event.jid,
              agent.timeoutMs,
            );
            if (execResult.status === 'success') {
              result = execResult.content;
            } else {
              error = execResult.content;
            }
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            logger.error({ taskId: event.taskId, agentId: agent.id, err }, 'Agent-targeted task failed');
          }
        }
      } else {
        const pipelineResult = await deps.runDefaultPipeline(task);
        result = pipelineResult.result;
        error = pipelineResult.error;
      }

      const durationMs = Date.now() - startTime;

      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: error ? 'error' : 'success',
        result,
        error,
      });

      let nextRun: string | null = null;
      if (task.schedule_type === 'cron') {
        const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
        nextRun = interval.next().toISOString();
      } else if (task.schedule_type === 'interval') {
        const ms = parseInt(task.schedule_value, 10);
        nextRun = new Date(Date.now() + ms).toISOString();
      }

      const resultSummary = error
        ? `Error: ${error}`
        : result
          ? result.slice(0, 200)
          : 'Completed';
      updateTaskAfterRun(task.id, nextRun, resultSummary);

      logger.info(
        { taskId: task.id, durationMs, hasAgent: !!event.agentId },
        'Task completed',
      );
    },
    {
      id: 'task-prompt-handler',
      priority: 50,
      source: 'task-scheduler',
      sequential: true,
    },
  );

  return {
    destroy(): void {
      unsubscribe();
    },
  };
}
