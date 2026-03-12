import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { deriveAgentIdentifiers, provisionAgent } from './agent-factory.js';
import type { AgentRepository } from '../db/agent-repository.js';
import type { RegisteredAgent } from '../types.js';

function makeAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'web-agent',
    name: 'web agent',
    description: '',
    folder: 'web-agent',
    channels: ['web'],
    mcpServers: [],
    capabilities: [],
    concurrency: 1,
    timeoutMs: 300_000,
    isMain: false,
    system: false,
    systemPrompt: null,
    soul: null,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    secretKeys: [],
    tools: [],
    skills: [],
    temperature: null,
    maxTokens: null,
    baseUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('deriveAgentIdentifiers', () => {
  it('derives id/name/folder from simple channel', () => {
    const result = deriveAgentIdentifiers('web');
    expect(result).toEqual({
      id: 'web-agent',
      name: 'web agent',
      folder: 'web-agent',
    });
  });

  it('sanitizes special characters', () => {
    const result = deriveAgentIdentifiers('my_channel.v2');
    expect(result.id).toBe('my-channel-v2-agent');
    expect(result.folder).toBe('my-channel-v2-agent');
  });

  it('lowercases the id and folder', () => {
    const result = deriveAgentIdentifiers('WebSocket');
    expect(result.id).toBe('websocket-agent');
    expect(result.folder).toBe('websocket-agent');
  });
});

describe('provisionAgent', () => {
  it('creates agent with defaults', () => {
    const created = makeAgent();
    const agentRepo = {
      create: vi.fn().mockReturnValue(created),
    } as unknown as AgentRepository;

    const result = provisionAgent({ agentRepo }, { channel: 'web' });

    expect(agentRepo.create).toHaveBeenCalledWith({
      id: 'web-agent',
      name: 'web agent',
      description: 'Auto-provisioned agent for the web channel.',
      folder: 'web-agent',
      channels: ['web'],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      systemPrompt: null,
      soul: null,
      toolPolicy: { preset: 'full' },
      mcpServers: ['cambot-agent', 'workflow-builder'],
    });
    expect(result).toBe(created);
  });

  it('passes custom provider and model', () => {
    const created = makeAgent({ provider: 'openai', model: 'gpt-4o' });
    const agentRepo = {
      create: vi.fn().mockReturnValue(created),
    } as unknown as AgentRepository;

    provisionAgent({ agentRepo }, {
      channel: 'web',
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4o',
        toolPolicy: { preset: 'full' },
        mcpServers: ['cambot-agent', 'workflow-builder'],
      }),
    );
  });

  it('passes custom systemPrompt and soul', () => {
    const created = makeAgent();
    const agentRepo = {
      create: vi.fn().mockReturnValue(created),
    } as unknown as AgentRepository;

    provisionAgent({ agentRepo }, {
      channel: 'web',
      systemPrompt: 'You are helpful.',
      soul: 'Friendly',
    });

    expect(agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You are helpful.',
        soul: 'Friendly',
      }),
    );
  });
});
