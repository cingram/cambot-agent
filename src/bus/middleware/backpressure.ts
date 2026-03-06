import type { BusMiddleware } from '../middleware.js';
import { logger } from '../../logger.js';

export interface BackpressureOptions {
  highWaterMark: number;
  strategy: 'drop' | 'warn';
  onBackpressure?: (inFlight: number) => void;
}

export function createBackpressureMiddleware(opts: BackpressureOptions): BusMiddleware {
  let inFlight = 0;

  return {
    name: 'backpressure',

    before() {
      inFlight++;

      if (inFlight > opts.highWaterMark) {
        opts.onBackpressure?.(inFlight);

        if (opts.strategy === 'drop') {
          inFlight--;
          return false;
        }

        logger.warn(
          { inFlight, highWaterMark: opts.highWaterMark },
          'Backpressure: in-flight events exceed high water mark',
        );
      }

      return undefined;
    },

    after() {
      if (inFlight > 0) inFlight--;
    },
  };
}
