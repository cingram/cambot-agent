import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ADMIN_JID,
  ADMIN_TRIGGER,
  ASSISTANT_NAME,
  CAMBOT_SOCKET_PORT,
  CONTENT_PIPE_BLOCK_CRITICAL,
  CONTENT_PIPE_ENABLED,
  CONTENT_PIPE_MODEL,
  CONTENT_PIPE_RAW_TTL_DAYS,
  CONTENT_PIPE_UNTRUSTED_CHANNELS,
  CONTEXT_TOKEN_BUDGET,
  DATA_DIR,
  EMAIL_LOOP_THRESHOLD,
  EMAIL_RATE_PER_DAY,
  EMAIL_RATE_PER_HOUR,
  EMAIL_RATE_PER_MINUTE,
  STORE_DIR,
  WORKFLOW_CONTAINER_TIMEOUT,
  WORKSPACE_MCP_PORT,
} from '../config/config.js';
import { getLeadAgentId, loadAgentsConfig, resolveAgentImage } from '../agents/agents.js';
import { buildIntegrationDefinitions, createIntegrationManager } from '../integrations/index.js';
import type { IntegrationManager } from '../integrations/index.js';
import {
  runContainerAgent,
  type ContainerOutput,
} from '../container/runner.js';
import { writeGroupsSnapshot } from '../container/snapshot-writers.js';
import { cleanupStaleContainers, ensureContainerRuntimeRunning, cleanupOrphans, stopContainersForGroup, stopContainer } from '../container/runtime.js';
import {
  getAgentDefinition,
  getAllChats,
  getAllTasks,
  getDatabase,
  initDatabase,
} from '../db/index.js';
import { GroupQueue } from '../groups/group-queue.js';
import { startSchedulerLoop } from '../scheduling/task-scheduler.js';
import { createTaskPromptHandler, type TaskPromptHandler } from '../scheduling/task-prompt-handler.js';
import { runDefaultTaskPipeline } from '../scheduling/default-task-pipeline.js';
import { startWorkflowSchedulerLoop } from '../workflows/workflow-scheduler.js';
import {
  Channel,
  ExecutionContext,
} from '../types.js';
import type { MessageBus } from '../types.js';
import { createAppBus, type AppBus } from '../bus/index.js';
import { logger } from '../logger.js';
import { createShadowAgent } from '../agents/shadow-agent.js';
import { createWorkflowService, type WorkflowService, type AgentStepInput, type AgentContainerResult } from '../workflows/workflow-service.js';
import { createWorkflowBuilderService, type WorkflowBuilderService } from '../workflows/workflow-builder-service.js';
import { createCamBotCore, createStandaloneConfig } from 'cambot-core';
import { createLifecycleInterceptor, type LifecycleInterceptor } from '../utils/lifecycle-interceptor.js';
import { readEnvFile } from '../config/env.js';

import { RouterState } from './router-state.js';
import { BusHandlerRegistry } from './bus-handlers.js';
import { AgentRunner } from './agent-runner.js';
import { GroupMessageProcessor } from './group-message-processor.js';
import { registerMessageRouter } from './message-router.js';
import { recoverPendingMessages } from './message-recovery.js';
import { deleteConversationsByFolder } from '../db/conversation-repository.js';
import { createAuditEmitter, type AuditEmitter } from '../audit/index.js';
import { createInputSanitizer, createInjectionDetector } from 'cambot-core';
import { createSummarizer } from '../pipes/summarizer.js';
import { createEmailPipe } from '../pipes/email-pipe.js';
import { registerContentPipeHandler } from '../pipes/content-pipe-handler.js';
import { createRawContentRepository, type RawContentRepository } from '../db/raw-content-repository.js';
import type { ContentPipe } from '../pipes/content-pipe.js';
import { createAgentRepository, type AgentRepository } from '../db/agent-repository.js';
import { createAgentTemplateRepository } from '../db/agent-template-repository.js';
import { createPersistentAgentSpawner } from '../agents/persistent-agent-spawner.js';
import { createGatewayRouterFromEnv } from '../agents/gateway-router.js';
import { buildAgentContext } from '../utils/context-files.js';
import { createPersistentAgentHandler, type PersistentAgentHandler } from '../agents/persistent-agent-handler.js';
import { provisionAgent } from '../agents/agent-factory.js';
import { createWorkflowTriggerHandler } from '../workflows/workflow-trigger-handler.js';
import { createWorkflowAgentHandler } from '../workflows/workflow-agent-handler.js';
import { GROUPS_DIR } from '../config/config.js';

// cambot-socket imports
import { CambotSocketServer, CommandRegistry, registerAllHandlers } from '../cambot-socket/index.js';
import type { SocketDeps } from '../cambot-socket/index.js';

export class CamBotApp {
  private state = new RouterState();
  private queue = new GroupQueue();
  private channels: Channel[] = [];
  private bus!: MessageBus;
  private appBus: AppBus | null = null;
  private workflowService: WorkflowService | null = null;
  private workflowBuilderService: WorkflowBuilderService | null = null;
  private interceptor: LifecycleInterceptor | null = null;
  private integrationMgr: IntegrationManager | null = null;
  private busHandlers!: BusHandlerRegistry;
  private auditEmitter: AuditEmitter | null = null;
  private rawContentStore: RawContentRepository | null = null;
  private contentPipeUnsub: (() => void) | null = null;
  private contentPipe: ContentPipe | null = null;
  private persistentAgentHandler: PersistentAgentHandler | null = null;
  private taskPromptHandler: TaskPromptHandler | null = null;
  private workflowTriggerHandler: { destroy: () => void } | null = null;
  private workflowAgentHandler: { destroy: () => void } | null = null;
  private agentSpawner: import('../agents/persistent-agent-spawner.js').ContainerSpawner | null = null;
  private agentRepo: AgentRepository | null = null;
  private socketServer: CambotSocketServer | null = null;

  async start(): Promise<void> {
    this.installProcessHandlers();
    this.initInfra();
    this.initDatabase();
    this.state.load();
    loadAgentsConfig();
    this.initLifecycleInterceptor();

    this.appBus = createAppBus({
      db: getDatabase(),
      outboundGuard: {
        channelLimits: {
          email: {
            perMinute: EMAIL_RATE_PER_MINUTE,
            perHour: EMAIL_RATE_PER_HOUR,
            perDay: EMAIL_RATE_PER_DAY,
          },
        },
        loopThreshold: EMAIL_LOOP_THRESHOLD,
      },
    });
    this.bus = this.appBus.bus;
    this.initWorkflowService();
    this.workflowTriggerHandler = createWorkflowTriggerHandler({
      messageBus: this.bus,
      getWorkflowService: () => this.workflowService,
    });
    await this.initWorkflowBuilderService();
    this.busHandlers = new BusHandlerRegistry({
      bus: this.bus,
      getChannels: () => this.channels,
      getIntegrationManager: () => this.integrationMgr,
      getInterceptor: () => this.interceptor,
      auditEmitter: this.auditEmitter ?? undefined,
    });
    this.busHandlers.register();
    this.initContentPipe();

    this.installShutdownHandlers();
    await this.initIntegrations();
    this.initShadowAgent();
    this.initPersistentAgents();

    // Start the cambot-socket TCP server
    await this.initSocketServer();

    this.startSubsystems();

    // Build message pipeline
    const agentRunner = new AgentRunner({
      state: this.state,
      queue: this.queue,
      getWorkflowService: () => this.workflowService,
      getWorkflowBuilderService: () => this.workflowBuilderService,
      getIntegrationManager: () => this.integrationMgr,
      getSocketServer: () => this.socketServer ?? undefined,
      getRegisteredAgents: () => this.agentRepo?.getAll().map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        channels: a.channels,
        capabilities: a.capabilities,
      })) ?? [],
    });

    const processor = new GroupMessageProcessor({
      state: this.state,
      queue: this.queue,
      bus: this.bus,
      getChannels: () => this.channels,
      getInterceptor: () => this.interceptor,
      agentRunner,
    });

    this.queue.setProcessMessagesFn(processor.process.bind(processor));

    recoverPendingMessages(this.state, this.queue);

    registerMessageRouter({
      bus: this.bus,
      state: this.state,
      queue: this.queue,
      getChannels: () => this.channels,
      getInterceptor: () => this.interceptor,
      socketServer: this.socketServer ?? undefined,
    });

    this.startStaleCleanup();

    logger.info(`CamBot-Agent running (trigger: @${ASSISTANT_NAME})`);
  }

  private installProcessHandlers(): void {
    process.on('unhandledRejection', (reason) => {
      logger.fatal({ err: reason }, 'Unhandled rejection');
    });
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception');
    });
    process.on('beforeExit', (code) => {
      logger.debug({ code }, 'beforeExit');
    });
    process.on('exit', (code) => {
      logger.debug({ code }, 'exit');
    });
    process.on('SIGTERM', () => logger.info('SIGTERM received'));
    process.on('SIGINT', () => logger.info('SIGINT received'));
  }

  private initInfra(): void {
    ensureContainerRuntimeRunning();
    cleanupOrphans();
  }

  private initDatabase(): void {
    initDatabase();
    logger.info('Database initialized');
  }

  private initLifecycleInterceptor(): void {
    try {
      const coreEnv = readEnvFile(['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CAMBOT_DB_PATH']);
      const coreConfig = createStandaloneConfig({
        dbPath: coreEnv.CAMBOT_DB_PATH || process.env.CAMBOT_DB_PATH || path.join(STORE_DIR, 'cambot-core.sqlite'),
        geminiApiKey: coreEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
        anthropicApiKey: coreEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
        piiRedactionTags: [],
        contextTokenBudget: CONTEXT_TOKEN_BUDGET,
      });
      const core = createCamBotCore(coreConfig);
      this.auditEmitter = createAuditEmitter({
        securityEventStore: core.securityEventStore,
        db: core.db,
        logger,
      });

      this.interceptor = createLifecycleInterceptor(core, logger, this.auditEmitter);
      this.interceptor.startPeriodicTasks();

      logger.info('Lifecycle interceptor initialized');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize lifecycle interceptor, running without memory');
    }
  }

  private initWorkflowService(): void {
    const workflowExecution: ExecutionContext = {
      name: 'Workflow Agent',
      folder: 'workflows',
      isMain: true,
      containerConfig: { timeout: WORKFLOW_CONTAINER_TIMEOUT },
    };

    let workflowContainerLock = Promise.resolve<unknown>(undefined);

    this.workflowService = createWorkflowService({
      db: getDatabase(),
      messageBus: this.bus,
      getChannels: () => this.channels,
      adminJid: ADMIN_JID,
      agentRepo: { getById: (id: string) => this.agentRepo?.getById(id) },
      onStepCost: (cost) => {
        this.interceptor?.recordStepCost(cost);
      },
      runAgentContainer: (input: AgentStepInput): Promise<AgentContainerResult> => {
        const run = async (): Promise<AgentContainerResult> => {
          let resolveResult: (value: AgentContainerResult) => void;
          let rejectResult: (err: Error) => void;
          const resultPromise = new Promise<AgentContainerResult>((res, rej) => {
            resolveResult = res;
            rejectResult = rej;
          });
          let gotStreamedOutput = false;
          let spawnedContainerName: string | null = null;

          const workflowAgentOpts = resolveAgentImage(getLeadAgentId());
          if (input.customAgent?.apiKeyEnvVar &&
              !workflowAgentOpts.secretKeys.includes(input.customAgent.apiKeyEnvVar)) {
            workflowAgentOpts.secretKeys = [
              ...workflowAgentOpts.secretKeys,
              input.customAgent.apiKeyEnvVar,
            ];
          }

          const containerPromise = runContainerAgent(
            workflowExecution,
            {
              prompt: input.prompt,
              groupFolder: workflowExecution.folder,
              chatJid: 'workflows',
              isMain: true,
              customAgent: input.customAgent,
              mcpServers: this.integrationMgr?.getActiveMcpServers(),
            },
            (_proc, containerName) => {
              spawnedContainerName = containerName;
              logger.debug({ containerName }, 'Workflow container spawned');
            },
            async (output: ContainerOutput) => {
              if (gotStreamedOutput) return;
              gotStreamedOutput = true;
              if (output.telemetry && this.interceptor) {
                this.interceptor.recordTelemetry(output.telemetry, 'workflows');
              }
              if (output.status === 'error') {
                if (!output.telemetry && this.interceptor) {
                  this.interceptor.recordContainerError(
                    `Workflow container failed: ${output.error || 'unknown error'}`,
                    0,
                    'workflows',
                  );
                }
                rejectResult!(new Error(`Workflow container failed: ${output.error || 'unknown error'}`));
              } else {
                const modelUsage = output.telemetry?.modelUsage
                  ? Object.fromEntries(
                      Object.entries(output.telemetry.modelUsage).map(([model, u]) => [
                        model,
                        { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUSD },
                      ]),
                    )
                  : undefined;
                resolveResult!({
                  text: output.result || '',
                  totalCostUsd: output.telemetry?.totalCostUsd,
                  tokensIn: output.telemetry?.usage.inputTokens,
                  tokensOut: output.telemetry?.usage.outputTokens,
                  modelUsage,
                });
              }
              if (spawnedContainerName) {
                const name = spawnedContainerName;
                exec(stopContainer(name), { timeout: 15_000 }, (err) => {
                  if (err) logger.debug({ containerName: name, err }, 'Workflow container stop (may already be exiting)');
                });
              }
            },
            workflowAgentOpts,
            this.socketServer ?? undefined,
          );

          containerPromise.then((output) => {
            if (!gotStreamedOutput) {
              if (output.telemetry && this.interceptor) {
                this.interceptor.recordTelemetry(output.telemetry, 'workflows');
              }
              if (output.status === 'error') {
                if (!output.telemetry && this.interceptor) {
                  this.interceptor.recordContainerError(
                    `Workflow container failed: ${output.error || 'unknown error'}`,
                    0,
                    'workflows',
                  );
                }
                rejectResult!(new Error(`Workflow container failed: ${output.error || 'unknown error'}`));
              } else {
                const fallbackModelUsage = output.telemetry?.modelUsage
                  ? Object.fromEntries(
                      Object.entries(output.telemetry.modelUsage).map(([model, u]) => [
                        model,
                        { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUSD },
                      ]),
                    )
                  : undefined;
                resolveResult!({
                  text: output.result || '',
                  totalCostUsd: output.telemetry?.totalCostUsd,
                  tokensIn: output.telemetry?.usage.inputTokens,
                  tokensOut: output.telemetry?.usage.outputTokens,
                  modelUsage: fallbackModelUsage,
                });
              }
            }
          }).catch((err) => {
            if (!gotStreamedOutput) {
              rejectResult!(err instanceof Error ? err : new Error(String(err)));
            }
          });

          return resultPromise;
        };

        const queued = workflowContainerLock.then(run, run);
        workflowContainerLock = queued.catch(() => {});
        return queued;
      },
    });
    this.workflowService.reloadDefinitions();
  }

  private async initWorkflowBuilderService(): Promise<void> {
    const { createDefaultToolRegistry } = await import('cambot-workflows');
    const toolRegistry = createDefaultToolRegistry();
    this.workflowBuilderService = createWorkflowBuilderService({
      workflowsDir: path.join(DATA_DIR, 'workflows'),
      workflowService: this.workflowService!,
      toolRegistry,
    });
  }

  private initContentPipe(): void {
    if (!CONTENT_PIPE_ENABLED) {
      logger.info('Content pipe disabled (CONTENT_PIPE_ENABLED=false)');
      return;
    }

    const apiKey = readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY
      || process.env.ANTHROPIC_API_KEY || '';

    if (!apiKey) {
      logger.warn('Content pipe disabled: no ANTHROPIC_API_KEY available for summarizer');
      return;
    }

    const summarizer = createSummarizer({ apiKey, model: CONTENT_PIPE_MODEL });
    this.contentPipe = createEmailPipe({
      summarizer,
      injectionDetector: createInjectionDetector(),
      inputSanitizer: createInputSanitizer(),
    });

    this.rawContentStore = createRawContentRepository(
      getDatabase(),
      CONTENT_PIPE_RAW_TTL_DAYS,
    );

    this.contentPipeUnsub = registerContentPipeHandler({
      bus: this.bus,
      pipe: this.contentPipe,
      rawContentStore: this.rawContentStore,
      untrustedChannels: CONTENT_PIPE_UNTRUSTED_CHANNELS,
      blockOnCritical: CONTENT_PIPE_BLOCK_CRITICAL,
    });

    const cleaned = this.rawContentStore.cleanupExpired();
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up expired raw content');
    }

    logger.info(
      { channels: [...CONTENT_PIPE_UNTRUSTED_CHANNELS], model: CONTENT_PIPE_MODEL },
      'Content pipe initialized',
    );
  }

  private installShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      if (this.interceptor) await this.interceptor.close();
      if (this.taskPromptHandler) this.taskPromptHandler.destroy();
      if (this.persistentAgentHandler) this.persistentAgentHandler.destroy();
      if (this.workflowTriggerHandler) this.workflowTriggerHandler.destroy();
      if (this.workflowAgentHandler) this.workflowAgentHandler.destroy();
      if (this.socketServer) await this.socketServer.shutdown();
      if (this.appBus) await this.appBus.shutdown();
      await this.queue.shutdown(10000);
      if (this.integrationMgr) await this.integrationMgr.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  private async initIntegrations(): Promise<void> {
    const auditEmitter = this.auditEmitter;
    const channelOpts = {
      registeredGroups: () => this.state.getRegisteredGroups(),
      registerGroup: (jid: string, group: import('../types.js').RegisteredGroup) => this.state.registerGroup(jid, group),
      messageBus: this.bus,
      workflowService: this.workflowService ?? undefined,
      channelNames: () => this.channels.map(ch => ch.name),
      onAuditEvent: auditEmitter
        ? (event: { type: string; channel: string; data: Record<string, unknown> }) => {
            this.routeAuditEvent(event);
          }
        : undefined,
      onAgentMutation: (deletedFolder: string | undefined) => this.handleAgentMutation(deletedFolder),
    };

    this.integrationMgr = createIntegrationManager(buildIntegrationDefinitions());
    await this.integrationMgr.initialize({ messageBus: this.bus, channelOpts });
    this.channels = this.integrationMgr.getActiveChannels();
  }

  private initShadowAgent(): void {
    const db = getDatabase();
    const templateRepo = createAgentTemplateRepository(db);
    createShadowAgent({
      adminJid: ADMIN_JID,
      adminTrigger: ADMIN_TRIGGER,
      channels: this.integrationMgr?.getActiveChannels() ?? this.channels,
      messageBus: this.bus,
      getAgentOptions: () => resolveAgentImage(getLeadAgentId()),
      getTemplate: (key) => templateRepo.get(key),
      setTemplate: (key, value) => templateRepo.set(key, value),
      getSocketServer: () => this.socketServer ?? undefined,
    });
  }

  private createAgentSpawner(): import('../agents/persistent-agent-spawner.js').ContainerSpawner {
    const db = getDatabase();
    const templateRepo = createAgentTemplateRepository(db);
    const agentRepo = this.agentRepo ?? createAgentRepository(db);

    return createPersistentAgentSpawner({
      getActiveMcpServers: () => this.integrationMgr?.getActiveMcpServers(),
      getAgentOptions: () => resolveAgentImage(getLeadAgentId()),
      messageBus: this.bus,
      getTemplateValue: (key) => templateRepo.get(key),
      buildAgentContext: (folder, isMain, chatJid, identityOverride, soulOverride) =>
        buildAgentContext({
          mcpServers: this.integrationMgr?.getActiveMcpServers() ?? [],
          agentIdentity: identityOverride,
          agentSoul: soulOverride,
          agents: agentRepo.getAll().map(a => ({
            id: a.id, name: a.name, description: a.description,
            provider: a.provider, model: a.model,
            capabilities: a.capabilities, mcpServers: a.mcpServers, channels: a.channels,
          })),
          tasks: getAllTasks().map(t => ({
            id: t.id, prompt: t.prompt, schedule_type: t.schedule_type,
            schedule_value: t.schedule_value, status: t.status, next_run: t.next_run,
          })),
          workflows: this.workflowService
            ? this.workflowService.listWorkflows().map(wf => ({ id: wf.id, name: wf.name, schedule: wf.schedule }))
            : [],
          chatJid,
          getChats: () => getAllChats(),
        }),
      resolveAgentImage: (provider, secretKeys) => resolveAgentImage(provider, secretKeys),
      onTelemetry: (telemetry, channel) => {
        this.interceptor?.recordTelemetry(telemetry, channel);
      },
      onContainerError: (error, durationMs, channel) => {
        this.interceptor?.recordContainerError(error, durationMs, channel);
      },
      getInterceptor: () => this.interceptor ?? null,
      getSocketServer: () => this.socketServer ?? undefined,
      gatewayRouter: createGatewayRouterFromEnv(),
      getAgentRegistry: () => agentRepo.getAll().map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        capabilities: a.capabilities,
      })),
      getAgentById: (id) => agentRepo.getById(id),
    });
  }

  private bootstrapAgentHandlers(agentRepo: AgentRepository, spawner: import('../agents/persistent-agent-spawner.js').ContainerSpawner): void {
    this.persistentAgentHandler = createPersistentAgentHandler({
      messageBus: this.bus,
      agentRepo,
      spawner,
      autoProvision: (channel) => provisionAgent({ agentRepo }, { channel }),
    });
    this.workflowAgentHandler = createWorkflowAgentHandler({
      messageBus: this.bus,
      agentRepo,
      spawner,
    });
  }

  private initPersistentAgents(): void {
    try {
      const db = getDatabase();
      const agentRepo = createAgentRepository(db);
      agentRepo.ensureTable();

      this.agentRepo = agentRepo;
      const spawner = this.createAgentSpawner();
      this.agentSpawner = spawner;
      this.bootstrapAgentHandlers(agentRepo, spawner);

      const agents = agentRepo.getAll();
      logger.info(
        { agentCount: agents.length, agents: agents.map(a => a.id) },
        'Persistent agents initialized (auto-provisioning enabled)',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize persistent agents');
    }
  }

  private async initSocketServer(): Promise<void> {
    const socketDeps: SocketDeps = {
      bus: this.bus,
      registeredGroups: () => this.state.getRegisteredGroups(),
      registerGroup: (jid, group) => this.state.registerGroup(jid, group),
      syncGroupMetadata: async (force) => {
        const activeChannels = this.integrationMgr?.getActiveChannels() ?? this.channels;
        for (const ch of activeChannels) await ch.syncMetadata?.(force);
      },
      getAvailableGroups: () => this.state.getAvailableGroups(),
      writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
      workflowService: this.workflowService ?? undefined,
      workflowBuilderService: this.workflowBuilderService ?? undefined,
      resolveAgentImage,
      getAgentDefinition,
      integrationManager: this.integrationMgr ?? undefined,
      contentPipe: this.contentPipe ?? undefined,
      rawContentStore: this.rawContentStore ?? undefined,
      workspaceMcpUrl: `http://localhost:${WORKSPACE_MCP_PORT}/mcp`,
      agentSpawner: this.agentSpawner ?? undefined,
      agentRepo: this.agentRepo ?? undefined,
      // socketServer assigned below after CambotSocketServer creation
    };

    const registry = new CommandRegistry(socketDeps);
    registerAllHandlers(registry);

    this.socketServer = new CambotSocketServer({
      registry,
      port: CAMBOT_SOCKET_PORT,
    });

    // Wire the server reference into deps (circular dependency resolution)
    socketDeps.socketServer = this.socketServer;

    await this.socketServer.start();
    logger.info({ port: CAMBOT_SOCKET_PORT }, 'CambotSocketServer started');
  }

  private handleAgentMutation(deletedFolder?: string): void {
    if (deletedFolder) {
      this.cleanupAgentFolder(deletedFolder);
    }

    if (this.persistentAgentHandler) {
      this.persistentAgentHandler.reload();
    }
  }

  /**
   * Async cleanup of a deleted agent's disk artifacts.
   * Kills any running containers first, then removes workspace and session directories.
   */
  private cleanupAgentFolder(folder: string): void {
    const PROTECTED_FOLDERS = new Set(['main', 'workflows']);
    if (PROTECTED_FOLDERS.has(folder)) {
      logger.warn({ folder }, 'Refusing to clean up protected folder');
      return;
    }

    setImmediate(() => {
      try {
        stopContainersForGroup(folder);
      } catch (err) {
        logger.warn({ err, folder }, 'Failed to stop containers during agent cleanup');
      }

      try {
        deleteConversationsByFolder(folder);
      } catch (err) {
        logger.warn({ err, folder }, 'Failed to delete conversations during agent cleanup');
      }

      const dirs = [
        path.join(GROUPS_DIR, folder),
        path.join(DATA_DIR, 'sessions', folder),
      ];

      for (const dir of dirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          logger.warn({ err, dir }, 'Failed to remove agent directory during cleanup');
        }
      }

      logger.info({ folder, dirs }, 'Cleaned up deleted agent disk artifacts');
    });
  }

  private startSubsystems(): void {
    startSchedulerLoop({
      queue: this.queue,
      messageBus: this.bus,
    });

    this.taskPromptHandler = createTaskPromptHandler({
      messageBus: this.bus,
      getAgentRepo: () => this.agentRepo,
      getSpawner: () => this.agentSpawner,
      runDefaultPipeline: (task) => runDefaultTaskPipeline(task, {
        registeredGroups: () => this.state.getRegisteredGroups(),
        queue: this.queue,
        onProcess: (groupJid, proc, containerName, groupFolder) =>
          this.queue.registerProcess(groupJid, proc, containerName, groupFolder),
        messageBus: this.bus,
        getIntegrationManager: () => this.integrationMgr,
        getSocketServer: () => this.socketServer ?? undefined,
      }),
    });
    startWorkflowSchedulerLoop({ workflowService: this.workflowService! });
  }

  private routeAuditEvent(event: { type: string; channel: string; data: Record<string, unknown> }): void {
    if (!this.auditEmitter) return;
    const d = event.data;
    const corrId = (d.correlationId as string) ?? '';
    try {
      switch (event.type) {
        case 'audit.webhook_received':
          this.auditEmitter.webhookReceived({
            channel: event.channel,
            correlationId: corrId || `${event.channel}:webhook:${(d.webhookId as string) ?? 'unknown'}`,
            sourceIp: d.sourceIp as string,
            method: d.method as string,
            path: d.path as string,
            userAgent: d.userAgent as string,
            authProvided: d.authProvided as boolean,
            authValid: d.authValid as boolean,
            responseCode: d.responseCode as number,
            durationMs: d.durationMs as number,
            webhookId: d.webhookId as string | undefined,
            contentLength: d.contentLength as number,
          });
          break;
        case 'audit.webhook_auth_failed':
          this.auditEmitter.webhookAuthFailed({
            channel: event.channel,
            correlationId: corrId || `${event.channel}:webhook:unknown`,
            sourceIp: d.sourceIp as string,
            headerName: d.headerName as string,
            path: d.path as string,
          });
          break;
        case 'audit.authorization_decision':
          this.auditEmitter.authorizationDecision({
            channel: event.channel,
            correlationId: corrId || `${event.channel}:${d.chatJid as string}:${d.messageId as string}`,
            chatJid: d.chatJid as string,
            sender: d.sender as string,
            messageId: d.messageId as string,
            decision: d.decision as 'allowed' | 'dropped_unregistered',
            groupFolder: d.groupFolder as string | undefined,
          });
          break;
        case 'audit.delivery_result':
          this.auditEmitter.deliveryResult({
            channel: event.channel,
            correlationId: corrId || `${event.channel}:${d.chatJid as string}`,
            chatJid: d.chatJid as string,
            accepted: d.accepted as boolean,
            providerMessageId: d.providerMessageId as string | undefined,
            error: d.error as string | undefined,
            durationMs: d.durationMs as number,
          });
          break;
        case 'audit.webhook_dedup':
          this.auditEmitter.webhookDedup({
            channel: event.channel,
            correlationId: corrId || `${event.channel}:webhook:${d.webhookId as string}`,
            webhookId: d.webhookId as string,
          });
          break;
        case 'audit.message_inbound':
          this.auditEmitter.messageInbound({
            channel: event.channel,
            correlationId: corrId || `${event.channel}:${d.chatJid as string}:${d.messageId as string}`,
            chatJid: d.chatJid as string,
            sender: d.sender as string,
            senderName: d.senderName as string,
            messageId: d.messageId as string,
            isGroup: d.isGroup as boolean,
            contentLength: d.contentLength as number,
            webhookId: d.webhookId as string | undefined,
          });
          break;
        default:
          break;
      }
    } catch (err) {
      logger.warn({ err, auditType: event.type }, 'Failed to route audit event');
    }
  }

  private startStaleCleanup(): void {
    const STALE_CLEANUP_INTERVAL = 5 * 60_000;
    const STALE_MAX_AGE = 90 * 60_000;
    setInterval(() => {
      cleanupStaleContainers(STALE_MAX_AGE);
    }, STALE_CLEANUP_INTERVAL);
  }
}
