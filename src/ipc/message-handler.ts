import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { OutboundMessage } from '../bus/index.js';
import type { IpcDeps } from './watcher.js';

export async function processMessageFiles(
  messagesDir: string,
  ipcBaseDir: string,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  if (!fs.existsSync(messagesDir)) return;

  const messageFiles = fs
    .readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'));

  for (const file of messageFiles) {
    const filePath = path.join(messagesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.type === 'message' && data.chatJid && data.text) {
        // Authorization: verify this group can send to this chatJid
        const targetGroup = registeredGroups[data.chatJid];
        if (
          isMain ||
          (targetGroup && targetGroup.folder === sourceGroup)
        ) {
          await deps.messageBus.emit(new OutboundMessage('ipc', data.chatJid, data.text, { groupFolder: sourceGroup }));
          logger.info(
            { chatJid: data.chatJid, sourceGroup },
            'IPC message sent',
          );
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC message attempt blocked',
          );
        }
      }
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error(
        { file, sourceGroup, err },
        'Error processing IPC message',
      );
      const errorDir = path.join(ipcBaseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      fs.renameSync(
        filePath,
        path.join(errorDir, `${sourceGroup}-${file}`),
      );
    }
  }
}
