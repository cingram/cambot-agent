/**
 * Structured stderr logger for the agent runner.
 */

export interface Logger {
  log(message: string): void;
}

export class ConsoleLogger implements Logger {
  private readonly prefix: string;

  constructor(prefix = '[agent-runner]') {
    this.prefix = prefix;
  }

  log(message: string): void {
    console.error(`${this.prefix} ${message}`);
  }
}
