import { randomUUID, randomInt, createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { eq, and, gt, isNull, desc, inArray } from 'drizzle-orm';
import {
  OtpRequestInput,
  OtpVerifyInput,
  GoogleExchangeInput,
  GoogleOwnerRegistrationInput,
  RefreshTokenInput,
  OtpResponse,
  AuthResponse,
  AuthUser,
  LogoutResponse,
  LoggedDevice,
  LoggedDevicesResponse,
} from './schemas.js';
import { googleAuthService } from '../../integrations/google-auth.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { uploadToCloudinary } from '../../shared/services/cloudinary.service.js';
import { sendOtpEmail } from '../../shared/services/mail.service.js';
import { env } from '../../config/env.js';
import * as schema from '../../db/schema.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const OTP_TTL_MINUTES = 10;

export interface DeviceContext {
  deviceName?: string;
  deviceType?: string;
  osName?: string;
  ipAddress?: string;
  userAgent?: string;
}

export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function requestOtp(
  fastify: FastifyInstance,
  input: OtpRequestInput
): Promise<OtpResponse> {
  const email = input.email.toLowerCase().trim();
  const role = input.role || 'STAFF';

  // Generate 6-digit OTP code
  const code = randomInt(100000, 1_000_000).toString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  try {
    await fastify.db.insert(schema.otpRequests).values({
      email,
      role,
      codeHash: hashOtp(code),
      expiresAt,
    });
  } catch (err) {
    throw new AppError(
      'Unable to create an OTP request',
      500,
      'OTP_REQUEST_FAILED',
      undefined,
      { cause: err }
    );
  }

  // Deliver OTP code via Mail Service only in production
  if (env.NODE_ENV === 'production') {
    try {
      await sendOtpEmail({
        to: email,
        code,
        role,
        logger: fastify.log,
      });
    } catch (mailErr) {
      fastify.log.error({ err: mailErr, email }, 'Failed to send OTP email in production');
      throw new AppError(
        'Failed to deliver OTP email. Please check your mail server configuration or try again later.',
        500,
        'OTP_MAIL_DELIVERY_FAILED',
        undefined,
        { cause: mailErr }
      );
    }
  } else {
    fastify.log.info(
      { email, devOtp: code },
      '[Dev Mode] Skipping SMTP mail delivery. devOtp code generated and returned in response payload.'
    );
  }

  return {
    sent: true,
    email,
    expiresInSeconds: OTP_TTL_MINUTES * 60,
    ...(env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? { devOtp: code } : {}),
  };
}

export async function verifyOtp(
  fastify: FastifyInstance,
  input: OtpVerifyInput,
  deviceContext?: DeviceContext
): Promise<AuthResponse> {
  const email = input.email.toLowerCase().trim();
  const code = input.code.trim();
  const requestedRole = input.role || 'STAFF';

  const mergedDeviceContext: DeviceContext = {
    deviceName: input.deviceName || deviceContext?.deviceName,
    deviceType: input.deviceType || deviceContext?.deviceType,
    osName: input.osName || deviceContext?.osName,
    ipAddress: deviceContext?.ipAddress,
    userAgent: deviceContext?.userAgent,
  };

  // 1. Fetch active OTP request
  let otpRecord: typeof schema.otpRequests.$inferSelect | null = null;
  try {
    const [found] = await fastify.db
      .select()
      .from(schema.otpRequests)
      .where(
        and(
          eq(schema.otpRequests.email, email),
          isNull(schema.otpRequests.consumedAt),
          gt(schema.otpRequests.expiresAt, new Date())
        )
      )
      .orderBy(desc(schema.otpRequests.createdAt))
      .limit(1);

    otpRecord = found || null;
  } catch (err) {
    fastify.log.warn({ err }, 'DB lookup for OTP failed');
  }

  // Verify OTP code strictly against database record
  if (!otpRecord || otpRecord.codeHash !== hashOtp(code)) {
    throw new AppError('Invalid or expired OTP code', 400, 'INVALID_OTP');
  }

  // Mark OTP consumed
  if (otpRecord) {
    try {
      await fastify.db
        .update(schema.otpRequests)
        .set({ consumedAt: new Date() })
        .where(eq(schema.otpRequests.id, otpRecord.id));
    } catch {
      // Ignore update error
    }
  }

  let userId: string | null = null;
  let fullName = input.fullName || email.split('@')[0];

  // 2. Check if user exists in DB
  const [existingUser] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existingUser) {
    userId = existingUser.id;
    fullName = existingUser.fullName;
  }

  // 3. Check pending invitations if user does not exist
  if (!userId) {
    const [invitation] = await fastify.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.email, email),
          isNull(schema.invitations.acceptedAt),
          gt(schema.invitations.expiresAt, new Date())
        )
      )
      .limit(1);

    if (invitation) {
      const [newUser] = await fastify.db
        .insert(schema.users)
        .values({
          email,
          fullName,
          isActive: true,
        })
        .returning();

      userId = newUser.id;

      await fastify.db.insert(schema.memberships).values({
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
        isActive: true,
      });

      await fastify.db
        .update(schema.invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(schema.invitations.id, invitation.id));
    }
  }

  // 4. Handle non-existent user / uninvited account
  if (!userId) {
    if (requestedRole === 'OWNER') {
      // Check if registration wizard parameters were provided
      if (input.organizationName) {
        const [newOrg] = await fastify.db
          .insert(schema.organizations)
          .values({
            name: input.organizationName,
            timezone: input.timezone || 'Asia/Kolkata',
            currency: input.currency || 'INR',
          })
          .returning();

        const [newUser] = await fastify.db
          .insert(schema.users)
          .values({
            email,
            fullName,
            isActive: true,
          })
          .returning();

        userId = newUser.id;

        await fastify.db.insert(schema.memberships).values({
          organizationId: newOrg.id,
          userId,
          role: 'OWNER',
          isActive: true,
        });

        if (input.premisesName) {
          await fastify.db.insert(schema.premises).values({
            organizationId: newOrg.id,
            name: input.premisesName,
            latitude: '37.7749000',
            longitude: '-122.4194000',
            radiusMeters: input.radiusMeters || 50,
            isActive: true,
          });
        }
      } else {
        throw new AppError(
          'You are not registered. Please complete Owner & Organization Registration.',
          404,
          'NOT_REGISTERED_OWNER'
        );
      }
    } else {
      throw new AppError(
        'You are not registered. Please contact your Administrator to add you.',
        403,
        'NOT_REGISTERED_STAFF'
      );
    }
  }

  // Fetch active user record and membership
  const [userRecord] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!userRecord || !userRecord.isActive) {
    throw new AppError('This account has been deactivated', 403, 'ACCOUNT_DEACTIVATED');
  }

  const [membership] = await fastify.db
    .select({
      role: schema.memberships.role,
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationLogoUrl: schema.organizations.logoUrl,
    })
    .from(schema.memberships)
    .innerJoin(
      schema.organizations,
      eq(schema.memberships.organizationId, schema.organizations.id)
    )
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.isActive, true)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError('No active organization membership found', 403, 'NO_MEMBERSHIP');
  }

  return issueUserSession(fastify, {
    userId,
    googleSub: `email-sub-${userId}`,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    organizationLogoUrl: membership.organizationLogoUrl,
    email: userRecord.email,
    fullName: userRecord.fullName,
    avatarUrl: userRecord.avatarUrl,
    role: membership.role,
    deviceInfo: mergedDeviceContext,
  });
}

export async function processGoogleExchange(
  fastify: FastifyInstance,
  input: GoogleExchangeInput,
  deviceContext?: DeviceContext
): Promise<AuthResponse> {
  const mergedDeviceContext: DeviceContext = {
    deviceName: input.deviceName || deviceContext?.deviceName,
    deviceType: input.deviceType || deviceContext?.deviceType,
    osName: input.osName || deviceContext?.osName,
    ipAddress: deviceContext?.ipAddress,
    userAgent: deviceContext?.userAgent,
  };



  const googleProfile = await googleAuthService.exchangeCode(
    input.code,
    input.redirectUri ?? undefined,
    fastify.log
  );

  let userId: string | null = null;

  const [existingGoogleIdentity] = await fastify.db
    .select()
    .from(schema.googleIdentities)
    .where(eq(schema.googleIdentities.googleSub, googleProfile.googleSub))
    .limit(1);

  if (existingGoogleIdentity) {
    userId = existingGoogleIdentity.userId;
  } else {
    const [existingUser] = await fastify.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, googleProfile.email))
      .limit(1);

    if (existingUser) {
      userId = existingUser.id;
      await fastify.db.insert(schema.googleIdentities).values({
        userId,
        googleSub: googleProfile.googleSub,
        email: googleProfile.email,
      });
    }
  }

  if (!userId) {
    const [invitation] = await fastify.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.email, googleProfile.email),
          isNull(schema.invitations.acceptedAt),
          gt(schema.invitations.expiresAt, new Date())
        )
      )
      .limit(1);

    if (invitation) {
      const [newUser] = await fastify.db
        .insert(schema.users)
        .values({
          email: googleProfile.email,
          fullName: googleProfile.fullName,
          avatarUrl: googleProfile.picture,
          isActive: true,
        })
        .returning();

      userId = newUser.id;

      await fastify.db.insert(schema.googleIdentities).values({
        userId,
        googleSub: googleProfile.googleSub,
        email: googleProfile.email,
      });

      await fastify.db.insert(schema.memberships).values({
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
        isActive: true,
      });

      await fastify.db
        .update(schema.invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(schema.invitations.id, invitation.id));
    }
  }

  if (!userId) {
    throw new AppError(
      `No account is registered for ${googleProfile.email}. If you are an Owner, please register your organization first. For other roles, contact your administrator.`,
      403,
      'NOT_REGISTERED'
    );
  }

  const [userRecord] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!userRecord || !userRecord.isActive) {
    throw new AppError('This user account is deactivated', 403, 'ACCOUNT_DEACTIVATED');
  }

  const [membership] = await fastify.db
    .select({
      role: schema.memberships.role,
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationLogoUrl: schema.organizations.logoUrl,
    })
    .from(schema.memberships)
    .innerJoin(
      schema.organizations,
      eq(schema.memberships.organizationId, schema.organizations.id)
    )
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.isActive, true)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError('No active organization membership found', 403, 'NO_MEMBERSHIP');
  }

  return issueUserSession(fastify, {
    userId,
    googleSub: googleProfile.googleSub,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    organizationLogoUrl: membership.organizationLogoUrl,
    email: userRecord.email,
    fullName: userRecord.fullName,
    avatarUrl: userRecord.avatarUrl,
    role: membership.role,
    deviceInfo: mergedDeviceContext,
  });
}

export async function processGoogleOwnerRegistration(
  fastify: FastifyInstance,
  input: GoogleOwnerRegistrationInput,
  deviceContext?: DeviceContext
): Promise<AuthResponse> {
  const googleProfile = await googleAuthService.verifyIdToken(input.idToken, fastify.log);
  const [existingUser] = await fastify.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, googleProfile.email))
    .limit(1);

  if (existingUser) {
    throw new AppError(
      'An account already exists for this Google email. Sign in instead.',
      409,
      'ACCOUNT_ALREADY_REGISTERED'
    );
  }

  const [existingIdentity] = await fastify.db
    .select({ id: schema.googleIdentities.id })
    .from(schema.googleIdentities)
    .where(eq(schema.googleIdentities.googleSub, googleProfile.googleSub))
    .limit(1);

  if (existingIdentity) {
    throw new AppError(
      'This Google account is already linked. Sign in instead.',
      409,
      'GOOGLE_ACCOUNT_ALREADY_REGISTERED'
    );
  }

  const organization = await fastify.db.transaction(async (tx) => {
    const [createdOrganization] = await tx
      .insert(schema.organizations)
      .values({
        name: input.organizationName,
        timezone: input.timezone || 'Asia/Kolkata',
        currency: input.currency || 'INR',
      })
      .returning();

    const [createdUser] = await tx
      .insert(schema.users)
      .values({
        email: googleProfile.email,
        fullName: googleProfile.fullName,
        avatarUrl: googleProfile.picture,
        isActive: true,
      })
      .returning();

    await tx.insert(schema.googleIdentities).values({
      userId: createdUser.id,
      googleSub: googleProfile.googleSub,
      email: googleProfile.email,
    });

    await tx.insert(schema.memberships).values({
      organizationId: createdOrganization.id,
      userId: createdUser.id,
      role: 'OWNER',
      isActive: true,
    });

    await tx.insert(schema.premises).values({
      organizationId: createdOrganization.id,
      name: input.premisesName,
      latitude: '37.7749000',
      longitude: '-122.4194000',
      radiusMeters: input.radiusMeters || 50,
      isActive: true,
    });

    return { organization: createdOrganization, user: createdUser };
  });

  return issueUserSession(fastify, {
    userId: organization.user.id,
    googleSub: googleProfile.googleSub,
    organizationId: organization.organization.id,
    organizationName: organization.organization.name,
    email: organization.user.email,
    fullName: organization.user.fullName,
    avatarUrl: organization.user.avatarUrl,
    role: 'OWNER',
    deviceInfo: {
      deviceName: input.deviceName || deviceContext?.deviceName,
      deviceType: input.deviceType || deviceContext?.deviceType,
      osName: input.osName || deviceContext?.osName,
      ipAddress: deviceContext?.ipAddress,
      userAgent: deviceContext?.userAgent,
    },
  });
}

export async function processRefreshToken(
  fastify: FastifyInstance,
  input: RefreshTokenInput,
  deviceContext?: DeviceContext
): Promise<AuthResponse> {
  const presentedToken = input.refreshToken;

  let userId: string;
  let jti: string;

  if (presentedToken.startsWith('refresh:')) {
    const parts = presentedToken.split(':');
    if (parts.length !== 3) {
      throw new AppError('Invalid refresh token format', 401, 'INVALID_REFRESH_TOKEN');
    }
    userId = parts[1];
    jti = parts[2];
  } else {
    try {
      const decoded = fastify.jwt.decode<{ userId: string; jti: string }>(presentedToken);
      if (!decoded || !decoded.userId || !decoded.jti) {
        throw new AppError('Invalid refresh token payload', 401, 'INVALID_REFRESH_TOKEN');
      }
      userId = decoded.userId;
      jti = decoded.jti;
    } catch {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }
  }

  const [deviceRecord] = await fastify.db
    .select()
    .from(schema.loggedDevices)
    .where(eq(schema.loggedDevices.sessionJti, jti))
    .limit(1);

  if (!deviceRecord || !deviceRecord.isActive) {
    throw new AppError('Session expired or revoked on this device', 401, 'SESSION_EXPIRED');
  }

  if (deviceRecord.refreshTokenHash) {
    const expectedHash = hashRefreshToken(presentedToken);
    if (deviceRecord.refreshTokenHash !== expectedHash) {
      throw new AppError('Invalid refresh token hash', 401, 'INVALID_REFRESH_TOKEN');
    }
  }

  const [userRecord] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!userRecord || !userRecord.isActive) {
    throw new AppError('Account deactivated', 403, 'ACCOUNT_DEACTIVATED');
  }

  const [membership] = await fastify.db
    .select({
      role: schema.memberships.role,
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationLogoUrl: schema.organizations.logoUrl,
    })
    .from(schema.memberships)
    .innerJoin(
      schema.organizations,
      eq(schema.memberships.organizationId, schema.organizations.id)
    )
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.isActive, true)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError('No active membership found', 403, 'NO_MEMBERSHIP');
  }

  const mergedDeviceContext: DeviceContext = {
    deviceName: input.deviceName || deviceContext?.deviceName,
    deviceType: input.deviceType || deviceContext?.deviceType,
    osName: input.osName || deviceContext?.osName,
    ipAddress: deviceContext?.ipAddress,
    userAgent: deviceContext?.userAgent,
  };

  return issueUserSession(fastify, {
    userId,
    googleSub: `sub-${userId}`,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    organizationLogoUrl: membership.organizationLogoUrl,
    email: userRecord.email,
    fullName: userRecord.fullName,
    avatarUrl: userRecord.avatarUrl,
    role: membership.role,
    deviceInfo: mergedDeviceContext,
  });
}

export async function processGetCurrentUser(
  fastify: FastifyInstance,
  userId: string
): Promise<AuthUser> {
  const [userRecord] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!userRecord || !userRecord.isActive) {
    throw new AppError('User account not found', 404, 'USER_NOT_FOUND');
  }

  const [membership] = await fastify.db
    .select({
      role: schema.memberships.role,
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationLogoUrl: schema.organizations.logoUrl,
    })
    .from(schema.memberships)
    .innerJoin(
      schema.organizations,
      eq(schema.memberships.organizationId, schema.organizations.id)
    )
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.isActive, true)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError('No active membership found', 403, 'NO_MEMBERSHIP');
  }

  return {
    id: userRecord.id,
    email: userRecord.email,
    fullName: userRecord.fullName,
    role: membership.role,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    avatarUrl: userRecord.avatarUrl || null,
    organizationLogoUrl: membership.organizationLogoUrl || null,
  };
}

export async function processUpdateProfile(
  fastify: FastifyInstance,
  userId: string,
  input: {
    fullName?: string;
    phone?: string | null;
    avatar?: string;
    avatarUrl?: string | null;
  }
): Promise<AuthUser> {
  let newAvatarUrl = input.avatarUrl;

  if (input.avatar) {
    newAvatarUrl = await uploadToCloudinary(input.avatar, 'user-avatars');
  }

  await fastify.db
    .update(schema.users)
    .set({
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(newAvatarUrl !== undefined ? { avatarUrl: newAvatarUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, userId));

  return processGetCurrentUser(fastify, userId);
}

export async function processLogout(
  fastify: FastifyInstance,
  userId: string,
  jti: string
): Promise<LogoutResponse> {
  try {
    await fastify.db
      .update(schema.loggedDevices)
      .set({
        isActive: false,
        revokedAt: new Date(),
      })
      .where(
        and(
          eq(schema.loggedDevices.userId, userId),
          eq(schema.loggedDevices.sessionJti, jti)
        )
      );
  } catch (err) {
    fastify.log.warn({ err }, 'Error revoking logged_devices entry on logout');
  }

  return { loggedOut: true };
}

export async function processLogoutAll(
  fastify: FastifyInstance,
  userId: string
): Promise<LogoutResponse> {
  let revokedCount = 0;
  try {
    const activeDevices = await fastify.db
      .select({ id: schema.loggedDevices.id })
      .from(schema.loggedDevices)
      .where(
        and(
          eq(schema.loggedDevices.userId, userId),
          eq(schema.loggedDevices.isActive, true)
        )
      );
    revokedCount = activeDevices.length;

    await fastify.db
      .update(schema.loggedDevices)
      .set({
        isActive: false,
        revokedAt: new Date(),
      })
      .where(
        and(
          eq(schema.loggedDevices.userId, userId),
          eq(schema.loggedDevices.isActive, true)
        )
      );
  } catch (err) {
    fastify.log.warn({ err }, 'Error revoking logged_devices entries in logoutAll');
  }

  return { loggedOut: true, revokedSessions: revokedCount };
}

export async function processGetLoggedDevices(
  fastify: FastifyInstance,
  userId: string,
  currentJti?: string
): Promise<LoggedDevicesResponse> {
  const records = await fastify.db
    .select()
    .from(schema.loggedDevices)
    .where(eq(schema.loggedDevices.userId, userId))
    .orderBy(desc(schema.loggedDevices.lastActiveAt));

  const devices: LoggedDevice[] = records.map((rec) => ({
    id: rec.id,
    userId: rec.userId,
    sessionJti: rec.sessionJti,
    deviceName: rec.deviceName,
    deviceType: rec.deviceType,
    osName: rec.osName,
    ipAddress: rec.ipAddress,
    userAgent: rec.userAgent,
    isActive: rec.isActive,
    isCurrentDevice: Boolean(currentJti && rec.sessionJti === currentJti),
    lastActiveAt: rec.lastActiveAt.toISOString(),
    createdAt: rec.createdAt.toISOString(),
    revokedAt: rec.revokedAt ? rec.revokedAt.toISOString() : null,
  }));

  return { devices };
}

export async function processRevokeLoggedDevice(
  fastify: FastifyInstance,
  userId: string,
  deviceId: string
): Promise<LogoutResponse> {
  const [targetDevice] = await fastify.db
    .select()
    .from(schema.loggedDevices)
    .where(
      and(
        eq(schema.loggedDevices.id, deviceId),
        eq(schema.loggedDevices.userId, userId)
      )
    )
    .limit(1);

  if (!targetDevice) {
    throw new AppError('Device session not found', 404, 'DEVICE_NOT_FOUND');
  }

  if (targetDevice.isActive) {
    await fastify.db
      .update(schema.loggedDevices)
      .set({
        isActive: false,
        revokedAt: new Date(),
      })
      .where(eq(schema.loggedDevices.id, deviceId));
  }

  return { loggedOut: true };
}

async function issueUserSession(
  fastify: FastifyInstance,
  params: {
    userId: string;
    googleSub: string;
    organizationId: string;
    organizationName: string;
    organizationLogoUrl?: string | null;
    email: string;
    fullName: string;
    avatarUrl?: string | null;
    role: 'OWNER' | 'MANAGER' | 'STAFF';
    deviceInfo?: DeviceContext;
  }
): Promise<AuthResponse> {
  // Single active device rule for ALL roles: Automatically revoke all prior active device sessions
  try {
    await fastify.db
      .update(schema.loggedDevices)
      .set({
        isActive: false,
        revokedAt: new Date(),
      })
      .where(
        and(
          eq(schema.loggedDevices.userId, params.userId),
          eq(schema.loggedDevices.isActive, true)
        )
      );
  } catch (err) {
    fastify.log.warn({ err }, 'Error revoking prior device sessions in issueUserSession');
  }

  const jti = randomUUID();

  const payload = {
    userId: params.userId,
    googleSub: params.googleSub,
    organizationId: params.organizationId,
    role: params.role,
    jti,
  };

  const accessToken = fastify.jwt.sign(payload, { expiresIn: '15m' });
  const refreshToken = `refresh:${params.userId}:${jti}`;
  const refreshTokenHash = hashRefreshToken(refreshToken);

  try {
    await fastify.db.insert(schema.loggedDevices).values({
      userId: params.userId,
      sessionJti: jti,
      refreshTokenHash,
      deviceName: params.deviceInfo?.deviceName || null,
      deviceType: params.deviceInfo?.deviceType || null,
      osName: params.deviceInfo?.osName || null,
      ipAddress: params.deviceInfo?.ipAddress || null,
      userAgent: params.deviceInfo?.userAgent || null,
      isActive: true,
      lastActiveAt: new Date(),
    });

    // To reduce DB burden: keep up to 5 most recent logged_devices records per user for audit tracking, prune older ones
    const allUserDevices = await fastify.db
      .select({ id: schema.loggedDevices.id })
      .from(schema.loggedDevices)
      .where(eq(schema.loggedDevices.userId, params.userId))
      .orderBy(desc(schema.loggedDevices.lastActiveAt));

    if (allUserDevices.length > 5) {
      const excessDevices = allUserDevices.slice(5);
      const excessIds = excessDevices.map((d) => d.id);
      if (excessIds.length > 0) {
        await fastify.db
          .delete(schema.loggedDevices)
          .where(
            and(
              eq(schema.loggedDevices.userId, params.userId),
              inArray(schema.loggedDevices.id, excessIds)
            )
          );
      }
    }
  } catch (err) {
    fastify.log.warn({ err }, 'Error handling logged_devices entry or pruning excess history');
  }

  return {
    accessToken,
    expiresIn: 900,
    refreshToken,
    user: {
      id: params.userId,
      email: params.email,
      fullName: params.fullName,
      role: params.role,
      organizationId: params.organizationId,
      organizationName: params.organizationName,
      avatarUrl: params.avatarUrl || null,
      organizationLogoUrl: params.organizationLogoUrl || null,
    },
  };
}
