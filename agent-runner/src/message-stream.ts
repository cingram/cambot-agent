/**
 * Push-based async iterable for streaming user messages to the SDK.
 * The SDK receives this as its prompt input, keeping isSingleUserTurn=false
 * so agent-teams subagents can run to completion.
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  /**
   * Return any messages pushed but never consumed by the SDK.
   * Used to recover messages from the race window at query end.
   */
  drain(): string[] {
    const texts: string[] = [];
    for (const msg of this.queue) {
      const text = typeof msg.message.content === 'string' ? msg.message.content : '';
      if (text) texts.push(text);
    }
    this.queue.length = 0;
    return texts;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}
