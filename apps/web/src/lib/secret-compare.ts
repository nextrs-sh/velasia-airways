/**
 * Milestone 9.3: compare a presented bearer token with the configured one without an early exit.
 *
 * The loop always walks the whole configured token and never stops at the first difference, so
 * the time taken does not depend on how much of a guess is right. It is plain JavaScript on
 * purpose: this runs on Node.js and on NextRS's embedded V8, where `node:crypto`'s
 * `timingSafeEqual` is not part of the validated surface.
 */
export function bearerMatches(header: string | null | undefined, token: string): boolean {
  const presented =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  let diff = presented.length ^ token.length;
  for (let i = 0; i < token.length; i += 1) {
    // Past the end of a shorter guess, charCodeAt is NaN: `| 0` keeps the walk the same length.
    diff |= (presented.charCodeAt(i) | 0) ^ token.charCodeAt(i);
  }
  return diff === 0;
}
