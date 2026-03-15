import type http from 'http';

/** Result of authentication attempt. */
export interface AuthResult {
  authenticated: boolean;
  principalId?: string;
  reason?: string;
}

/** HTTP request auth strategy. */
export interface HttpAuthStrategy {
  authenticateRequest(req: http.IncomingMessage): AuthResult;
}

/** WebSocket upgrade auth strategy. */
export interface WsAuthStrategy {
  authenticateUpgrade(req: http.IncomingMessage, url: URL): AuthResult;
}

/** Combined auth provider. Both HTTP and WS auth + lifecycle. */
export interface AuthProvider extends HttpAuthStrategy, WsAuthStrategy {
  destroy(): void;
}
