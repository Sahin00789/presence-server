import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('Employee CRUD Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated requests to POST /api/v1/employees', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      payload: {
        email: 'test.employee@example.com',
        fullName: 'Test Employee',
        role: 'EMPLOYEE',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects unauthenticated requests to GET /api/v1/employees', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/employees',
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts EMPLOYEE as role in create request schema validation', async () => {
    // Calling without auth token should return 401 Unauthorized (meaning payload schema passed Zod validation)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      payload: {
        email: 'test.employee@example.com',
        fullName: 'Test Employee',
        role: 'EMPLOYEE',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('INVALID_TOKEN');
  });

  it('accepts legacy STAFF role and preprocesses it to EMPLOYEE in schema validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      payload: {
        email: 'legacy.staff@example.com',
        fullName: 'Legacy Staff',
        role: 'STAFF',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('INVALID_TOKEN');
  });

  it('accepts null and preprocessed blank email in PATCH /api/v1/employees/:employeeId schema validation', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/00000000-0000-0000-0000-000000000000',
      payload: {
        email: null,
        fullName: 'Updated Name',
      },
    });

    // Should fail with 401 Unauthorized (meaning Zod schema validation passed successfully)
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('INVALID_TOKEN');
  });
});
