/**
 * Memory Cleanup — wipes SDK auto-memory for ephemeral/conversation-scoped agents.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/config.js';

/**
 * Remove the SDK auto-memory directory for an agent folder.
 * Used by ephemeral (before spawn) and conversation-scoped (on rotation).
 *
 * @param agentFolder - The agent's workspace folder name
 * @param sessionsBase - Override for the sessions base directory (for testing)
 */
export function cleanupSdkMemory(agentFolder: string, sessionsBase?: string): void {
  const base = sessionsBase ?? path.join(DATA_DIR, 'sessions');
  const memoryDir = path.join(
    base, agentFolder, '.claude', 'projects', '-workspace-group', 'memory',
  );

  try {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  } catch {
    // Directory doesn't exist or can't be removed — no-op
  }
}
