/**
 * Writes ContainerOutput to stdout wrapped in protocol markers.
 * The host process parses these markers to extract structured results.
 */
import type { ContainerOutput } from './types.js';
import { OUTPUT_START_MARKER, OUTPUT_END_MARKER } from './types.js';

export interface OutputWriter {
  write(output: ContainerOutput): void;
}

export class StdoutOutputWriter implements OutputWriter {
  write(output: ContainerOutput): void {
    console.log(OUTPUT_START_MARKER);
    console.log(JSON.stringify(output));
    console.log(OUTPUT_END_MARKER);
  }
}
