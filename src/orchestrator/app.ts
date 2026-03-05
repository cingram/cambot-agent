import { exec } from 'child_process';
import path from 'path';

import {
  ADMIN_JID,
  ADMIN_TRIGGER,
  CONTEXT_TOKEN_BUDGET,
  DATA_DIR,
  STORE_DIR,
  WORKFLOW_CONTAINER_TIMEOUT,
} from '../config/config.js';
import { getLeadAgentId, loadAgentsConfig, resolveAgentImage } from '../agents/agents.js';
import { buildIntegrationDefinitions, createIntegrationManager } from '../integrations/index.js';
import type { IntegrationManager } from '../integrations/index.js';
import {
  runContainerAgent,
  type ContainerOutput,
} from '../container/runner.js';
import { writeGroupsSnapshot } from '../container/snapshot-writers.js';
import { cleanupStaleContainers, cleanupStaleHeartbeats, ensureContainerRuntimeRunning, cleanupOrphans, stopContainer } from '../container/runtime.js';
import {
  getAgentDefinition,
  getDatabase,
  initDatabase,
  storeChatMetadata,
  storeMessage,
} from '../db/index.js';
import { GroupQueue } from '../groups/group-queue.js';
import { startIpcWatcher } from '../ipc/watcher.js';
import { startSchedulerLoop } from '../scheduling/task-scheduler.js';
import { startWorkflowSchedulerLoop } from '../workflows/workflow-scheduler.js';
import {
  Channel,
  ExecutionContext,
  NewMessage,
  createMessageBus,
} from '../types.js';
import type { MessageBus } from '../types.js';
import { logger } from '../logger.js';
import { createCustomAgentService, type CustomAgentService } from '../agents/custom-agent-service.js';
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
import { MessageLoop } from './message-loop.js';

export class CamBotApp {
  private state = new RouterState();
  private queue = new GroupQueue();
  private channels: Channel[] = [];
  private bus!: MessageBus;
  private workflowService: WorkflowService | null = null;
  private workflowBuilderService: WorkflowBuilderService | null = null;
  private customAgentService: CustomAgentService | null = null;
  private interceptor: LifecycleInterceptor | null = null;
  private integrationMgr: IntegrationManager | null = null;
  private shadowInterceptor: (chatJid: string, msg: NewMessage) => boolean = () => false;
  private busHandlers!: BusHandlerRegistry;

  async start(): Promise<void> {
    this.installProcessHandlers();
    this.initInfra();
    this.initDatabase();
    this.state.load();
    loadAgentsConfig();
    this.initLifecycleInterceptor();

    this.bus = createMessageBus();
    this.initWorkflowService();
    await this.initWorkflowBuilderService();
    this.initCustomAgentService();

    this.busHandlers = new BusHandlerRegistry({
      bus: this.bus,
      getChannels: () => this.channels,
      getIntegrationManager: () => this.integrationMgr,
    });
    this.busHandlers.register();

    this.installShutdownHandlers();
    await this.initIntegrations();
    this.initShadowAgent();
    this.startSubsystems();

    // Build message pipeline
    const agentRunner = new AgentRunner({
      state: this.state,
      queue: this.queue,
      getWorkflowService: () => this.workflowService,
      getWorkflowBuilderService: () => this.workflowBuilderService,
      getIntegrationManager: () => this.integrationMgr,
    });

    const processor = new GroupMessageProcessor({
      state: this.state,
      queue: this.queue,
      bus: this.bus,
      getChannels: () => this.channels,
      getInterceptor: () => this.interceptor,
      getCustomAgentService: () => this.customAgentService,
      agentRunner,
    });

    this.queue.setProcessMessagesFn(processor.process.bind(processor));

    const messageLoop = new MessageLoop({
      state: this.state,
      queue: this.queue,
      bus: this.bus,
      getChannels: () => this.channels,
      getInterceptor: () => this.interceptor,
    });

    messageLoop.recoverPendingMessages();
    this.startStaleCleanup();

    messageLoop.start().catch((err) => {
      logger.fatal({ err }, 'Message loop crashed unexpectedly');
      process.exit(1);
    });
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
      this.interceptor = createLifecycleInterceptor(core, logger);
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

  private initCustomAgentService(): void {
    this.customAgentService = createCustomAgentService({
      getRegisteredGroup: (groupFolder: string) => {
        return this.state.getRegisteredGroupByFolder(groupFolder);
      },
      messageBus: this.bus,
      onProcess: (proc, containerName, groupFolder) => {
        logger.debug({ containerName, groupFolder }, 'Custom agent container spawned');
      },
      getAgentOptions: () => resolveAgentImage(getLeadAgentId()),
      onTelemetry: (telemetry, channel) => {
        this.interceptor?.recordTelemetry(telemetry, channel);
      },
      onContainerError: (error, durationMs, channel) => {
        this.interceptor?.recordContainerError(error, durationMs, channel);
      },
    });
  }

  private installShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      if (this.interceptor) await this.interceptor.close();
      await this.queue.shutdown(10000);
      if (this.integrationMgr) await this.integrationMgr.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  private async initIntegrations(): Promise<void> {
    const channelOpts = {
      onMessage: (chatJid: string, msg: NewMessage) => {
        if (this.shadowInterceptor(chatJid, msg)) return;
        storeMessage(msg);
        this.interceptor?.ingestMessage(msg);
      },
      onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => this.state.getRegisteredGroups(),
      registerGroup: (jid: string, group: any) => this.state.registerGroup(jid, group),
      messageBus: this.bus,
      workflowService: this.workflowService ?? undefined,
      channelNames: () => this.channels.map(ch => ch.name),
    };

    this.integrationMgr = createIntegrationManager(buildIntegrationDefinitions());
    await this.integrationMgr.initialize({ messageBus: this.bus, channelOpts });
    this.channels = this.integrationMgr.getActiveChannels();
  }

  private initShadowAgent(): void {
    this.shadowInterceptor = createShadowAgent({
      adminJid: ADMIN_JID,
      adminTrigger: ADMIN_TRIGGER,
      channels: this.integrationMgr?.getActiveChannels() ?? this.channels,
      messageBus: this.bus,
      getAgentOptions: () => resolveAgentImage(getLeadAgentId()),
    });
  }

  private startSubsystems(): void {
    startSchedulerLoop({
      registeredGroups: () => this.state.getRegisteredGroups(),
      getSessions: () => this.state.getAllSessions(),
      queue: this.queue,
      onProcess: (groupJid, proc, containerName, groupFolder) =>
        this.queue.registerProcess(groupJid, proc, containerName, groupFolder),
      messageBus: this.bus,
    });
    startWorkflowSchedulerLoop({ workflowService: this.workflowService! });
    startIpcWatcher({
      messageBus: this.bus,
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
      customAgentService: this.customAgentService ?? undefined,
      resolveAgentImage,
      getAgentDefinition,
      integrationManager: this.integrationMgr ?? undefined,
    });
  }

  private startStaleCleanup(): void {
    const STALE_CLEANUP_INTERVAL = 5 * 60_000;
    const STALE_MAX_AGE = 90 * 60_000;
    setInterval(() => {
      cleanupStaleContainers(STALE_MAX_AGE);
      cleanupStaleHeartbeats(STALE_MAX_AGE);
    }, STALE_CLEANUP_INTERVAL);
  }
}
