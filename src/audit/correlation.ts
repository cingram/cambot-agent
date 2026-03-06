/**
 * Deterministic correlation ID builders for audit event linking.
 *
 * Any handler can reconstruct the same ID from message data without
 * centralized ID generation.
 */

/** Message-level correlation: `{channel}:{chatJid}:{messageId}` */
export function buildCorrelationId(
  channel: string,
  chatJid: string,
  messageId?: string,
): string {
  return messageId
    ? `${channel}:${chatJid}:${messageId}`
    : `${channel}:${chatJid}`;
}

/** Webhook-level correlation (before messageId is known): `{channel}:webhook:{webhookId}` */
export function buildWebhookCorrelationId(
  channel: string,
  webhookId: string,
): string {
  return `${channel}:webhook:${webhookId}`;
}
