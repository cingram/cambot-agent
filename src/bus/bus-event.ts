/** Abstract base for all bus events. Routing uses instanceof, not strings. */
export abstract class BusEvent {
  readonly source: string;
  readonly timestamp: string;
  cancelled = false;

  constructor(source: string) {
    this.source = source;
    this.timestamp = new Date().toISOString();
  }
}
