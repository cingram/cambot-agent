/**
 * Structured logging for the agent runner.
 *
 * Logger interface supports levels so callers can distinguish
 * lifecycle events (info) from per-message chatter (debug).
 */
import type { CambotSocketClient } from './cambot-socket-client.js';
import type { LogLevel } from './cambot-socket/types.js';

export interface Logger {
  log(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Fallback logger that writes to stderr (captured by the host at debug level).
 * Used before the socket connection is established.
 */
export class ConsoleLogger implements Logger {
  private readonly prefix: string;

  constructor(prefix = '[agent-runner]') {
    this.prefix = prefix;
  }

  log(message: string): void { this.info(message); }
  debug(message: string): void { console.error(`${this.prefix} [debug] ${message}`); }
  info(message: string): void { console.error(`${this.prefix} ${message}`); }
  warn(message: string): void { console.error(`${this.prefix} [warn] ${message}`); }
  error(message: string): void { console.error(`${this.prefix} [error] ${message}`); }
}

/**
 * Forwards structured log frames over the cambot-socket TCP connection.
 * The host receives these and re-emits through pino at the correct level,
 * so agent lifecycle events show in the server console at info level.
 */
export class SocketLogger implements Logger {
  constructor(
    private readonly client: CambotSocketClient,
    private readonly fallback: ConsoleLogger = new ConsoleLogger(),
  ) {}

  log(message: string): void { this.info(message); }

  debug(message: string): void { this.emit('debug', message); }
  info(message: string): void { this.emit('info', message); }
  warn(message: string): void { this.emit('warn', message); }
  error(message: string): void { this.emit('error', message); }

  private emit(level: LogLevel, message: string): void {
    if (!this.client.isConnected()) {
      // Fall back to stderr if socket is gone
      this.fallback[level](message);
      return;
    }
    this.client.sendLog(level, message);
    // Also write to stderr so container log files capture everything
    this.fallback[level](message);
  }
}
