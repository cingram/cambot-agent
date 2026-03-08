/**
 * MCP tool registration: worker delegation and inter-agent communication.
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { extractReplyResult, mcpText, mcpError } from './helpers.js';

export function registerWorkerTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'delegate_to_worker',
    'Delegate a sub-task to a specialized worker agent. The worker runs independently and returns a result. Check available_workers.json for available worker IDs.',
    {
      worker_id: z.string().describe('Worker agent ID from available_workers.json'),
      prompt: z.string().describe('Task description for the worker'),
      context: z.string().optional().describe('Additional context from the conversation'),
    },
    async (args) => {
      try {
        const reply = await ctx.client.delegateWorker(args.worker_id, args.prompt, args.context);
        const { text, isError } = extractReplyResult(reply);
        if (isError) return mcpError(`Worker error: ${text}`);
        return mcpText(text);
      } catch {
        return mcpError('Worker delegation timed out after 5 minutes');
      }
    },
  );

  ctx.server.tool(
    'send_to_agent',
    'Send a message to another persistent agent and wait for its response. '
    + 'The target agent runs in its own container and returns a result. '
    + 'Use this for inter-agent communication (e.g., asking the email agent to draft a reply).',
    {
      target_agent: z.string().describe('The persistent agent ID (e.g., "email-agent", "test-agent")'),
      prompt: z.string().describe('The message/task to send to the target agent'),
    },
    async (args) => {
      if (ctx.isInterAgentTarget) {
        return mcpError('Inter-agent targets cannot use send_to_agent (prevents infinite loops).');
      }

      const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const reply = await ctx.client.sendToAgent(requestId, args.target_agent, args.prompt);
        const { text, isError } = extractReplyResult(reply);
        if (isError) return mcpError(`Agent error: ${text}`);
        return mcpText(text);
      } catch {
        return mcpError(`send_to_agent timed out after 5 minutes (target: ${args.target_agent})`);
      }
    },
  );
}
