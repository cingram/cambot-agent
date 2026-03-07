/**
 * REST API routes for agent and template CRUD.
 *
 * Mounted at /api/agents and /api/templates by the web channel.
 */
import type http from 'http';

import type { AgentRepository, CreateAgentInput, UpdateAgentInput } from '../db/agent-repository.js';
import type { AgentTemplateRepository } from '../db/agent-template-repository.js';
import { logger } from '../logger.js';

export interface AgentRoutesDeps {
  agentRepo: AgentRepository;
  templateRepo: AgentTemplateRepository;
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
        const agent = agentRepo.create(input);
        logger.info({ agentId: agent.id }, 'Agent created via API');
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
        const agent = agentRepo.update(agentMatch[1], updates);
        logger.info({ agentId: agent.id }, 'Agent updated via API');
        deps.onAgentMutation?.();
        json(res, 200, agent);
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
      agentRepo.delete(agentMatch[1]);
      logger.info({ agentId: agentMatch[1] }, 'Agent deleted via API');
      deps.onAgentMutation?.(agent.folder);
      json(res, 200, { success: true });
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

// ── Helpers ──

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, status: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err }, 'Agent API error');
  json(res, status, { error: message });
}

function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (body: Record<string, unknown>) => void,
): void {
  let raw = '';
  req.on('data', (chunk: Buffer) => { raw += chunk; });
  req.on('end', () => {
    try {
      handler(JSON.parse(raw));
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
    }
  });
}
