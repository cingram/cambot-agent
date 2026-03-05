import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
} from '../config/config.js';
import { AgentOptions } from '../agents/agents.js';
import type { AvailableGroup } from '../container/snapshot-writers.js';
import { logger } from '../logger.js';
import { MessageBus, RegisteredGroup, WorkerDefinition } from '../types.js';
import type { WorkflowService } from '../workflows/workflow-service.js';
import type { WorkflowBuilderService } from '../workflows/workflow-builder-service.js';
import type { CustomAgentService } from '../agents/custom-agent-service.js';
import type { IntegrationManager } from '../integrations/types.js';
import { processMessageFiles } from './message-handler.js';
import { processTaskIpc } from './task-handler.js';

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
  /** Workflow builder service. When present, workflow CRUD IPC commands are handled. */
  workflowBuilderService?: WorkflowBuilderService;
  /** Custom agent service. When present, custom agent IPC commands are handled. */
  customAgentService?: CustomAgentService;
  resolveAgentImage: (agentId: string) => AgentOptions;
  getAgentDefinition: (id: string) => WorkerDefinition | undefined;
  /** Integration manager. When present, integration IPC commands are handled. */
  integrationManager?: IntegrationManager;
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
        await processMessageFiles(
          messagesDir,
          ipcBaseDir,
          sourceGroup,
          isMain,
          registeredGroups,
          deps,
        );
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
