/**
 * Shared types and context for MCP tool registration modules.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CambotSocketClient } from '../cambot-socket-client.js';

export interface McpToolContext {
  server: McpServer;
  client: CambotSocketClient;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  isInterAgentTarget: boolean;
}
