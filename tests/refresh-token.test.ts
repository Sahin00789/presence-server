import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  isRefreshTokenFormat,
  refreshTokenExpiry,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../src/modules/auth/refresh-token.js';

const PEPPER = 'test-refresh-pepper-with-at-least-32-chars';

describe('refresh token generation', () => {
  it('creates an opaque, prefixed token with 384 bits of entropy', () => {
    const { token } = generateRefreshToken(PEPPER);

    expect(token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    // 48 random bytes encode to 64 base64url characters.
    expect(token.slice(REFRESH_TOKEN_PREFIX.length)).toHaveLength(64);
    expect(isRefreshTokenFormat(token)).toBe(true);
  });

  it('never leaks the user id or session jti into the token', () => {
    const { token } = generateRefreshToken(PEPPER);
    const userId = '8a1f8f2c-3a5c-4f0f-9f4e-7a6b5c4d3e2f';
    const jti = '11111111-2222-3333-4444-555555555555';

    expect(token).not.toContain(userId);
    expect(token).not.toContain(jti);
    expect(token).not.toContain(':');
  });

  it('issues a unique token and hash on every call', () => {
    const first = generateRefreshToken(PEPPER);
    const second = generateRefreshToken(PEPPER);

    expect(first.token).not.toBe(second.token);
    expect(first.hash).not.toBe(second.hash);
  });

  it('hashes deterministically for the same pepper and differs across peppers', () => {
    const { token, hash } = generateRefreshToken(PEPPER);

    expect(hashRefreshToken(token, PEPPER)).toBe(hash);
    expect(hashRefreshToken(token, `${PEPPER}-other`)).not.toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('refresh token validation', () => {
  it('rejects legacy tokens that were derivable from an access token', () => {
    expect(
      isRefreshTokenFormat('refresh:8a1f8f2c-3a5c-4f0f-9f4e-7a6b5c4d3e2f:some-jti')
    ).toBe(false);
  });

  it('rejects short, padded and non-base64url payloads', () => {
    expect(isRefreshTokenFormat('rt_short')).toBe(false);
    expect(isRefreshTokenFormat(`rt_${'a'.repeat(42)}`)).toBe(false);
    expect(isRefreshTokenFormat(`rt_${'a'.repeat(63)}=`)).toBe(false);
    expect(isRefreshTokenFormat(`rt_${'a'.repeat(63)}+`)).toBe(false);
  });
});

describe('refresh token lifetime', () => {
  it('expires three months (90 days) after the rotation time', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = refreshTokenExpiry(issuedAt);

    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
    expect(expiresAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
});
