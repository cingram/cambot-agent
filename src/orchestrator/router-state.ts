import fs from 'fs';
import path from 'path';

import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from '../db/index.js';
import { resolveGroupFolderPath } from '../groups/group-folder.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import type { AvailableGroup } from '../container/snapshot-writers.js';

export class RouterState {
  private lastAgentTimestamp: Record<string, string> = {};
  private sessions: Record<string, string> = {};
  private registeredGroups: Record<string, RegisteredGroup> = {};

  load(): void {
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = getAllSessions();
    this.registeredGroups = getAllRegisteredGroups();
    logger.info(
      { groupCount: Object.keys(this.registeredGroups).length },
      'State loaded',
    );
  }

  save(): void {
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  getAgentTimestamp(jid: string): string {
    return this.lastAgentTimestamp[jid] || '';
  }

  setAgentTimestamp(jid: string, ts: string): void {
    this.lastAgentTimestamp[jid] = ts;
  }

  getSession(key: string): string | undefined {
    return this.sessions[key];
  }

  setSession(key: string, sessionId: string): void {
    this.sessions[key] = sessionId;
    setSession(key, sessionId);
  }

  getAllSessions(): Record<string, string> {
    return this.sessions;
  }

  getRegisteredGroups(): Record<string, RegisteredGroup> {
    return this.registeredGroups;
  }

  getRegisteredGroup(jid: string): RegisteredGroup | undefined {
    return this.registeredGroups[jid];
  }

  getRegisteredGroupByFolder(folder: string): RegisteredGroup | undefined {
    for (const group of Object.values(this.registeredGroups)) {
      if (group.folder === folder) return group;
    }
    return undefined;
  }

  registerGroup(jid: string, group: RegisteredGroup): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch (err) {
      logger.warn(
        { jid, folder: group.folder, err },
        'Rejecting group registration with invalid folder',
      );
      return;
    }

    setRegisteredGroup(jid, group);
    // Re-read from DB so in-memory state includes preserved containerConfig
    const updated = getAllRegisteredGroups();
    this.registeredGroups[jid] = updated[jid] ?? group;

    // Create group folder
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  }

  getAvailableGroups(): AvailableGroup[] {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(this.registeredGroups));

    return chats
      .filter((c) => c.jid !== '__group_sync__' && c.is_group)
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  /** @internal - for testing */
  _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
    this.registeredGroups = groups;
  }
}
