/**
 * Container runtime abstraction for CamBot-Agent.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Returns the shell command to force-kill a container by name. */
export function killContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} kill ${name}`;
}

/**
 * List running cambot-agent containers, optionally filtered by group.
 * Handles Windows quoting: --format without shell quotes so cmd.exe
 * doesn't embed literal single-quote characters in the output.
 */
function listContainers(filterName = 'cambot-agent-'): string[] {
  const output = execSync(
    `${CONTAINER_RUNTIME_BIN} ps --filter name=${filterName} --format {{.Names}}`,
    { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
  );
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((name) => name.replace(/['"]/g, '')); // strip residual quotes
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10000 });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart CamBot-Agent                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned CamBot-Agent containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const orphans = listContainers();
    for (const name of orphans) {
      try {
        execSync(killContainer(name), { stdio: 'pipe', timeout: 10000 });
      } catch { /* already dead */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Killed orphaned containers');

      // Verify they're actually gone
      const survivors = listContainers();
      if (survivors.length > 0) {
        logger.warn(
          { count: survivors.length, names: survivors },
          'Some orphaned containers survived cleanup',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

/**
 * Kill all running containers for a specific group.
 * Called before spawning a new container to ensure at most one per group.
 */
export function killContainersForGroup(groupFolder: string): void {
  const safeName = groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  try {
    const containers = listContainers(`cambot-agent-${safeName}-`);
    for (const name of containers) {
      try {
        execSync(killContainer(name), { stdio: 'pipe', timeout: 10000 });
        logger.info({ group: groupFolder, container: name }, 'Killed stale group container');
      } catch { /* already dead */ }
    }
  } catch (err) {
    logger.warn({ err, group: groupFolder }, 'Failed to kill group containers');
  }
}

/**
 * Kill containers older than maxAgeMs.
 * Container names encode their spawn timestamp: cambot-agent-{name}-{timestamp}
 * This is safe to run periodically — it only kills stale containers.
 */
export function cleanupStaleContainers(maxAgeMs: number): void {
  try {
    const containers = listContainers();
    const now = Date.now();
    const stale: string[] = [];

    for (const name of containers) {
      // Extract timestamp from the last segment: cambot-agent-{name}-{timestamp}
      const match = name.match(/-(\d{13,})$/);
      if (!match) continue;
      const spawnedAt = parseInt(match[1], 10);
      if (now - spawnedAt > maxAgeMs) {
        stale.push(name);
      }
    }

    for (const name of stale) {
      try {
        execSync(killContainer(name), { stdio: 'pipe', timeout: 10000 });
      } catch { /* already dead */ }
    }

    if (stale.length > 0) {
      logger.info({ count: stale.length, names: stale, maxAgeMs }, 'Killed stale containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale containers');
  }
}
