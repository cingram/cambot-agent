/**
 * Socket-based MCP Stdio Server for CamBot-Agent
 *
 * Standalone MCP stdio process that Claude SDK agent subprocesses inherit.
 * Tool registrations are split by domain into the mcp-tools/ directory.
 *
 * This file is the composition root: it reads environment context, connects
 * to the cambot-socket server, creates the MCP server, and delegates tool
 * registration to domain-specific modules.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CambotSocketClient } from './cambot-socket-client.js';
import type { McpToolContext } from './mcp-tools/types.js';
import { registerMessagingTools } from './mcp-tools/messaging-tools.js';
import { registerTaskTools } from './mcp-tools/task-tools.js';
import { registerGroupTools } from './mcp-tools/group-tools.js';
import { registerAgentTools } from './mcp-tools/agent-tools.js';
import { registerWorkflowTools } from './mcp-tools/workflow-tools.js';
import { registerWorkerTools } from './mcp-tools/worker-tools.js';
import { registerEmailTools } from './mcp-tools/email-tools.js';
import { registerIntegrationTools } from './mcp-tools/integration-tools.js';
import { registerContextTools } from './mcp-tools/context-tools.js';
import { registerNotificationTools } from './mcp-tools/notification-tools.js';
import { registerMaintenanceTools } from './mcp-tools/maintenance-tools.js';
import { registerImessageTools } from './mcp-tools/imessage-tools.js';

// ── Environment Context ─────────────────────────────────────────────

const chatJid = process.env.CAMBOT_AGENT_CHAT_JID!;
const groupFolder = process.env.CAMBOT_AGENT_GROUP_FOLDER!;
const isMain = process.env.CAMBOT_AGENT_IS_MAIN === '1';
const isInterAgentTarget = process.env.CAMBOT_AGENT_IS_INTERAGENT === '1';
const socketHost = process.env.CAMBOT_SOCKET_HOST || 'host.docker.internal';
const socketPort = parseInt(process.env.CAMBOT_SOCKET_PORT || '9800', 10);
const socketToken = process.env.CAMBOT_SOCKET_TOKEN!;
// MCP subprocess connects under its own group identity to avoid superseding
// the main agent's connection. Falls back to the main group if not provided.
const socketGroup = process.env.CAMBOT_SOCKET_MCP_GROUP || groupFolder;

// ── Socket Connection ───────────────────────────────────────────────

const client = await CambotSocketClient.connect(
  socketHost,
  socketPort,
  socketGroup,
  socketToken,
);

// ── MCP Server Setup ────────────────────────────────────────────────

const server = new McpServer({
  name: 'cambot-agent',
  version: '1.0.0',
});

// ── Register Tools by Domain ────────────────────────────────────────

const ctx: McpToolContext = {
  server,
  client,
  chatJid,
  groupFolder,
  isMain,
  isInterAgentTarget,
};

registerMessagingTools(ctx);
registerTaskTools(ctx);
registerGroupTools(ctx);
registerAgentTools(ctx);
registerWorkflowTools(ctx);
registerWorkerTools(ctx);
registerEmailTools(ctx);
registerIntegrationTools(ctx);
registerContextTools(ctx);
registerNotificationTools(ctx);
registerMaintenanceTools(ctx);
registerImessageTools(ctx);

// ── Start Transport ─────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
