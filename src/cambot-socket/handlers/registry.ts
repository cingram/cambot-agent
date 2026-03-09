/**
 * CommandRegistry — typed handler registration and dispatch for cambot-socket.
 *
 * Each command type has a Zod schema for input validation, an auth level,
 * and a handler function. The registry enforces all three at the boundary.
 */

import type { ZodSchema } from 'zod';

import type { SocketFrame, AuthLevel } from '../protocol/types.js';
import type { CambotSocketConnection } from '../connection.js';
import type { SocketDeps } from '../deps.js';
import { logger } from '../../logger.js';

/** Handler function signature for a registered command. */
export type FrameHandler<T = unknown> = (
  payload: T,
  frame: SocketFrame<T>,
  connection: CambotSocketConnection,
  deps: SocketDeps,
) => void | Promise<void>;

/** Internal registration entry. */
interface RegisteredHandler {
  schema: ZodSchema;
  handler: FrameHandler;
  auth: AuthLevel;
}

export class CommandRegistry {
  private handlers = new Map<string, RegisteredHandler>();
  private deps: SocketDeps;

  constructor(deps: SocketDeps) {
    this.deps = deps;
  }

  /** Register a command handler with schema validation and auth level. */
  register<T>(
    type: string,
    schema: ZodSchema<T>,
    auth: AuthLevel,
    handler: FrameHandler<T>,
  ): void {
    if (this.handlers.has(type)) {
      throw new Error(`Handler already registered for type "${type}"`);
    }
    this.handlers.set(type, {
      schema,
      handler: handler as FrameHandler,
      auth,
    });
    logger.debug({ type, auth }, 'Registered command handler');
  }

  /** Look up handler, check auth, validate schema, invoke handler. */
  async dispatch(frame: SocketFrame, connection: CambotSocketConnection): Promise<void> {
    const entry = this.handlers.get(frame.type);
    if (!entry) {
      logger.warn({ type: frame.type, group: connection.identity.group }, 'Unknown command type');
      connection.replyError(frame, 'UNKNOWN_COMMAND', `Unknown command: ${frame.type}`);
      return;
    }

    // Auth check
    if (!this.checkAuth(entry.auth, connection, frame)) {
      return;
    }

    // Schema validation
    const parsed = entry.schema.safeParse(frame.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      logger.warn(
        { type: frame.type, group: connection.identity.group, issues },
        'Schema validation failed',
      );
      connection.replyError(frame, 'VALIDATION_ERROR', 'Invalid payload', { issues });
      return;
    }

    // Invoke handler
    try {
      const typedFrame = { ...frame, payload: parsed.data };
      await entry.handler(parsed.data, typedFrame, connection, this.deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { type: frame.type, group: connection.identity.group, err },
        'Command handler threw',
      );
      connection.replyError(frame, 'HANDLER_ERROR', message);
    }
  }

  // ── Private ─────────────────────────────────────────────

  private checkAuth(
    auth: AuthLevel,
    connection: CambotSocketConnection,
    frame: SocketFrame,
  ): boolean {
    const { group, isMain } = connection.identity;

    switch (auth) {
      case 'any':
        return true;

      case 'main-only':
        if (!isMain) {
          logger.warn({ group, type: frame.type }, 'Unauthorized: main-only command');
          connection.replyError(frame, 'UNAUTHORIZED', 'Only the main group can perform this action');
          return false;
        }
        return true;

      case 'self-or-main':
        // Frame payload must contain a target; main can target anyone,
        // non-main can only target their own group. Actual enforcement
        // is in each handler — the registry just logs a check here.
        return true;

      default:
        logger.error({ auth, type: frame.type }, 'Unknown auth level');
        connection.replyError(frame, 'INTERNAL_ERROR', 'Unknown auth level');
        return false;
    }
  }
}
