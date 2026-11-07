import { describe, expect, it } from 'vitest';
import { googleAuthService } from '../src/integrations/google-auth.service.js';
import { env } from '../src/config/env.js';

describe('Google ID token audience allowlist', () => {
  it('accepts the configured primary client ID', () => {
    expect(googleAuthService.isAllowedAudience(env.GOOGLE_WEB_CLIENT_ID)).toBe(true);
  });

  it('lists the web client ID as the audience', () => {
    const audiences = googleAuthService.allowedAudiences();

    expect(audiences).toEqual([env.GOOGLE_WEB_CLIENT_ID]);
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
