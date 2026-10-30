import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('Auth route guards', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a Google exchange with neither an idToken nor a code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/google/exchange',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('MISSING_GOOGLE_CREDENTIAL');
  });

  it('rate limits repeated refresh attempts from the same IP', async () => {
    const statuses: number[] = [];

    for (let i = 0; i < 31; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: 'x'.repeat(48) },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
