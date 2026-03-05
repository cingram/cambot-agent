/**
 * File-based IPC channel for communication between the host and the agent container.
 *
 * Manages:
 * - Polling for JSON message files in the input directory
 * - Owner token verification (orphan detection)
 * - Close sentinel detection
 * - Atomic drain+close to prevent message loss
 */
import fs from 'fs';
import path from 'path';
import type { ContainerPaths } from './types.js';
import { IPC_POLL_MS, IPC_WAIT_TIMEOUT_MS } from './types.js';
import type { Logger } from './logger.js';

export class IpcChannel {
  private ownerToken: string | undefined;

  constructor(
    private readonly paths: ContainerPaths,
    private readonly logger: Logger,
  ) {}

  setOwnerToken(token: string | undefined): void {
    this.ownerToken = token;
  }

  /**
   * Check whether this container is still the designated owner.
   * When a new container is spawned for the same group, the host
   * overwrites the _owner file with the new container's token.
   */
  isStillOwner(): boolean {
    if (!this.ownerToken) return true;
    try {
      const owner = fs.readFileSync(this.paths.ipcOwnerFile, 'utf-8').trim();
      return owner === this.ownerToken;
    } catch (err: unknown) {
      if (isEnoent(err)) return true;
      this.logger.log(`Owner check error: ${errorMessage(err)}`);
      return true;
    }
  }

  /**
   * Check for close sentinel or ownership revocation.
   */
  shouldClose(): boolean {
    if (fs.existsSync(this.paths.ipcCloseSentinel)) {
      try {
        fs.unlinkSync(this.paths.ipcCloseSentinel);
      } catch (err: unknown) {
        if (!isEnoent(err)) {
          this.logger.log(`Failed to remove close sentinel: ${errorMessage(err)}`);
        }
      }
      return true;
    }
    if (!this.isStillOwner()) {
      this.logger.log('Owner token changed — this container has been superseded, exiting');
      return true;
    }
    return false;
  }

  /**
   * Drain all pending IPC input messages from disk.
   * Messages are consumed (deleted) atomically per-file.
   */
  drain(): string[] {
    try {
      fs.mkdirSync(this.paths.ipcInputDir, { recursive: true });
      const files = fs.readdirSync(this.paths.ipcInputDir)
        .filter(f => f.endsWith('.json'))
        .sort();

      const messages: string[] = [];
      for (const file of files) {
        const filePath = path.join(this.paths.ipcInputDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.type === 'message' && data.text) {
            // Filter by container tag if present — don't consume other container's messages
            if (data.containerTag && this.ownerToken && data.containerTag !== this.ownerToken) {
              continue;
            }
            messages.push(data.text);
          }
          try {
            fs.unlinkSync(filePath);
          } catch (unlinkErr: unknown) {
            // ENOENT is expected on Windows Docker bind mounts after successful read
            if (!isEnoent(unlinkErr)) {
              this.logger.log(`Failed to unlink IPC file ${file}: ${errorMessage(unlinkErr)}`);
            }
          }
        } catch (err: unknown) {
          this.logger.log(`Failed to process input file ${file}: ${errorMessage(err)}`);
          try {
            fs.unlinkSync(filePath);
          } catch (unlinkErr: unknown) {
            if (!isEnoent(unlinkErr)) {
              this.logger.log(`Failed to unlink bad IPC file ${file}: ${errorMessage(unlinkErr)}`);
            }
          }
        }
      }
      return messages;
    } catch (err: unknown) {
      this.logger.log(`IPC drain error: ${errorMessage(err)}`);
      return [];
    }
  }

  /**
   * Atomically drain remaining messages and acknowledge close.
   * Prevents the race condition where messages arrive between drain and close detection.
   */
  drainAndClose(): string[] {
    const messages = this.drain();
    try {
      fs.unlinkSync(this.paths.ipcCloseSentinel);
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        this.logger.log(`Failed to clear close sentinel during drainAndClose: ${errorMessage(err)}`);
      }
    }
    return messages;
  }

  /**
   * Wait for a new IPC message or close signal.
   * Returns messages as a joined string, or null if closed/timed out.
   */
  waitForMessage(signal?: AbortSignal, timeoutMs = IPC_WAIT_TIMEOUT_MS): Promise<string | null> {
    return new Promise((resolve) => {
      let currentTimer: ReturnType<typeof setTimeout> | null = null;
      const startTime = Date.now();

      // Single abort listener that clears whatever timer is active
      const onAbort = () => {
        if (currentTimer !== null) clearTimeout(currentTimer);
        resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const poll = () => {
        if (signal?.aborted) {
          resolve(null);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          this.logger.log(`IPC wait timed out after ${timeoutMs}ms`);
          signal?.removeEventListener('abort', onAbort);
          resolve(null);
          return;
        }

        if (this.shouldClose()) {
          signal?.removeEventListener('abort', onAbort);
          resolve(null);
          return;
        }

        const messages = this.drain();
        if (messages.length > 0) {
          signal?.removeEventListener('abort', onAbort);
          resolve(messages.join('\n'));
          return;
        }

        currentTimer = setTimeout(poll, IPC_POLL_MS);
      };

      poll();
    });
  }

  /**
   * Ensure the IPC input directory exists and clean stale sentinels.
   */
  initialize(): void {
    fs.mkdirSync(this.paths.ipcInputDir, { recursive: true });
    try {
      fs.unlinkSync(this.paths.ipcCloseSentinel);
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        this.logger.log(`Failed to clean stale sentinel: ${errorMessage(err)}`);
      }
    }
  }
}

// ── Error helpers ───────────────────────────────────────────────────

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
