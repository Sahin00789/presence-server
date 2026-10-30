import { createHmac, randomBytes } from 'node:crypto';

/**
 * Refresh tokens are opaque, high-entropy bearer secrets. They are deliberately
 * NOT derived from the access token (whose payload is only Base64URL-encoded and
 * therefore readable by anyone holding it).
 */
export const REFRESH_TOKEN_PREFIX = 'rt_';

/** Sliding lifetime of a refresh token: 3 months (90 days) from the last rotation. */
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * When a rotation response is lost in transit the client retries with the token
 * it still has on disk. That token is now the "previous" token, so a short
 * replay window is allowed. A replay outside this window is treated as theft.
 */
export const REFRESH_TOKEN_REUSE_GRACE_SECONDS = 30;

export interface IssuedRefreshToken {
  token: string;
  hash: string;
}

/**
 * Peppered hash persisted in `logged_devices`. The pepper is the server-side
 * `REFRESH_TOKEN_SECRET`, so a database leak alone cannot be used to derive a
 * usable refresh token.
 */
export function hashRefreshToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

export function generateRefreshToken(pepper: string): IssuedRefreshToken {
  const token = `${REFRESH_TOKEN_PREFIX}${randomBytes(48).toString('base64url')}`;
  return { token, hash: hashRefreshToken(token, pepper) };
}

/**
 * Rejects legacy `refresh:<userId>:<jti>` tokens (which were reconstructible
 * from an access token) and any malformed input before it reaches the database.
 */
export function isRefreshTokenFormat(token: string): boolean {
  if (!token.startsWith(REFRESH_TOKEN_PREFIX)) {
    return false;
  }
  const body = token.slice(REFRESH_TOKEN_PREFIX.length);
  return body.length >= 43 && /^[A-Za-z0-9_-]+$/.test(body);
}

export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}
