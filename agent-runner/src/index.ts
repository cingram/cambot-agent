/**
 * CamBot-Agent Agent Runner — Composition Root
 *
 * Wires all components together and starts the agent.
 * Business logic lives in the composed classes, not here.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDefaultContainerPaths, parseContainerInput } from './types.js';
import { ConsoleLogger } from './logger.js';
import { StdoutOutputWriter } from './output-writer.js';
import { IpcChannel } from './ipc-channel.js';
import { TelemetryCollector } from './telemetry-collector.js';
import { TranscriptArchiver } from './transcript-archiver.js';
import { HookFactory } from './hook-factory.js';
import { ContextBuilder } from './context-builder.js';
import { SdkQueryRunner } from './sdk-query-runner.js';
import { AgentRunner } from './agent-runner.js';
import { createHeartbeatWriter } from './heartbeat-writer.js';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const nodeStartTime = Date.now();
  const paths = createDefaultContainerPaths();
  const logger = new ConsoleLogger();
  const outputWriter = new StdoutOutputWriter();

  // Parse input from stdin
  let rawInput: Record<string, unknown>;
  try {
    const stdinData = await readStdin();
    rawInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync(paths.tempInputFile); } catch {
      // ENOENT expected if file doesn't exist
    }
  } catch (err: unknown) {
    outputWriter.write({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const containerInput = parseContainerInput(rawInput);
  logger.log(`Received input for group: ${containerInput.groupFolder} (node startup: ${Date.now() - nodeStartTime}ms)`);

  // Fork: custom agent path vs Claude SDK path
  if (containerInput.kind === 'custom') {
    const { runCustomAgent } = await import('./custom-agent-runner.js');
    await runCustomAgent(containerInput, outputWriter.write.bind(outputWriter), logger.log.bind(logger));
    return;
  }

  // Claude SDK path — build SDK env (merge secrets without touching process.env)
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  // Set up IPC channel
  const ipc = new IpcChannel(paths, logger);
  ipc.setOwnerToken(containerInput.ipcToken);

  if (containerInput.ipcToken && !ipc.isStillOwner()) {
    logger.log('Owner mismatch at startup — this container is an orphan, exiting');
    process.exit(0);
  }
  if (containerInput.ipcToken) {
    logger.log(`IPC owner token: ${containerInput.ipcToken.slice(0, 8)}...`);
  }

  ipc.initialize();

  // Set up heartbeat writer (host monitors this file for liveness)
  const heartbeat = createHeartbeatWriter(
    paths.heartbeatFile,
    containerInput.ipcToken || 'unknown',
  );

  // Wire dependency graph
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  const telemetry = new TelemetryCollector();
  const archiver = new TranscriptArchiver(paths, logger);
  const hookFactory = new HookFactory(telemetry, archiver, logger, heartbeat);
  const contextBuilder = new ContextBuilder(paths, logger);
  const queryRunner = new SdkQueryRunner(paths, logger, outputWriter, ipc, hookFactory, contextBuilder, telemetry, __dirname, heartbeat);
  const agentRunner = new AgentRunner(logger, outputWriter, ipc, queryRunner, {}, heartbeat);

  heartbeat.start();
  try {
    await agentRunner.run(containerInput, sdkEnv);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.log(`Agent error: ${errorMsg}`);
    outputWriter.write({
      status: 'error',
      result: null,
      error: errorMsg,
    });
    process.exit(1);
  } finally {
    heartbeat.stop();
  }
}

main();
