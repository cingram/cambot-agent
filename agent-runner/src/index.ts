/**
 * CamBot-Agent Agent Runner — Composition Root
 *
 * Wires all components together and starts the agent.
 * Business logic lives in the composed classes, not here.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   Socket: Follow-up messages arrive as message.input frames
 *
 * Output protocol:
 *   Results are sent as output frames over the cambot-socket TCP connection.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDefaultContainerPaths, parseContainerInput } from './types.js';
import { ConsoleLogger, SocketLogger } from './logger.js';
import { SocketOutputWriter } from './socket-output-writer.js';
import { CambotSocketClient } from './cambot-socket-client.js';
import { TelemetryCollector } from './telemetry-collector.js';
import { TranscriptArchiver } from './transcript-archiver.js';
import { HookFactory } from './hook-factory.js';
import { ContextBuilder } from './context-builder.js';
import { SdkQueryRunner } from './sdk-query-runner.js';
import { AgentRunner } from './agent-runner.js';
import { GuardrailReviewer } from './guardrail-reviewer.js';

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
    console.error(`Failed to parse input: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const containerInput = parseContainerInput(rawInput);
  logger.log(`Received input for group: ${containerInput.groupFolder} (node startup: ${Date.now() - nodeStartTime}ms)`);

  // Connect to cambot-socket server on the host
  const client = await CambotSocketClient.connect(
    'host.docker.internal',
    containerInput.socketPort,
    containerInput.groupFolder,
    containerInput.socketToken,
  );

  // Upgrade to structured socket logging — host receives log frames at correct levels
  const socketLogger = new SocketLogger(client, logger);
  socketLogger.log('Connected to cambot-socket server');

  const outputWriter = new SocketOutputWriter(client);

  // Fork: custom agent path vs Claude SDK path
  if (containerInput.kind === 'custom') {
    const { runCustomAgent } = await import('./custom-agent-runner.js');
    try {
      await runCustomAgent(containerInput, outputWriter.write.bind(outputWriter), socketLogger.log.bind(socketLogger));
    } finally {
      client.close();
    }
    return;
  }

  // Claude SDK path — build SDK env (merge secrets without touching process.env)
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  // Pass MCP socket credentials so the MCP stdio subprocess can authenticate.
  // The MCP process opens its own TCP connection with a separate one-time token.
  sdkEnv['CAMBOT_SOCKET_PORT'] = String(containerInput.socketPort);
  if (containerInput.mcpSocketToken) {
    sdkEnv['CAMBOT_SOCKET_TOKEN'] = containerInput.mcpSocketToken;
  }
  if (containerInput.mcpSocketGroup) {
    sdkEnv['CAMBOT_SOCKET_MCP_GROUP'] = containerInput.mcpSocketGroup;
  }

  // Start heartbeat
  client.startHeartbeat();

  // Wire dependency graph
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // Inline Haiku guardrail — reviews high-risk tool calls before execution
  const guardrailEnabled = containerInput.kind === 'claude'
    && (containerInput.guardrailEnabled ?? true);
  const apiKey = sdkEnv['ANTHROPIC_API_KEY'];
  const guardrail = guardrailEnabled && apiKey
    ? new GuardrailReviewer({ apiKey, logger: socketLogger })
    : undefined;
  if (guardrail) {
    socketLogger.log('Haiku guardrail enabled for inline tool review');
  } else if (!guardrailEnabled) {
    socketLogger.log('Haiku guardrail disabled by configuration');
  }

  const telemetry = new TelemetryCollector();
  const archiver = new TranscriptArchiver(paths, socketLogger);
  const hookFactory = new HookFactory(telemetry, archiver, socketLogger, client, guardrail);
  const contextBuilder = new ContextBuilder(paths, socketLogger);
  const queryRunner = new SdkQueryRunner(paths, socketLogger, outputWriter, client, hookFactory, contextBuilder, telemetry, __dirname, client);
  const agentRunner = new AgentRunner(socketLogger, outputWriter, client, queryRunner, {}, client);

  try {
    await agentRunner.run(containerInput, sdkEnv);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    socketLogger.error(`Agent error: ${errorMsg}`);
    outputWriter.write({
      status: 'error',
      result: null,
      error: errorMsg,
    });
    process.exit(1);
  } finally {
    client.stopHeartbeat();
    client.close();
  }
}

main();
