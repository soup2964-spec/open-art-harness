/**
 * ULID (https://github.com/ulid/spec): 48-bit ms timestamp + 80 random bits, Crockford base32,
 * 26 characters, lexicographically sortable by time. Used for dry-run file names so two
 * instances (or a restarted one) writing to the same bucket never collide.
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 2 ** 48 - 1) throw new Error(`ulid time out of range: ${ms}`);
  let out = '';
  let rest = ms;
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Buffer): string {
  // 80 bits -> 16 base32 characters.
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out = ALPHABET[Number(bits & 31n)]! + out;
    bits >>= 5n;
  }
  return out;
}

export function ulid(nowMs: number = Date.now(), random: (n: number) => Buffer = randomBytes): string {
  return encodeTime(nowMs) + encodeRandom(random(10));
}
