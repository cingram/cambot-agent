/**
 * cambot-socket — barrel exports.
 *
 * TCP-based IPC transport replacing file-based polling.
 */

export { CambotSocketServer, type CambotSocketServerDeps } from './server.js';
export { CambotSocketConnection, type ConnectionIdentity, type PendingRequest } from './connection.js';
export { CommandRegistry, type FrameHandler } from './handlers/registry.js';
export type { SocketDeps } from './deps.js';
export { registerAllHandlers } from './register-all.js';
