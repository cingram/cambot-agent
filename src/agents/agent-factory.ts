/**
 * Agent Factory — Auto-provisions persistent agents for unclaimed channels.
 *
 * Derives agent identity from channel name and creates a DB entry with
 * sensible defaults. Used by auto-provisioning (PersistentAgentHandler)
 * and the POST /api/agents/provision endpoint.
 */
import type { AgentRepository } from '../db/agent-repository.js';
import type { ToolPolicy } from '../tools/tool-policy.js';
import type { RegisteredAgent } from '../types.js';

/** Default MCP servers for auto-provisioned agents.
 *  Agents must declare which servers they need — empty list = no servers. */
const DEFAULT_MCP_SERVERS = ['cambot-agent', 'workflow-builder'];

export interface ProvisionInput {
  channel: string;
  provider?: string;
  model?: string;
  systemPrompt?: string | null;
  soul?: string | null;
  toolPolicy?: ToolPolicy;
  mcpServers?: string[];
}

export interface AgentIdentifiers {
  id: string;
  name: string;
  folder: string;
}

/** Derive agent id/name/folder from a channel name. */
export function deriveAgentIdentifiers(channel: string): AgentIdentifiers {
  const sanitized = channel.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return {
    id: `${sanitized}-agent`,
    name: `${channel} agent`,
    folder: `${sanitized}-agent`,
  };
}

/** Create a persistent agent for a channel with sensible defaults. */
export function provisionAgent(
  deps: { agentRepo: AgentRepository },
  input: ProvisionInput,
): RegisteredAgent {
  const { id, name, folder } = deriveAgentIdentifiers(input.channel);

  return deps.agentRepo.create({
    id,
    name,
    folder,
    channels: [input.channel],
    provider: input.provider ?? 'claude',
    model: input.model ?? 'claude-sonnet-4-6',
    systemPrompt: input.systemPrompt ?? null,
    soul: input.soul ?? null,
    toolPolicy: input.toolPolicy ?? { preset: 'full' },
    mcpServers: input.mcpServers ?? DEFAULT_MCP_SERVERS,
  });
}
