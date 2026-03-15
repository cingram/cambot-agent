/**
 * REST API routes for agent, template, and conversation CRUD.
 *
 * Mounted at /api/agents, /api/templates by the web channel.
 */
import type http from 'http';

import type { AgentMessageRepository } from '../db/agent-message-repository.js';
import type { AgentRepository, CreateAgentInput, UpdateAgentInput } from '../db/agent-repository.js';
import type { AgentTemplateRepository } from '../db/agent-template-repository.js';
import { provisionAgent, type ProvisionInput } from '../agents/agent-factory.js';
import { generateAndStoreKeywords } from '../agents/keyword-generator.js';
import { json, error, readBody } from './http-helpers.js';
import {
  listAgentConversations,
  createConversation,
  activateConversation,
  deleteConversation,
  deleteConversationsByFolder,
  renameConversation,
  getConversationById,
} from '../db/conversation-repository.js';
import { getAllMcpServers } from '../db/mcp-repository.js';
import { ALL_SDK_TOOLS, CAMBOT_MCP_TOOLS, GOOGLE_MCP_TOOLS } from '../tools/tool-policy.js';
import { SKILLS_DIR } from '../config/config.js';
import { scanSkills, type SkillInfo } from '../utils/context-files.js';
import { logger } from '../logger.js';

export interface AgentRoutesDeps {
  agentRepo: AgentRepository;
  templateRepo: AgentTemplateRepository;
  /** Agent message repository for inter-agent communication tracking (optional). */
  agentMessageRepo?: AgentMessageRepository;
  /** Called after agent create/update/delete to refresh routing tables.
   *  On delete, passes the deleted agent's folder for disk cleanup. */
  onAgentMutation?: (deletedFolder?: string) => void;
}

export function handleAgentRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: AgentRoutesDeps,
): boolean {
  const { agentRepo, templateRepo } = deps;

  // --- Agent routes ---

  if (url.pathname === '/api/agents' && req.method === 'GET') {
    try {
      const agents = agentRepo.getAll();
      json(res, 200, { agents });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);

  if (agentMatch && req.method === 'GET') {
    try {
      const agent = agentRepo.getById(agentMatch[1]);
      if (!agent) {
        json(res, 404, { error: 'Agent not found' });
      } else {
        json(res, 200, agent);
      }
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  if (url.pathname === '/api/agents' && req.method === 'POST') {
    readBody(req, res, (body) => {
      try {
        const input = body as unknown as CreateAgentInput;
        if (!input.id || !input.name || !input.folder) {
          json(res, 400, { error: 'id, name, and folder are required' });
          return;
        }
        if (!input.description) {
          json(res, 400, { error: 'description is required — used for gateway routing' });
          return;
        }
        // Default to readonly if no tool policy specified
        if (!input.toolPolicy) {
          input.toolPolicy = { preset: 'readonly' };
        }
        const agent = agentRepo.create(input);
        logger.info({ agentId: agent.id }, 'Agent created via API');
        json(res, 201, agent);

        // Notify immediately so routing picks up the new agent right away,
        // then again after keywords are generated for updated scoring
        deps.onAgentMutation?.();
        if (!input.routingKeywords) {
          generateAndStoreKeywords(agentRepo, agent, () => deps.onAgentMutation?.());
        }
      } catch (err) {
        error(res, 400, err);
      }
    });
    return true;
  }

  if (url.pathname === '/api/agents/provision' && req.method === 'POST') {
    readBody(req, res, (body) => {
      try {
        const input = body as unknown as ProvisionInput;
        if (!input.channel) {
          json(res, 400, { error: 'channel is required' });
          return;
        }
        const agent = provisionAgent({ agentRepo }, input);
        logger.info({ agentId: agent.id, channel: input.channel }, 'Agent provisioned via API');
        deps.onAgentMutation?.();
        json(res, 201, agent);
      } catch (err) {
        error(res, 400, err);
      }
    });
    return true;
  }

  if (agentMatch && req.method === 'PUT') {
    readBody(req, res, (body) => {
      try {
        const updates = body as UpdateAgentInput;
        const before = agentRepo.getById(agentMatch[1]);
        const agent = agentRepo.update(agentMatch[1], updates);
        logger.info({ agentId: agent.id }, 'Agent updated via API');
        json(res, 200, agent);

        // Regenerate routing keywords when description or capabilities change
        const descChanged = updates.description !== undefined && updates.description !== before?.description;
        const capsChanged = updates.capabilities !== undefined;
        if ((descChanged || capsChanged) && !updates.routingKeywords) {
          generateAndStoreKeywords(agentRepo, agent, () => deps.onAgentMutation?.());
        } else {
          deps.onAgentMutation?.();
        }
      } catch (err) {
        error(res, 400, err);
      }
    });
    return true;
  }

  if (agentMatch && req.method === 'DELETE') {
    try {
      const agent = agentRepo.getById(agentMatch[1]);
      if (!agent) {
        json(res, 404, { error: 'Agent not found' });
        return true;
      }
      if (agent.system) {
        json(res, 403, { error: `Cannot delete system agent "${agent.id}"` });
        return true;
      }
      agentRepo.delete(agentMatch[1]);
      logger.info({ agentId: agentMatch[1] }, 'Agent deleted via API');
      deps.onAgentMutation?.(agent.folder);
      json(res, 200, { success: true });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  // --- Agent message routes ---

  if (url.pathname === '/api/agent-messages' && req.method === 'GET') {
    if (!deps.agentMessageRepo) {
      json(res, 503, { error: 'Agent message tracking not available' });
      return true;
    }
    try {
      const messages = deps.agentMessageRepo.query({
        source: url.searchParams.get('source') ?? undefined,
        target: url.searchParams.get('target') ?? undefined,
        type: (url.searchParams.get('type') as 'agent.send' | 'worker.delegate') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
        until: url.searchParams.get('until') ?? undefined,
        limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined,
        offset: url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined,
      });
      json(res, 200, { messages });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  const agentMsgAgentMatch = url.pathname.match(/^\/api\/agent-messages\/agent\/([^/]+)$/);
  if (agentMsgAgentMatch && req.method === 'GET') {
    if (!deps.agentMessageRepo) {
      json(res, 503, { error: 'Agent message tracking not available' });
      return true;
    }
    try {
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
      const messages = deps.agentMessageRepo.getByAgent(agentMsgAgentMatch[1], limit);
      json(res, 200, { messages });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  const agentMsgBetweenMatch = url.pathname.match(/^\/api\/agent-messages\/between\/([^/]+)\/([^/]+)$/);
  if (agentMsgBetweenMatch && req.method === 'GET') {
    if (!deps.agentMessageRepo) {
      json(res, 503, { error: 'Agent message tracking not available' });
      return true;
    }
    try {
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
      const messages = deps.agentMessageRepo.getBetween(agentMsgBetweenMatch[1], agentMsgBetweenMatch[2], limit);
      json(res, 200, { messages });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  // --- Conversation routes (per-agent) ---
  // Only evaluate conversation regexes when the path looks like a conversation route
  if (url.pathname.includes('/conversations')) {
    return handleConversationRoutes(req, res, url, agentRepo);
  }

  // --- Skills routes ---

  if (url.pathname === '/api/skills' && req.method === 'GET') {
    try {
      json(res, 200, { skills: getCachedSkills() });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  // --- Tools route ---

  if (url.pathname === '/api/tools' && req.method === 'GET') {
    try {
      json(res, 200, {
        sdkTools: [...ALL_SDK_TOOLS],
        mcpTools: {
          'cambot-agent': [...CAMBOT_MCP_TOOLS],
          'google-workspace': [...GOOGLE_MCP_TOOLS],
        },
      });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  // --- MCP Servers route ---

  if (url.pathname === '/api/mcp-servers' && req.method === 'GET') {
    try {
      const servers = getAllMcpServers();
      json(res, 200, { mcpServers: servers });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  // --- Template routes ---

  if (url.pathname === '/api/templates' && req.method === 'GET') {
    try {
      const templates = templateRepo.getAll();
      json(res, 200, { templates });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);

  if (templateMatch && req.method === 'PUT') {
    readBody(req, res, (body) => {
      try {
        const { value } = body as { value: string };
        if (!value) {
          json(res, 400, { error: 'value is required' });
          return;
        }
        templateRepo.set(templateMatch[1], value);
        logger.info({ key: templateMatch[1] }, 'Template updated via API');
        json(res, 200, { success: true });
      } catch (err) {
        error(res, 500, err);
      }
    });
    return true;
  }

  return false;
}

// ── Conversation sub-router ──

function handleConversationRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  agentRepo: AgentRepository,
): boolean {
  const listMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/conversations$/);
  const activateMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/conversations\/([^/]+)\/activate$/);
  const actionMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/conversations\/([^/]+)$/);

  if (listMatch && req.method === 'GET') {
    try {
      const agent = agentRepo.getById(listMatch[1]);
      if (!agent) { json(res, 404, { error: 'Agent not found' }); return true; }
      json(res, 200, { conversations: listAgentConversations(agent.folder) });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  if (listMatch && req.method === 'DELETE') {
    try {
      const agent = agentRepo.getById(listMatch[1]);
      if (!agent) { json(res, 404, { error: 'Agent not found' }); return true; }
      const deleted = deleteConversationsByFolder(agent.folder);
      logger.info({ agentId: agent.id, deleted }, 'All conversations cleared for agent via API');
      json(res, 200, { success: true, deleted });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  if (listMatch && req.method === 'POST') {
    readBody(req, res, (body) => {
      try {
        const agent = agentRepo.getById(listMatch[1]);
        if (!agent) { json(res, 404, { error: 'Agent not found' }); return; }
        const title = (body.title as string) || undefined;
        const channel = (body.channel as string) || agent.channels[0] || 'unknown';
        const conversation = createConversation(agent.folder, channel, undefined, title);
        logger.info({ agentId: agent.id, conversationId: conversation.id }, 'Conversation created via API');
        json(res, 201, conversation);
      } catch (err) {
        error(res, 400, err);
      }
    });
    return true;
  }

  if (activateMatch && req.method === 'POST') {
    try {
      const agent = agentRepo.getById(activateMatch[1]);
      if (!agent) { json(res, 404, { error: 'Agent not found' }); return true; }
      const conversation = activateConversation(agent.folder, activateMatch[2]);
      logger.info({ agentId: agent.id, conversationId: conversation.id }, 'Conversation activated via API');
      json(res, 200, conversation);
    } catch (err) {
      error(res, 400, err);
    }
    return true;
  }

  if (actionMatch && req.method === 'PATCH') {
    readBody(req, res, (body) => {
      try {
        const title = body.title as string;
        if (!title) { json(res, 400, { error: 'title is required' }); return; }
        const conv = getConversationById(actionMatch[2]);
        if (!conv || conv.agentFolder !== agentRepo.getById(actionMatch[1])?.folder) {
          json(res, 404, { error: 'Conversation not found' }); return;
        }
        renameConversation(actionMatch[2], title);
        json(res, 200, { success: true });
      } catch (err) {
        error(res, 500, err);
      }
    });
    return true;
  }

  if (actionMatch && req.method === 'DELETE') {
    try {
      const conv = getConversationById(actionMatch[2]);
      if (!conv || conv.agentFolder !== agentRepo.getById(actionMatch[1])?.folder) {
        json(res, 404, { error: 'Conversation not found' }); return true;
      }
      deleteConversation(actionMatch[2]);
      logger.info({ conversationId: actionMatch[2] }, 'Conversation deleted via API');
      json(res, 200, { success: true });
    } catch (err) {
      error(res, 500, err);
    }
    return true;
  }

  return false;
}


// ── Skills cache (static on disk, scanned once) ──

let skillsCache: SkillInfo[] | null = null;

function getCachedSkills(): SkillInfo[] {
  if (!skillsCache) {
    skillsCache = scanSkills(SKILLS_DIR);
  }
  return skillsCache;
}
