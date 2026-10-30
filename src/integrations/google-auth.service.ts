import { env } from '../config/env.js';
import { AppError } from '../shared/errors/app-error.js';
import type { FastifyBaseLogger } from 'fastify';

export interface GoogleUserProfile {
  googleSub: string;
  email: string;
  fullName: string;
  picture: string | null;
}

export interface ExchangeCodeOptions {
  code: string;
  /**
   * Redirect URI of the browser flow. Android `requestServerAuthCode` codes are
   * bound to no redirect URI, so this must stay undefined for them.
   */
  redirectUri?: string;
  /** PKCE verifier for apps that generated a code challenge. */
  codeVerifier?: string;
  logger?: FastifyBaseLogger;
}

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export class GoogleAuthService {
  /** Client IDs whose ID tokens are accepted: the primary client plus any extra (Android/installed) clients. */
  allowedAudiences(): string[] {
    const extra = (env.GOOGLE_EXTRA_CLIENT_IDS ?? '')
      .split(',')
      .map((clientId) => clientId.trim())
      .filter(Boolean);

    return Array.from(new Set([env.GOOGLE_WEB_CLIENT_ID, ...extra].filter(Boolean)));
  }

  isAllowedAudience(audience?: string): boolean {
    return Boolean(audience) && this.allowedAudiences().includes(audience!);
  }

  /**
   * Exchanges an authorization code (browser redirect flow or Android
   * `requestServerAuthCode`) for a verified Google profile.
   */
  async exchangeCode({
    code,
    redirectUri,
    codeVerifier,
    logger,
  }: ExchangeCodeOptions): Promise<GoogleUserProfile> {
    if (!code) {
      throw new AppError('Google authorization code is required', 400, 'MISSING_CODE');
    }

    if (!env.GOOGLE_WEB_CLIENT_SECRET) {
      throw new AppError(
        'Google code exchange is not configured on this server. Use the idToken flow instead.',
        400,
        'CODE_EXCHANGE_NOT_CONFIGURED'
      );
    }

    const body = new URLSearchParams({
      code,
      client_id: env.GOOGLE_WEB_CLIENT_ID,
      client_secret: env.GOOGLE_WEB_CLIENT_SECRET,
      grant_type: 'authorization_code',
    });

    // Browser flows only. Sending a redirect_uri for an Android serverAuthCode
    // exchange makes Google answer with redirect_uri_mismatch.
    if (redirectUri) {
      body.set('redirect_uri', redirectUri);
    }
    if (codeVerifier) {
      body.set('code_verifier', codeVerifier);
    }

    try {
      const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });

      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();
        logger?.warn(
          { status: tokenResponse.status, errorBody, redirectUri: redirectUri ?? null },
          'Google OAuth code exchange failed at Google endpoint'
        );
        throw new AppError('Google authorization code exchange failed', 401, 'GOOGLE_AUTH_FAILED');
      }

      const tokenData = (await tokenResponse.json()) as { id_token?: string; access_token?: string };
      const idToken = tokenData.id_token;

      if (!idToken) {
        throw new AppError('Google did not return a verifiable identity token', 401, 'MISSING_ID_TOKEN');
      }

      return this.verifyIdToken(idToken, logger);
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      logger?.error({ err }, 'Unexpected error during Google OAuth authentication');
      throw new AppError('Failed to complete Google authentication', 500, 'GOOGLE_AUTH_ERROR');
    }
  }

  /**
   * Verifies a Google ID token issued to any of the configured client IDs.
   * This is the path used by Android Credential Manager / GoogleSignIn.
   */
  async verifyIdToken(
    idToken: string,
    logger?: FastifyBaseLogger
  ): Promise<GoogleUserProfile> {
    try {
      const verifyResponse = await fetch(
        `${GOOGLE_TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`
      );

      if (!verifyResponse.ok) {
        throw new AppError('Google ID token verification failed', 401, 'INVALID_ID_TOKEN');
      }

      const payload = (await verifyResponse.json()) as {
        sub?: string;
        email?: string;
        email_verified?: string | boolean;
        name?: string;
        picture?: string;
        aud?: string;
        iss?: string;
      };

      if (!payload.sub || !payload.email) {
        throw new AppError('Google did not return a usable account identity', 401, 'INVALID_PROFILE');
      }

      if (payload.iss && !GOOGLE_ISSUERS.has(payload.iss)) {
        logger?.warn({ iss: payload.iss }, 'Google token issuer mismatch');
        throw new AppError('Google ID token issuer is invalid', 401, 'INVALID_ISSUER');
      }

      if (payload.email_verified !== true && payload.email_verified !== 'true') {
        throw new AppError('Google account email is not verified', 401, 'EMAIL_NOT_VERIFIED');
      }

      if (!this.isAllowedAudience(payload.aud)) {
        logger?.warn(
          { aud: payload.aud, allowed: this.allowedAudiences() },
          'Google token audience mismatch'
        );
        throw new AppError('Google ID token audience is invalid', 401, 'INVALID_AUDIENCE');
      }

      const email = payload.email.toLowerCase().trim();
      return {
        googleSub: payload.sub,
        email,
        fullName: payload.name?.trim() || email.split('@')[0] || 'Google User',
        picture: payload.picture || null,
      };
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      logger?.error({ err }, 'Unexpected error verifying Google ID token');
      throw new AppError('Failed to verify Google identity', 500, 'GOOGLE_AUTH_ERROR');
    }
  }
}

export const googleAuthService = new GoogleAuthService();
