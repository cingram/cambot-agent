/**
 * OutputWriter interface for writing ContainerOutput to the host.
 * Implementations: SocketOutputWriter (TCP frames).
 */
import type { ContainerOutput } from './types.js';

export interface OutputWriter {
  write(output: ContainerOutput): void;
}
