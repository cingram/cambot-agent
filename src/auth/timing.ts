import { timingSafeEqual as nodeTimingSafeEqual, createHash } from 'node:crypto';

/** Constant-time string comparison to prevent timing attacks. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return nodeTimingSafeEqual(ha, hb);
}
