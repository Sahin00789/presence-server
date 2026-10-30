import { describe, expect, it } from 'vitest';
import { googleExchangeSchema } from '../src/modules/auth/schemas.js';

describe('Google exchange request schema', () => {
  it('accepts a null redirect URI from Android clients', () => {
    const parsed = googleExchangeSchema.safeParse({
      code: 'authorization-code',
      redirectUri: null,
    });

    expect(parsed.success).toBe(true);
  });

  it('still rejects an invalid non-null redirect URI', () => {
    const parsed = googleExchangeSchema.safeParse({
      code: 'authorization-code',
      redirectUri: 'not-a-url',
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts an Android ID token without a code', () => {
    const parsed = googleExchangeSchema.safeParse({
      idToken: 'google-id-token',
      deviceName: 'Pixel 8',
      deviceType: 'android',
      osName: 'Android 15',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a server-auth-code exchange with a PKCE verifier and no redirect URI', () => {
    const parsed = googleExchangeSchema.safeParse({
      code: 'authorization-code',
      codeVerifier: 'a'.repeat(43),
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a PKCE verifier shorter than the RFC 7636 minimum', () => {
    const parsed = googleExchangeSchema.safeParse({
      code: 'authorization-code',
      codeVerifier: 'too-short',
    });

    expect(parsed.success).toBe(false);
  });
});

