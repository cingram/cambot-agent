import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
} from '../config/config.js';
import { getLeadAgentId, resolveAgentImage } from '../agents/agents.js';
import type { IntegrationManager } from '../integrations/index.js';
import {
  ContainerOutput,
  runContainerAgent,
} from '../container/runner.js';
import {
  writeCustomAgentsSnapshot,
  writeGroupsSnapshot,
  writeArchivedTasksSnapshot,
  writeTasksSnapshot,
  writeWorkflowsSnapshot,
  writeWorkflowSchemaSnapshot,
  writeWorkersSnapshot,
} from '../container/snapshot-writers.js';
import {
  getAllAgentDefinitions,
  getAllChats,
  getAllCustomAgents,
  getAllTasks,
  getArchivedTasks,
} from '../db/index.js';
import { resolveGroupIpcPath } from '../groups/group-folder.js';
import { GroupQueue } from '../groups/group-queue.js';
import { logger } from '../logger.js';
import { toExecutionContext } from '../types.js';
import type { RegisteredGroup } from '../types.js';
import { writeContextFiles } from '../utils/context-files.js';
import type { WorkflowService } from '../workflows/workflow-service.js';
import type { WorkflowBuilderService } from '../workflows/workflow-builder-service.js';
import type { RouterState } from './router-state.js';

export interface AgentRunnerDeps {
  state: RouterState;
  queue: GroupQueue;
  getWorkflowService: () => WorkflowService | null;
  getWorkflowBuilderService: () => WorkflowBuilderService | null;
  getIntegrationManager: () => IntegrationManager | null;
}

export class AgentRunner {
  private deps: AgentRunnerDeps;

  constructor(deps: AgentRunnerDeps) {
    this.deps = deps;
  }

  cleanIpcInputDir(groupFolder: string): void {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      for (const f of fs.readdirSync(inputDir)) {
        if (f.endsWith('.json') || f === '_close') {
          try { fs.unlinkSync(path.join(inputDir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore — dir may not exist */ }
  }

  async run(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const { state, queue } = this.deps;
    const isMain = group.folder === MAIN_GROUP_FOLDER;
    let sessionId: string | undefined = state.getSession(chatJid);

    // Rotate session when transcript gets too large (>500KB)
    if (sessionId) {
      const transcriptPath = path.join(
        DATA_DIR, 'sessions', group.folder, '.claude', 'projects',
        '-workspace-group', `${sessionId}.jsonl`,
      );
      try {
        const stat = fs.statSync(transcriptPath);
        if (stat.size > 512_000) {
          logger.info(
            { group: group.name, sessionId, sizeKB: Math.round(stat.size / 1024) },
            'Session transcript too large, starting fresh session',
          );
          sessionId = undefined;
        }
      } catch {
        // File not found — session may have been cleaned up, start fresh
      }
    }

    this.writeSnapshots(group, isMain, chatJid);

    // Wrap onOutput to track session ID from streamed results
    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            state.setSession(chatJid, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const leadId = getLeadAgentId();
      const agentOpts = resolveAgentImage(leadId);
      const integrationMgr = this.deps.getIntegrationManager();

      const output = await runContainerAgent(
        toExecutionContext(group, isMain),
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          mcpServers: integrationMgr?.getActiveMcpServers(),
        },
        (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
        agentOpts,
      );

      if (output.newSessionId) {
        state.setSession(chatJid, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  private writeSnapshots(group: RegisteredGroup, isMain: boolean, chatJid: string): void {
    const { state } = this.deps;
    const workflowService = this.deps.getWorkflowService();
    const workflowBuilderService = this.deps.getWorkflowBuilderService();
    const integrationMgr = this.deps.getIntegrationManager();

    // Tasks snapshot
    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    // Archived tasks snapshot
    const archived = getArchivedTasks();
    writeArchivedTasksSnapshot(
      group.folder,
      isMain,
      archived.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
      })),
    );

    // Available groups snapshot
    const availableGroups = state.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(state.getRegisteredGroups())),
    );

    // Custom agents snapshot
    const customAgents = getAllCustomAgents();
    writeCustomAgentsSnapshot(
      group.folder,
      isMain,
      customAgents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        provider: a.provider,
        model: a.model,
        trigger_pattern: a.trigger_pattern,
        group_folder: a.group_folder,
      })),
    );

    // Workflows snapshot (per-workflow files)
    if (workflowService) {
      const workflows = workflowService.listWorkflows().map(wf => ({
        id: wf.id,
        name: wf.name,
        description: wf.description,
        version: wf.version,
        hash: wf.hash,
        schedule: wf.schedule,
        steps: wf.steps.map(s => ({ id: s.id, type: s.type, name: s.name, config: s.config, after: s.after })),
        policy: wf.policy as unknown as Record<string, unknown>,
      }));
      const runs = workflowService.listRuns(undefined, 20).map(r => ({
        runId: r.runId,
        workflowId: r.workflowId,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        error: r.error,
        totalCostUsd: r.totalCostUsd,
      }));
      writeWorkflowsSnapshot(group.folder, isMain, workflows, runs);

      if (workflowBuilderService) {
        writeWorkflowSchemaSnapshot(group.folder, workflowBuilderService.getSchema() as unknown as Record<string, unknown>);
      }
    }

    // Workers snapshot
    const allWorkers = getAllAgentDefinitions();
    writeWorkersSnapshot(group.folder, allWorkers);

    // Dynamic context files
    const groupIpcDir = resolveGroupIpcPath(group.folder);
    const activeMcpServers = integrationMgr?.getActiveMcpServers() ?? [];
    const skillsDir = path.join(process.cwd(), 'container', 'skills');
    writeContextFiles(groupIpcDir, isMain, {
      mcpServers: activeMcpServers,
      skillsDir,
      globalDir: path.join(GROUPS_DIR, 'global'),
      customAgents: customAgents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        provider: a.provider,
        model: a.model,
        trigger_pattern: a.trigger_pattern,
      })),
      tasks: tasks.map(t => ({
        id: t.id,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
      workflows: workflowService
        ? workflowService.listWorkflows().map(wf => ({
            id: wf.id,
            name: wf.name,
            schedule: wf.schedule,
          }))
        : [],
      chatJid,
      getChats: () => getAllChats(),
    });
  }
}
