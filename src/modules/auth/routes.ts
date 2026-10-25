import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  otpRequestSchema,
  otpVerifySchema,
  googleExchangeSchema,
  googleOwnerRegistrationSchema,
  refreshTokenSchema,
  updateProfileSchema,
  otpResponseSchema,
  authResponseSchema,
  authUserSchema,
  logoutResponseSchema,
  loggedDevicesResponseSchema,
} from './schemas.js';
import {
  requestOtp,
  verifyOtp,
  processGoogleExchange,
  processGoogleOwnerRegistration,
  processRefreshToken,
  processGetCurrentUser,
  processUpdateProfile,
  processLogout,
  processLogoutAll,
  processGetLoggedDevices,
  processRevokeLoggedDevice,
  DeviceContext,
} from './service.js';

export async function authRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // Request Email OTP Route
  server.post(
    '/api/v1/auth/otp/request',
    {
      schema: {
        description: 'Requests a 6-digit email OTP. In development, includes devOtp in the response payload.',
        tags: ['Auth'],
        body: otpRequestSchema,
        response: {
          200: otpResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await requestOtp(fastify, request.body);
      return reply.send(result);
    }
  );

  // Verify Email OTP Route
  server.post(
    '/api/v1/auth/otp/verify',
    {
      schema: {
        description: 'Verifies the 6-digit email OTP code and authenticates the user',
        tags: ['Auth'],
        body: otpVerifySchema,
        response: {
          200: authResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deviceContext: DeviceContext = {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      };
      const result = await verifyOtp(fastify, request.body, deviceContext);
      return reply.send(result);
    }
  );

  // Google OAuth Exchange Route
  server.post(
    '/api/v1/auth/google/exchange',
    {
      schema: {
        description: 'Exchanges Google authorization code for JWT application tokens',
        tags: ['Auth'],
        body: googleExchangeSchema,
        response: {
          200: authResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deviceContext: DeviceContext = {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      };
      const result = await processGoogleExchange(fastify, request.body, deviceContext);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/auth/google/owner-registration',
    {
      schema: {
        description: 'Verifies a Google identity and creates an owner organization',
        tags: ['Auth'],
        body: googleOwnerRegistrationSchema,
        response: {
          200: authResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deviceContext: DeviceContext = {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      };
      const result = await processGoogleOwnerRegistration(fastify, request.body, deviceContext);
      return reply.send(result);
    }
  );

  // Refresh Token Route
  server.post(
    '/api/v1/auth/refresh',
    {
      schema: {
        description: 'Rotates refresh token and issues a new access token',
        tags: ['Auth'],
        body: refreshTokenSchema,
        response: {
          200: authResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deviceContext: DeviceContext = {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      };
      const result = await processRefreshToken(fastify, request.body, deviceContext);
      return reply.send(result);
    }
  );

  // Get Current Authenticated User Route
  server.get(
    '/api/v1/auth/me',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Returns profile details for the currently authenticated user',
        tags: ['Auth'],
        response: {
          200: authUserSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await processGetCurrentUser(fastify, request.user.userId);
      return reply.send(result);
    }
  );

  // Update Profile Route
  server.patch(
    '/api/v1/auth/me',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Update current user profile (fullName, phone, avatar)',
        tags: ['Auth'],
        body: updateProfileSchema,
        response: {
          200: authUserSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await processUpdateProfile(
        fastify,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  // Upload Profile Avatar Route
  server.post(
    '/api/v1/auth/me/avatar',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Upload profile picture/avatar (base64 string) to Cloudinary',
        tags: ['Auth'],
        body: z.object({ avatar: z.string() }),
        response: {
          200: authUserSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await processUpdateProfile(
        fastify,
        request.user.userId,
        { avatar: request.body.avatar }
      );
      return reply.send(result);
    }
  );

  // List Logged Devices Route
  server.get(
    '/api/v1/auth/devices',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Lists all logged devices and active session status for the authenticated user',
        tags: ['Auth'],
        response: {
          200: loggedDevicesResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await processGetLoggedDevices(
        fastify,
        request.user.userId,
        request.user.jti
      );
      return reply.send(result);
    }
  );

  // Revoke Specific Logged Device Route
  server.delete(
    '/api/v1/auth/devices/:deviceId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Revokes a specific logged device session by ID',
        tags: ['Auth'],
        params: z.object({
          deviceId: z.string().uuid(),
        }),
        response: {
          200: logoutResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const result = await processRevokeLoggedDevice(
        fastify,
        request.user.userId,
        deviceId
      );
      return reply.send(result);
    }
  );

  // Logout Active Session Route
  server.post(
    '/api/v1/auth/logout',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Revokes the active user session and marks device session inactive in DB',
        tags: ['Auth'],
        response: {
          200: logoutResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await processLogout(fastify, request.user.userId, request.user.jti);
      return reply.send(result);
    }
  );

  // Logout All User Sessions Route
  server.post(
    '/api/v1/auth/logout-all',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Revokes all active sessions for the authenticated user across all devices',
        tags: ['Auth'],
        response: {
          200: logoutResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await processLogoutAll(fastify, request.user.userId);
      return reply.send(result);
    }
  );
}
