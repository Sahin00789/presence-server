import { describe, expect, it } from 'vitest';
import { googleAuthService } from '../src/integrations/google-auth.service.js';
import { env } from '../src/config/env.js';

describe('Google ID token audience allowlist', () => {
  it('accepts the configured primary client ID', () => {
    expect(googleAuthService.isAllowedAudience(env.GOOGLE_WEB_CLIENT_ID)).toBe(true);
  });

  it('accepts every configured extra client ID', () => {
    const extra = (env.GOOGLE_EXTRA_CLIENT_IDS ?? '')
      .split(',')
      .map((clientId) => clientId.trim())
      .filter(Boolean);

    for (const clientId of extra) {
      expect(googleAuthService.isAllowedAudience(clientId)).toBe(true);
    }
  });

  it('lists audiences without duplicates or blanks', () => {
    const audiences = googleAuthService.allowedAudiences();

    expect(audiences.length).toBeGreaterThan(0);
    expect(new Set(audiences).size).toBe(audiences.length);
    expect(audiences.every((clientId) => clientId.trim().length > 0)).toBe(true);
  });

  it('rejects an unknown client ID', () => {
    expect(googleAuthService.isAllowedAudience('someone-else.apps.googleusercontent.com')).toBe(
      false
    );
  });

  it('rejects a missing audience', () => {
    expect(googleAuthService.isAllowedAudience(undefined)).toBe(false);
  });
});
