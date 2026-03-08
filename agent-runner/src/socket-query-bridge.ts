/**
 * Bridges socket message delivery to MessageStream during an active SDK query.
 *
 * Replaces IpcQueryBridge — instead of polling files, uses
 * CambotSocketClient.waitForMessage() which resolves instantly
 * when a message.input frame arrives over the socket.
 *
 * Uses AbortController for deterministic cleanup.
 */
import type { CambotSocketClient } from './cambot-socket-client.js';
import type { MessageStream } from './message-stream.js';
import type { Logger } from './logger.js';

export interface BridgeResult {
  closedDuringQuery: boolean;
}

export class SocketQueryBridge {
  private readonly abortController = new AbortController();

  constructor(
    private readonly client: CambotSocketClient,
    private readonly stream: MessageStream,
    private readonly logger: Logger,
  ) {}

  /**
   * Start listening for messages during a query.
   * Messages are pushed into the MessageStream for the SDK to consume.
   * If the connection closes, the stream is ended.
   */
  start(): { result: BridgeResult } {
    const bridgeResult: BridgeResult = { closedDuringQuery: false };
    const signal = this.abortController.signal;

    this.pollLoop(bridgeResult, signal);

    return { result: bridgeResult };
  }

  /**
   * Stop listening. The abort signal cancels the pending waitForMessage.
   */
  stop(): void {
    this.abortController.abort();
  }

  // ── Internal ────────────────────────────────────────────────────

  private async pollLoop(result: BridgeResult, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const message = await this.client.waitForMessage(signal);

      if (signal.aborted) return;

      if (message === null) {
        // Connection closed or session ended during query
        this.logger.log('Socket closed during query, ending stream');
        result.closedDuringQuery = true;
        this.stream.end();
        return;
      }

      this.logger.log(`Piping socket message into active query (${message.length} chars)`);
      this.stream.push(message);
    }
  }
}
