/**
 * Writes ContainerOutput to the host via socket frames.
 * Replaces StdoutOutputWriter which used sentinel markers on stdout.
 */
import type { CambotSocketClient } from './cambot-socket-client.js';
import type { ContainerOutput } from './types.js';
import type { OutputWriter } from './output-writer.js';

export class SocketOutputWriter implements OutputWriter {
  constructor(private readonly client: CambotSocketClient) {}

  write(output: ContainerOutput): void {
    this.client.sendOutput({
      status: output.status,
      result: output.result,
      newSessionId: output.newSessionId,
      telemetry: output.telemetry,
    });
  }
}
