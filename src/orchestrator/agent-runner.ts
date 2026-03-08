import { MAIN_GROUP_FOLDER } from '../config/config.js';
import { getLeadAgentId, resolveAgentImage } from '../agents/agents.js';
import type { IntegrationManager } from '../integrations/index.js';
import {
  ContainerOutput,
  runContainerAgent,
} from '../container/runner.js';
import {
  writeGroupsSnapshot,
  writeArchivedTasksSnapshot,
  writeTasksSnapshot,
  writeWorkflowsSnapshot,
  writeWorkflowSchemaSnapshot,
  writeWorkersSnapshot,
  writePersistentAgentsSnapshot,
} from '../container/snapshot-writers.js';
import {
  getAllAgentDefinitions,
  getAllChats,
  getAllTasks,
  getArchivedTasks,
  getDatabase,
} from '../db/index.js';
import { createAgentRepository } from '../db/agent-repository.js';
import { createAgentTemplateRepository } from '../db/agent-template-repository.js';
import { GroupQueue } from '../groups/group-queue.js';
import { logger } from '../logger.js';
import { toExecutionContext } from '../types.js';
import type { RegisteredGroup } from '../types.js';
import { resolveToolList } from '../tools/tool-policy.js';
import { channelFromJid } from '../utils/channel-from-jid.js';
import { buildAgentContext, type ContextFileDeps } from '../utils/context-files.js';
import { resolveActiveConversation, setConversationSession, updatePreview } from '../db/conversation-repository.js';
import type { WorkflowService } from '../workflows/workflow-service.js';
import type { WorkflowBuilderService } from '../workflows/workflow-builder-service.js';
import type { RouterState } from './router-state.js';
import type { CambotSocketServer } from '../cambot-socket/server.js';

export interface AgentRunnerDeps {
  state: RouterState;
  queue: GroupQueue;
  getWorkflowService: () => WorkflowService | null;
  getWorkflowBuilderService: () => WorkflowBuilderService | null;
  getIntegrationManager: () => IntegrationManager | null;
  getSocketServer?: () => CambotSocketServer | undefined;
  getRegisteredAgents?: () => Array<{
    id: string;
    name: string;
    description: string;
    channels: string[];
    capabilities: string[];
  }>;
}

export class AgentRunner {
  private deps: AgentRunnerDeps;
  private agentRepo: ReturnType<typeof createAgentRepository>;
  private templateRepo: ReturnType<typeof createAgentTemplateRepository>;

  constructor(deps: AgentRunnerDeps) {
    this.deps = deps;
    const db = getDatabase();
    this.agentRepo = createAgentRepository(db);
    this.templateRepo = createAgentTemplateRepository(db);
  }

  /** No-op: IPC input directory cleanup is no longer needed with socket transport. */
  cleanIpcInputDir(_groupFolder: string): void {
    // Socket-based transport has no file-based input directory to clean.
  }

  async run(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const { queue } = this.deps;
    const isMain = group.folder === MAIN_GROUP_FOLDER;

    // Resolve active conversation — handles auto-rotation (idle + size)
    const channel = channelFromJid(chatJid);
    const conversation = resolveActiveConversation(group.folder, channel, chatJid);
    const sessionId = conversation.sessionId ?? undefined;

    const snapshot = this.fetchSnapshot(group.folder);
    const agentContext = this.buildContext(snapshot, isMain, chatJid);
    this.writeSnapshots(group, isMain, snapshot);

    // Wrap onOutput to track session ID from streamed results
    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            setConversationSession(conversation.id, output.newSessionId);
          }
          if (output.result) {
            updatePreview(conversation.id, output.result);
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
          allowedSdkTools: resolveToolList(group.containerConfig?.toolPolicy),
          agentContext,
        },
        (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
        agentOpts,
        this.deps.getSocketServer?.(),
      );

      if (output.newSessionId) {
        setConversationSession(conversation.id, output.newSessionId);
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

  /** Fetch all data needed by both context files and snapshots — single pass. */
  private fetchSnapshot(folder: string) {
    const workflowService = this.deps.getWorkflowService();
    const integrationMgr = this.deps.getIntegrationManager();
    const agent = this.agentRepo.getByFolder(folder);

    return {
      tasks: getAllTasks(),
      agents: this.agentRepo.getAll(),
      workflows: workflowService?.listWorkflows() ?? [],
      mcpServers: integrationMgr?.getActiveMcpServers() ?? [],
      agentIdentity: agent?.systemPrompt ?? this.templateRepo.get('identity'),
      agentSoul: agent?.soul ?? this.templateRepo.get('soul'),
    };
  }

  /** Build the agent context for injection into ContainerInput. */
  private buildContext(
    snapshot: ReturnType<AgentRunner['fetchSnapshot']>,
    isMain: boolean,
    chatJid: string,
  ): ContextFileDeps {
    return buildAgentContext({
      mcpServers: snapshot.mcpServers,
      agentIdentity: snapshot.agentIdentity,
      agentSoul: snapshot.agentSoul,
      agents: snapshot.agents.map(a => ({
        id: a.id, name: a.name, description: a.description, provider: a.provider, model: a.model,
      })),
      tasks: snapshot.tasks.map(t => ({
        id: t.id, prompt: t.prompt, schedule_type: t.schedule_type,
        schedule_value: t.schedule_value, status: t.status, next_run: t.next_run,
      })),
      workflows: snapshot.workflows.map(wf => ({
        id: wf.id, name: wf.name, schedule: wf.schedule,
      })),
      chatJid,
      getChats: () => getAllChats(),
    });
  }

  private writeSnapshots(
    group: RegisteredGroup,
    isMain: boolean,
    snapshot: ReturnType<AgentRunner['fetchSnapshot']>,
  ): void {
    const { state } = this.deps;
    const workflowBuilderService = this.deps.getWorkflowBuilderService();

    writeTasksSnapshot(
      group.folder, isMain,
      snapshot.tasks.map(t => ({
        id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
        schedule_type: t.schedule_type, schedule_value: t.schedule_value,
        status: t.status, next_run: t.next_run, agentId: t.agent_id,
      })),
    );

    const archived = getArchivedTasks();
    writeArchivedTasksSnapshot(
      group.folder, isMain,
      archived.map(t => ({
        id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
        schedule_type: t.schedule_type, schedule_value: t.schedule_value, status: t.status,
      })),
    );

    const availableGroups = state.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder, isMain, availableGroups,
      new Set(Object.keys(state.getRegisteredGroups())),
    );

    if (snapshot.workflows.length > 0) {
      const workflowService = this.deps.getWorkflowService()!;
      const workflows = snapshot.workflows.map(wf => ({
        id: wf.id, name: wf.name, description: wf.description,
        version: wf.version, hash: wf.hash, schedule: wf.schedule,
        steps: wf.steps.map(s => ({ id: s.id, type: s.type, name: s.name, config: s.config, after: s.after })),
        policy: wf.policy as unknown as Record<string, unknown>,
      }));
      const runs = workflowService.listRuns(undefined, 20).map(r => ({
        runId: r.runId, workflowId: r.workflowId, status: r.status,
        startedAt: r.startedAt, completedAt: r.completedAt,
        error: r.error, totalCostUsd: r.totalCostUsd,
      }));
      writeWorkflowsSnapshot(group.folder, isMain, workflows, runs);

      if (workflowBuilderService) {
        writeWorkflowSchemaSnapshot(group.folder, workflowBuilderService.getSchema() as unknown as Record<string, unknown>);
      }
    }

    writeWorkersSnapshot(group.folder, getAllAgentDefinitions());

    const registeredAgents = this.deps.getRegisteredAgents?.() ?? [];
    writePersistentAgentsSnapshot(group.folder, registeredAgents);
  }
}
