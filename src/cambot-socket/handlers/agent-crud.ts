/**
 * agent.create / agent.list / agent.invoke / agent.update / agent.delete handlers.
 *
 * CRUD operations for custom agents. These complement the existing agent.send
 * handler (which handles inter-agent messaging).
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { logger } from '../../logger.js';
import { generateAndStoreKeywords } from '../../agents/keyword-generator.js';
import type { CommandRegistry } from './registry.js';

// ── Schemas ──────────────────────────────────────────────

const AgentCreateSchema = z.object({
  agent: z.object({}).passthrough(),
});

const AgentListSchema = z.object({
  groupFolder: z.string().optional(),
  isMain: z.boolean().optional(),
});

const AgentInvokeSchema = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  chatJid: z.string().optional(),
  groupFolder: z.string().optional(),
  isMain: z.boolean().optional(),
});

const AgentUpdateSchema = z.object({
  agentId: z.string().min(1),
  updates: z.object({}).passthrough(),
});

const AgentDeleteSchema = z.object({
  agentId: z.string().min(1),
  cleanupMemory: z.boolean().optional(),
});

// ── Registration ─────────────────────────────────────────

export function registerAgentCrud(registry: CommandRegistry): void {
  // ── agent.create ──────────────────────────────────────
  registry.register(
    FRAME_TYPES.AGENT_CREATE,
    AgentCreateSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!deps.agentRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Agent repository not initialized');
        return;
      }

      try {
        const agentData = payload.agent as Record<string, unknown>;
        const description = (agentData.description as string) ?? '';
        if (!description) {
          connection.replyError(frame, 'VALIDATION', 'description is required — used for gateway routing');
          return;
        }

        const agent = deps.agentRepo.create({
          id: agentData.id as string,
          name: agentData.name as string,
          description,
          folder: (agentData.group_folder as string) ?? (agentData.id as string),
          provider: (agentData.provider as string) ?? 'claude',
          model: (agentData.model as string) ?? 'claude-sonnet-4-6',
          secretKeys: agentData.api_key_env_var
            ? [agentData.api_key_env_var as string]
            : [],
          systemPrompt: (agentData.system_prompt as string) ?? null,
          tools: Array.isArray(agentData.tools)
            ? (agentData.tools as string[])
            : agentData.tools
              ? JSON.parse(agentData.tools as string)
              : [],
          temperature: (agentData.temperature as number) ?? null,
          maxTokens: (agentData.max_tokens as number) ?? null,
          baseUrl: (agentData.base_url as string) ?? null,
          timeoutMs: (agentData.timeout_ms as number) ?? 300_000,
        });

        connection.reply(frame, FRAME_TYPES.AGENT_CREATE, {
          status: 'ok',
          agentId: agent.id,
        });

        logger.info({ agentId: agent.id }, 'Agent created via socket');

        // Generate routing keywords in background (includes cache invalidation)
        generateAndStoreKeywords(
          deps.agentRepo,
          agent,
          () => deps.onAgentMutation?.(),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'agent.create failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── agent.list ────────────────────────────────────────
  registry.register(
    FRAME_TYPES.AGENT_LIST,
    AgentListSchema,
    'any',
    async (payload, frame, connection, deps) => {
      if (!deps.agentRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Agent repository not initialized');
        return;
      }

      try {
        const { isMain: connIsMain } = connection.identity;
        const isMain = payload.isMain ?? connIsMain;

        const agents = deps.agentRepo.getAll();
        const filtered = isMain
          ? agents
          : agents.filter((a) => a.folder === (payload.groupFolder ?? connection.identity.group));

        const lines = filtered.map((a) =>
          `[${a.id}] ${a.name} (${a.provider}/${a.model}) folder=${a.folder}`,
        );

        connection.reply(frame, FRAME_TYPES.AGENT_LIST, {
          status: 'ok',
          result: filtered.length > 0
            ? `${filtered.length} agent(s):\n${lines.join('\n')}`
            : 'No agents found.',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'agent.list failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── agent.invoke ──────────────────────────────────────
  registry.register(
    FRAME_TYPES.AGENT_INVOKE,
    AgentInvokeSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!deps.agentSpawner || !deps.agentRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Agent system not initialized');
        return;
      }

      const agent = deps.agentRepo.getById(payload.agentId);
      if (!agent) {
        connection.replyError(frame, 'NOT_FOUND', `Agent "${payload.agentId}" not found`);
        return;
      }

      try {
        const chatJid = payload.chatJid ?? 'invoke';
        const result = await deps.agentSpawner.spawn(
          agent,
          payload.prompt,
          chatJid,
          agent.timeoutMs,
        );

        connection.reply(frame, FRAME_TYPES.AGENT_INVOKE, {
          status: result.status,
          result: result.content,
        });

        logger.info(
          { agentId: payload.agentId, status: result.status },
          'Agent invoked via socket',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ agentId: payload.agentId, err }, 'agent.invoke failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── agent.update ──────────────────────────────────────
  registry.register(
    FRAME_TYPES.AGENT_UPDATE,
    AgentUpdateSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!deps.agentRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Agent repository not initialized');
        return;
      }

      try {
        const updates = payload.updates as Record<string, unknown>;
        deps.agentRepo.update(payload.agentId, {
          name: updates.name as string | undefined,
          description: updates.description as string | undefined,
          provider: updates.provider as string | undefined,
          model: updates.model as string | undefined,
          systemPrompt: updates.system_prompt as string | undefined,
          tools: Array.isArray(updates.tools)
            ? (updates.tools as string[])
            : updates.tools
              ? JSON.parse(updates.tools as string)
              : undefined,
          temperature: updates.temperature as number | undefined,
          maxTokens: updates.max_tokens as number | undefined,
          baseUrl: updates.base_url as string | undefined,
          timeoutMs: updates.timeout_ms as number | undefined,
        });

        connection.reply(frame, FRAME_TYPES.AGENT_UPDATE, {
          status: 'ok',
          agentId: payload.agentId,
        });

        logger.info({ agentId: payload.agentId }, 'Agent updated via socket');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ agentId: payload.agentId, err }, 'agent.update failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── agent.delete ──────────────────────────────────────
  registry.register(
    FRAME_TYPES.AGENT_DELETE,
    AgentDeleteSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!deps.agentRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Agent repository not initialized');
        return;
      }

      try {
        const agent = deps.agentRepo.getById(payload.agentId);
        if (!agent) {
          connection.replyError(frame, 'NOT_FOUND', `Agent "${payload.agentId}" not found`);
          return;
        }
        if (agent.system) {
          connection.replyError(frame, 'FORBIDDEN', `Cannot delete system agent "${payload.agentId}"`);
          return;
        }

        deps.agentRepo.delete(payload.agentId);

        connection.reply(frame, FRAME_TYPES.AGENT_DELETE, {
          status: 'ok',
          agentId: payload.agentId,
        });

        logger.info({ agentId: payload.agentId }, 'Agent deleted via socket');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ agentId: payload.agentId, err }, 'agent.delete failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );
}
