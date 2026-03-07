import path from 'path';
import pino from 'pino';
import type { TransportTargetOptions } from 'pino';

const DEFAULT_LOG_FILE = path.join(
  path.resolve(process.cwd(), 'data'),
  'logs',
  'cambot-agent.log',
);

function resolveLogFile(): string | null {
  const envVal = process.env.LOG_FILE;
  if (envVal === 'false' || envVal === '0') return null;
  if (envVal) return path.resolve(envVal);
  return DEFAULT_LOG_FILE;
}

const logFile = resolveLogFile();
const level = process.env.LOG_LEVEL || 'info';

const targets: TransportTargetOptions[] = [
  { target: 'pino-pretty', options: { colorize: true }, level },
];

if (logFile) {
  targets.push({
    target: 'pino-roll',
    options: {
      file: logFile,
      frequency: 'daily',
      size: '50m',
      mkdir: true,
      limit: { count: 7 },
    },
    level,
  });
}

export const logger = pino({ level, transport: { targets } });

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
