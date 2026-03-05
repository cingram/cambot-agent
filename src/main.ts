import { CamBotApp } from './orchestrator/app.js';
import { logger } from './logger.js';

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  new CamBotApp().start().catch((err) => {
    logger.error({ err }, 'Failed to start CamBot-Agent');
    process.exit(1);
  });
}
