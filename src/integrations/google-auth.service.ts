import { env } from '../config/env.js';
import { AppError } from '../shared/errors/app-error.js';
import type { FastifyBaseLogger } from 'fastify';

export interface GoogleUserProfile {
  googleSub: string;
  email: string;
  fullName: string;
  picture: string | null;
}

export class GoogleAuthService {
  /**
   * Exchanges authorization code for Google ID token and returns verified profile.
   */
  async exchangeCode(
    code: string,
    redirectUri?: string,
    logger?: FastifyBaseLogger
  ): Promise<GoogleUserProfile> {
    if (!code) {
      throw new AppError('Google authorization code is required', 400, 'MISSING_CODE');
    }

    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_WEB_CLIENT_ID,
          client_secret: env.GOOGLE_WEB_CLIENT_SECRET,
          redirect_uri: redirectUri || env.GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();
        logger?.warn({ errorBody }, 'Google OAuth code exchange failed at Google endpoint');
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

  async verifyIdToken(
    idToken: string,
    logger?: FastifyBaseLogger
  ): Promise<GoogleUserProfile> {
    try {
      const verifyResponse = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
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
      };

      if (!payload.sub || !payload.email) {
        throw new AppError('Google did not return a usable account identity', 401, 'INVALID_PROFILE');
      }

      if (payload.email_verified !== true && payload.email_verified !== 'true') {
        throw new AppError('Google account email is not verified', 401, 'EMAIL_NOT_VERIFIED');
      }

      if (payload.aud !== env.GOOGLE_WEB_CLIENT_ID) {
        logger?.warn(
          { aud: payload.aud, expected: env.GOOGLE_WEB_CLIENT_ID },
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
