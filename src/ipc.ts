import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { MessageBus, RegisteredGroup } from './types.js';
import type { WorkflowService } from './workflow-service.js';
import type { CustomAgentService } from './custom-agent-service.js';

export interface IpcDeps {
  messageBus: MessageBus;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  /** Workflow engine service. When present, workflow IPC commands are handled. */
  workflowService?: WorkflowService;
  /** Custom agent service. When present, custom agent IPC commands are handled. */
  customAgentService?: CustomAgentService;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.messageBus.emitAsync({
                    type: 'message.outbound',
                    source: 'ipc',
                    timestamp: new Date().toISOString(),
                    data: { jid: data.chatJid, text: data.text, source: 'ipc', groupFolder: sourceGroup },
                  });
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For workflow commands
    workflowId?: string;
    runId?: string;
    // For custom agent commands
    agent?: Record<string, unknown>;
    agentId?: string;
    updates?: Record<string, unknown>;
    cleanupMemory?: boolean;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          // Support relative offsets as a safety net (MCP server should have
          // already normalized, but handle it here too for robustness)
          const relMatch = (data.schedule_value as string).match(/^\+(\d+)(s|m|h)$/);
          if (relMatch) {
            const amount = parseInt(relMatch[1], 10);
            const unit = relMatch[2];
            const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
            nextRun = new Date(Date.now() + amount * multiplier).toISOString();
          } else {
            // Treat bare timestamps (no Z or offset) as UTC — matches how
            // Claude calculates times and how the MCP server normalizes
            let value = data.schedule_value as string;
            if (!/[Zz]$/.test(value) && !/[+-]\d{2}:\d{2}$/.test(value)) {
              value += 'Z';
            }
            const scheduled = new Date(value);
            if (isNaN(scheduled.getTime())) {
              logger.warn(
                { scheduleValue: data.schedule_value },
                'Invalid timestamp',
              );
              break;
            }
            nextRun = scheduled.toISOString();
          }
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'run_workflow':
      if (!deps.workflowService) {
        logger.warn('run_workflow IPC received but workflow service not initialized');
        break;
      }
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized run_workflow attempt blocked (main only)');
        break;
      }
      if (data.workflowId) {
        try {
          const runId = await deps.workflowService.runWorkflow(data.workflowId);
          logger.info({ workflowId: data.workflowId, runId, sourceGroup }, 'Workflow started via IPC');
          if (data.chatJid) {
            await deps.messageBus.emitAsync({
              type: 'message.outbound',
              source: 'ipc',
              timestamp: new Date().toISOString(),
              data: {
                jid: data.chatJid,
                text: `Workflow "${data.workflowId}" started (run: ${runId})`,
                source: 'workflow',
                groupFolder: sourceGroup,
              },
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ workflowId: data.workflowId, err }, 'Workflow run failed');
          if (data.chatJid) {
            await deps.messageBus.emitAsync({
              type: 'message.outbound',
              source: 'ipc',
              timestamp: new Date().toISOString(),
              data: {
                jid: data.chatJid,
                text: `Workflow "${data.workflowId}" failed: ${msg}`,
                source: 'workflow',
                groupFolder: sourceGroup,
              },
            });
          }
        }
      }
      break;

    case 'pause_workflow':
      if (!deps.workflowService) {
        logger.warn('pause_workflow IPC received but workflow service not initialized');
        break;
      }
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized pause_workflow attempt blocked (main only)');
        break;
      }
      if (data.runId) {
        try {
          deps.workflowService.pauseRun(data.runId);
          logger.info({ runId: data.runId, sourceGroup }, 'Workflow paused via IPC');
        } catch (err) {
          logger.error({ runId: data.runId, err }, 'Workflow pause failed');
        }
      }
      break;

    case 'cancel_workflow':
      if (!deps.workflowService) {
        logger.warn('cancel_workflow IPC received but workflow service not initialized');
        break;
      }
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized cancel_workflow attempt blocked (main only)');
        break;
      }
      if (data.runId) {
        try {
          deps.workflowService.cancelRun(data.runId);
          logger.info({ runId: data.runId, sourceGroup }, 'Workflow cancelled via IPC');
        } catch (err) {
          logger.error({ runId: data.runId, err }, 'Workflow cancel failed');
        }
      }
      break;

    case 'create_custom_agent':
      if (!deps.customAgentService) {
        logger.warn('create_custom_agent IPC received but custom agent service not initialized');
        break;
      }
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized create_custom_agent attempt blocked (main only)');
        break;
      }
      if (data.agent) {
        try {
          deps.customAgentService.createAgent(data.agent as unknown as Parameters<typeof deps.customAgentService.createAgent>[0]);
          logger.info({ agentId: (data.agent as { id: string }).id, sourceGroup }, 'Custom agent created via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to create custom agent');
        }
      }
      break;

    case 'update_custom_agent':
      if (!deps.customAgentService) {
        logger.warn('update_custom_agent IPC received but custom agent service not initialized');
        break;
      }
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized update_custom_agent attempt blocked (main only)');
        break;
      }
      if (data.agentId && data.updates) {
        try {
          deps.customAgentService.updateAgent(data.agentId, data.updates as Parameters<typeof deps.customAgentService.updateAgent>[1]);
          logger.info({ agentId: data.agentId, sourceGroup }, 'Custom agent updated via IPC');
        } catch (err) {
          logger.error({ agentId: data.agentId, err }, 'Failed to update custom agent');
        }
      }
      break;

    case 'delete_custom_agent':
      if (!deps.customAgentService) {
        logger.warn('delete_custom_agent IPC received but custom agent service not initialized');
        break;
      }
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized delete_custom_agent attempt blocked (main only)');
        break;
      }
      if (data.agentId) {
        try {
          deps.customAgentService.deleteAgent(data.agentId);
          logger.info({ agentId: data.agentId, sourceGroup }, 'Custom agent deleted via IPC');
        } catch (err) {
          logger.error({ agentId: data.agentId, err }, 'Failed to delete custom agent');
        }
      }
      break;

    case 'invoke_custom_agent':
      if (!deps.customAgentService) {
        logger.warn('invoke_custom_agent IPC received but custom agent service not initialized');
        break;
      }
      if (data.agentId && data.prompt) {
        // Authorization: verify the agent belongs to this group or invoker is main
        const agentDef = deps.customAgentService.getAgent(data.agentId);
        if (!agentDef) {
          logger.warn({ agentId: data.agentId }, 'invoke_custom_agent: agent not found');
          break;
        }
        if (!isMain && agentDef.group_folder !== sourceGroup) {
          logger.warn({ agentId: data.agentId, sourceGroup }, 'Unauthorized invoke_custom_agent attempt blocked');
          break;
        }
        const targetJid = data.chatJid || data.targetJid || '';
        const targetGroup = data.groupFolder || sourceGroup;

        // Fire and forget — the agent runs asynchronously and sends results via IPC
        deps.customAgentService.invokeAgent(
          data.agentId,
          data.prompt as string,
          targetJid as string,
          targetGroup as string,
          isMain,
        ).catch((err) => {
          logger.error({ agentId: data.agentId, err }, 'Custom agent invocation failed');
          // Notify the user of the failure
          const errorText = `Custom agent invocation failed: ${err instanceof Error ? err.message : String(err)}`;
          if (targetJid) {
            deps.messageBus.emitAsync({
              type: 'message.outbound',
              source: 'ipc',
              timestamp: new Date().toISOString(),
              data: { jid: targetJid, text: errorText, source: 'custom-agent', groupFolder: targetGroup },
            }).catch(() => {});
          }
        });
        logger.info({ agentId: data.agentId, sourceGroup }, 'Custom agent invocation dispatched');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
