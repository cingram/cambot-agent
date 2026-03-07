import type { MessageBus } from '../types.js';
import type { WorkflowService } from './workflow-service.js';
import { WorkflowTrigger } from '../bus/events/workflow-trigger.js';
import { logger } from '../logger.js';

export interface WorkflowTriggerHandlerDeps {
  messageBus: MessageBus;
  getWorkflowService: () => WorkflowService | null;
}

export function createWorkflowTriggerHandler(deps: WorkflowTriggerHandlerDeps): { destroy: () => void } {
  const { messageBus, getWorkflowService } = deps;

  const unsubscribe = messageBus.on(
    WorkflowTrigger,
    async (event) => {
      const service = getWorkflowService();
      if (!service) {
        logger.warn({ workflowId: event.workflowId, source: event.source }, 'WorkflowTrigger received but workflow service not available');
        return;
      }

      const workflow = service.getWorkflow(event.workflowId);
      if (!workflow) {
        logger.warn({ workflowId: event.workflowId, source: event.source }, 'WorkflowTrigger for unknown workflow');
        return;
      }

      if (service.hasActiveRun(event.workflowId)) {
        logger.info({ workflowId: event.workflowId, source: event.source }, 'WorkflowTrigger skipped — active run exists');
        return;
      }

      logger.info({ workflowId: event.workflowId, source: event.source }, 'WorkflowTrigger accepted — starting workflow');
      try {
        const runId = await service.runWorkflow(event.workflowId);
        logger.info({ workflowId: event.workflowId, runId, source: event.source }, 'Workflow started via bus trigger');
      } catch (err) {
        logger.error({ err, workflowId: event.workflowId, source: event.source }, 'WorkflowTrigger failed to start workflow');
      }
    },
    {
      id: 'workflow-trigger-handler',
      priority: 50,
      source: 'workflow-trigger-handler',
      sequential: true,
    },
  );

  return {
    destroy(): void {
      unsubscribe();
      logger.debug('Workflow trigger handler destroyed');
    },
  };
}
