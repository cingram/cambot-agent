/**
 * Persistent Agent Bootstrap — Creates workspace folders for registered agents.
 *
 * Each agent gets a directory under groups/ with a default CLAUDE.md if none exists.
 * Idempotent: safe to call on every startup.
 */
import fs from 'fs';
import path from 'path';

import type { RegisteredAgent } from '../types.js';
import { logger } from '../logger.js';

export interface PersistentAgentBootstrap {
  bootstrapAgent(agent: RegisteredAgent): void;
  bootstrapAll(agents: RegisteredAgent[]): void;
}

export function createPersistentAgentBootstrap(groupsDir: string): PersistentAgentBootstrap {
  function bootstrapAgent(agent: RegisteredAgent): void {
    const agentDir = path.join(groupsDir, agent.folder);
    fs.mkdirSync(agentDir, { recursive: true });

    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const content = `# ${agent.name}\n\n${agent.description}\n`;
      fs.writeFileSync(claudeMdPath, content, 'utf-8');
      logger.info({ agentId: agent.id, folder: agent.folder }, 'Created default CLAUDE.md for agent');
    }
  }

  return {
    bootstrapAgent,

    bootstrapAll(agents: RegisteredAgent[]): void {
      for (const agent of agents) {
        bootstrapAgent(agent);
      }
    },
  };
}
