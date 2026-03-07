/**
 * Extract the canonical channel name from a JID string.
 *
 * Handles colon-prefixed JIDs (web:ui:conv1 → web, im:chat → imessage)
 * and WhatsApp JIDs (12345@g.us → whatsapp).
 */
export function channelFromJid(jid?: string): string {
  if (!jid) return 'unknown';
  if (jid.startsWith('web:')) return 'web';
  if (jid.startsWith('im:')) return 'imessage';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('cli:')) return 'cli';
  if (jid.startsWith('discord:')) return 'discord';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  const colonIdx = jid.indexOf(':');
  if (colonIdx > 0) return jid.slice(0, colonIdx);
  return 'unknown';
}
