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
});
