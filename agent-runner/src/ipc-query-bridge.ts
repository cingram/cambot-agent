/**
 * Bridges IPC polling to MessageStream during an active SDK query.
 * Uses AbortController for deterministic cleanup — no boolean flags.
 */
import type { IpcChannel } from './ipc-channel.js';
import type { MessageStream } from './message-stream.js';
import type { Logger } from './logger.js';
import { IPC_POLL_MS } from './types.js';

export interface BridgeResult {
  closedDuringQuery: boolean;
}

export class IpcQueryBridge {
  private readonly abortController = new AbortController();

  constructor(
    private readonly ipc: IpcChannel,
    private readonly stream: MessageStream,
    private readonly logger: Logger,
  ) {}

  /**
   * Start polling IPC for messages during a query.
   * Messages are pushed into the MessageStream.
   * If a close sentinel is detected, the stream is ended.
   */
  start(): { result: BridgeResult } {
    const bridgeResult: BridgeResult = { closedDuringQuery: false };
    const signal = this.abortController.signal;
    let currentTimer: ReturnType<typeof setTimeout> | null = null;

    // Single abort listener that clears whatever timer is active
    signal.addEventListener('abort', () => {
      if (currentTimer !== null) clearTimeout(currentTimer);
    }, { once: true });

    const poll = () => {
      if (signal.aborted) return;

      if (this.ipc.shouldClose()) {
        this.logger.log('Close sentinel detected during query, ending stream');
        bridgeResult.closedDuringQuery = true;
        this.stream.end();
        return;
      }

      const messages = this.ipc.drain();
      for (const text of messages) {
        this.logger.log(`Piping IPC message into active query (${text.length} chars)`);
        this.stream.push(text);
      }

      if (!signal.aborted) {
        currentTimer = setTimeout(poll, IPC_POLL_MS);
      }
    };

    // Start polling after a delay (the first message is already in the stream)
    currentTimer = setTimeout(poll, IPC_POLL_MS);

    return { result: bridgeResult };
  }

  /**
   * Stop polling. All pending timers are cancelled via AbortController.
   */
  stop(): void {
    this.abortController.abort();
  }
}
