/**
 * Custom Agent Service for CamBot-Agent
 *
 * Manages custom agent definitions and invocation.
 * Follows the factory pattern used by WorkflowService.
 */
import { exec, type ChildProcess } from 'child_process';

import {
  createCustomAgent,
  deleteCustomAgent,
  getAllCustomAgents,
  getCustomAgent,
  getCustomAgentsByGroup,
  updateCustomAgent,
  findCustomAgentByTrigger,
  type CustomAgentRow,
} from './db.js';
import { runContainerAgent, type ContainerInput } from './container-runner.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';
import type { RegisteredGroup, MessageBus } from './types.js';

export interface CustomAgentService {
  createAgent(agent: CustomAgentRow): void;
  getAgent(id: string): CustomAgentRow | undefined;
  getAllAgents(): CustomAgentRow[];
  getAgentsByGroup(groupFolder: string): CustomAgentRow[];
  updateAgent(id: string, updates: Partial<Omit<CustomAgentRow, 'id' | 'created_at'>>): void;
  deleteAgent(id: string): void;
  findByTrigger(messageContent: string): CustomAgentRow | undefined;
  invokeAgent(
    agentId: string,
    prompt: string,
    chatJid: string,
    groupFolder: string,
    isMain: boolean,
  ): Promise<string>;
}

export interface CustomAgentServiceDeps {
  getRegisteredGroup: (groupFolder: string) => RegisteredGroup | undefined;
  messageBus?: MessageBus;
  sendMessage: (jid: string, text: string) => Promise<void>;
  onProcess: (proc: ChildProcess, containerName: string, groupFolder: string) => void;
}

export function createCustomAgentService(deps: CustomAgentServiceDeps): CustomAgentService {
  return {
    createAgent(agent: CustomAgentRow): void {
      createCustomAgent(agent);
      logger.info({ agentId: agent.id, name: agent.name }, 'Custom agent created');
    },

    getAgent(id: string): CustomAgentRow | undefined {
      return getCustomAgent(id);
    },

    getAllAgents(): CustomAgentRow[] {
      return getAllCustomAgents();
    },

    getAgentsByGroup(groupFolder: string): CustomAgentRow[] {
      return getCustomAgentsByGroup(groupFolder);
    },

    updateAgent(id: string, updates: Partial<Omit<CustomAgentRow, 'id' | 'created_at'>>): void {
      updateCustomAgent(id, updates);
      logger.info({ agentId: id }, 'Custom agent updated');
    },

    deleteAgent(id: string): void {
      deleteCustomAgent(id);
      logger.info({ agentId: id }, 'Custom agent deleted');
    },

    findByTrigger(messageContent: string): CustomAgentRow | undefined {
      return findCustomAgentByTrigger(messageContent);
    },

    async invokeAgent(
      agentId: string,
      prompt: string,
      chatJid: string,
      groupFolder: string,
      isMain: boolean,
    ): Promise<string> {
      const agentDef = getCustomAgent(agentId);
      if (!agentDef) {
        throw new Error(`Custom agent not found: ${agentId}`);
      }

      // Find the registered group to get container config
      const group = deps.getRegisteredGroup(groupFolder);
      if (!group) {
        throw new Error(`Group not found: ${groupFolder}`);
      }

      const input: ContainerInput = {
        prompt,
        groupFolder,
        chatJid,
        isMain,
        customAgent: {
          agentId: agentDef.id,
          provider: agentDef.provider as 'openai' | 'xai' | 'anthropic' | 'google',
          model: agentDef.model,
          baseUrl: agentDef.base_url ?? undefined,
          apiKeyEnvVar: agentDef.api_key_env_var,
          systemPrompt: agentDef.system_prompt,
          tools: JSON.parse(agentDef.tools),
          maxTokens: agentDef.max_tokens ?? undefined,
          temperature: agentDef.temperature ?? undefined,
          maxIterations: agentDef.max_iterations,
          timeoutMs: agentDef.timeout_ms,
        },
      };

      let finalResult = '';
      let spawnedContainerName: string | null = null;
      let gotFirstResult = false;

      const output = await runContainerAgent(
        group,
        input,
        (proc, containerName) => {
          spawnedContainerName = containerName;
          deps.onProcess(proc, containerName, groupFolder);
        },
        async (result) => {
          if (result.result) {
            finalResult = result.result;
            if (deps.messageBus) {
              await deps.messageBus.emitAsync({
                type: 'message.outbound',
                source: 'custom-agent',
                timestamp: new Date().toISOString(),
                data: {
                  jid: chatJid,
                  text: result.result,
                  source: 'custom-agent',
                  groupFolder,
                  agentId,
                },
              });
            } else {
              await deps.sendMessage(chatJid, result.result);
            }
          }
          // Stop the container after delivering the first result
          if (!gotFirstResult) {
            gotFirstResult = true;
            if (spawnedContainerName) {
              const name = spawnedContainerName;
              exec(stopContainer(name), { timeout: 15_000 }, (err) => {
                if (err) logger.debug({ containerName: name, err }, 'Custom agent container stop (may already be exiting)');
              });
            }
          }
        },
      );

      if (output.status === 'error') {
        logger.error({ agentId, error: output.error }, 'Custom agent invocation failed');
        throw new Error(output.error ?? 'Custom agent execution failed');
      }

      return finalResult;
    },
  };
}
