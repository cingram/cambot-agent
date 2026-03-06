import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import type { Channel, ChannelAuditEvent } from '../types.js';

export interface FileConfig {
  baseDir: string;
  onAuditEvent?: (event: ChannelAuditEvent) => void;
}

/**
 * FileChannel — writes outbound messages to disk as files.
 *
 * JID scheme: `file:<relative-path>` where the path is relative to baseDir.
 * Used by the workflow service to deliver composed content to the filesystem
 * via the message bus, just like any other channel.
 */
export class FileChannel implements Channel {
  readonly name = 'file';

  private connected = false;
  private baseDir: string;
  private onAuditEvent?: (event: ChannelAuditEvent) => void;

  constructor(config: FileConfig) {
    this.baseDir = config.baseDir;
    this.onAuditEvent = config.onAuditEvent;
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    this.connected = true;
    logger.info({ baseDir: this.baseDir }, 'File channel connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const relativePath = jid.replace(/^file:/, '');

    if (path.isAbsolute(relativePath) || relativePath.includes('..')) {
      throw new Error(
        `File path must be relative and cannot contain "..": ${relativePath}`,
      );
    }

    const fullPath = path.join(this.baseDir, relativePath);
    const dir = path.dirname(fullPath);
    if (dir !== this.baseDir) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, text, 'utf-8');
    this.onAuditEvent?.({
      type: 'audit.delivery_result',
      channel: 'file',
      data: { chatJid: jid, accepted: true, durationMs: 0, filePath: relativePath },
    });
    logger.info({ path: relativePath }, 'File written');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('file:');
  }
}
