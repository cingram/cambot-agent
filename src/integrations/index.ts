export type {
  IntegrationContext,
  IntegrationDefinition,
  IntegrationHandle,
  IntegrationManager,
  IntegrationType,
  McpServerEntry,
} from './types.js';

export { buildIntegrationDefinitions, mcpServerToDefinition } from './registry.js';
export { createIntegrationManager } from './manager.js';
