import { randomUUID, randomInt, createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { eq, and, or, gt, isNull, desc, inArray, sql } from 'drizzle-orm';
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
import {
  googleAuthService,
  GoogleUserProfile,
} from '../../integrations/google-auth.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { uploadToCloudinary } from '../../shared/services/cloudinary.service.js';
import { sendOtpEmail } from '../../shared/services/mail.service.js';
import { env } from '../../config/env.js';
import * as schema from '../../db/schema.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  isRefreshTokenFormat,
  refreshTokenExpiry,
  REFRESH_TOKEN_REUSE_GRACE_SECONDS,
} from './refresh-token.js';

const OTP_TTL_MINUTES = 10;

/** Wrong guesses allowed against a single OTP before it is burned. */
const OTP_MAX_ATTEMPTS = 5;

export interface DeviceContext {
  deviceName?: string;
  deviceType?: string;
  osName?: string;
  ipAddress?: string;
  userAgent?: string;
}

function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

interface ActiveMembership {
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  organizationId: string;
  organizationName: string;
  organizationLogoUrl: string | null;
  premisesId?: string | null;
  premisesName?: string | null;
}

/**
 * Resolves the caller's active organization context from the authoritative
 * sources in the new schema: `organizations.owner_user_id` for Owners and
 * `employees` for Managers/Staff. When `organizationId` is omitted the first
 * active context is returned (used by refresh-token and profile calls).
 */
async function resolveActiveMembership(
  fastify: FastifyInstance,
  userId: string,
  organizationId?: string
): Promise<ActiveMembership | null> {
  const ownerFilters = [eq(schema.organizations.ownerUserId, userId)];
  if (organizationId) {
    ownerFilters.push(eq(schema.organizations.id, organizationId));
  }

  const [ownedOrganization] = await fastify.db
    .select({
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationLogoUrl: schema.organizations.logoUrl,
    })
    .from(schema.organizations)
    .where(and(...ownerFilters))
    .limit(1);

  if (ownedOrganization) {
    return { role: 'OWNER', premisesId: null, premisesName: null, ...ownedOrganization };
  }

  const employeeFilters = [
    eq(schema.employees.userId, userId),
    eq(schema.employees.isActive, true),
  ];
  if (organizationId) {
    employeeFilters.push(eq(schema.employees.organizationId, organizationId));
  }

  const [employee] = await fastify.db
    .select({
      role: schema.employees.role,
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationLogoUrl: schema.organizations.logoUrl,
      premisesId: schema.employees.premisesId,
      premisesName: schema.premises.name,
    })
    .from(schema.employees)
    .innerJoin(
      schema.organizations,
      eq(schema.employees.organizationId, schema.organizations.id)
    )
    .leftJoin(
      schema.premises,
      eq(schema.employees.premisesId, schema.premises.id)
    )
    .where(and(...employeeFilters))
    .limit(1);

  if (employee) {
    return employee;
  }

  return null;
}

export async function requestOtp(
  fastify: FastifyInstance,
  input: OtpRequestInput
): Promise<OtpResponse> {
  const email = input.email.toLowerCase().trim();
  const role = input.role || 'STAFF';

  // Role Account Verification & Access Rules:
  // Unregistered Manager / Staff must be refused sign-in with explicit message.
  if (role === 'MANAGER' || role === 'STAFF') {
    const [userRecord] = await fastify.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    let isEmployee = false;
    if (userRecord) {
      const [employeeRecord] = await fastify.db
        .select({ id: schema.employees.id })
        .from(schema.employees)
        .where(eq(schema.employees.userId, userRecord.id))
        .limit(1);
      if (employeeRecord) {
        isEmployee = true;
      }
    }

    if (!isEmployee) {
      throw new AppError(
        'You are not registered. Staff and Managers must be added and invited by the Organization Owner.',
        403,
        'NOT_REGISTERED'
      );
    }
  }

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

  // Deliver OTP code via Mail Service asynchronously in production
  if (env.NODE_ENV === 'production') {
    setImmediate(() => {
      sendOtpEmail({
        to: email,
        code,
        role,
        logger: fastify.log,
      }).catch((mailErr) => {
        fastify.log.error({ err: mailErr, email }, 'Failed to send OTP email in production');
      });
    });
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

  // Verify OTP code strictly against database record. The `attempts` counter is
  // persisted so a 6-digit code cannot be brute-forced by replaying guesses.
  if (!otpRecord) {
    throw new AppError('Invalid or expired OTP code', 400, 'INVALID_OTP');
  }

  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
    throw new AppError(
      'Too many incorrect attempts for this code. Request a new OTP.',
      429,
      'OTP_ATTEMPTS_EXCEEDED'
    );
  }

  if (otpRecord.codeHash !== hashOtp(code)) {
    const nextAttempts = otpRecord.attempts + 1;
    const exhausted = nextAttempts >= OTP_MAX_ATTEMPTS;

    const [failedAttempt] = await fastify.db
      .update(schema.otpRequests)
      .set({
        attempts: sql`${schema.otpRequests.attempts} + 1`,
        ...(exhausted ? { consumedAt: new Date() } : {}),
      })
      .where(eq(schema.otpRequests.id, otpRecord.id))
      .returning({ attempts: schema.otpRequests.attempts });

    const attemptsLeft = Math.max(0, OTP_MAX_ATTEMPTS - (failedAttempt?.attempts ?? nextAttempts));

    if (exhausted) {
      fastify.log.warn({ email }, 'OTP burned after too many incorrect attempts');
      throw new AppError(
        'Too many incorrect attempts. Request a new OTP.',
        429,
        'OTP_ATTEMPTS_EXCEEDED'
      );
    }

    throw new AppError(
      `Invalid or expired OTP code. ${attemptsLeft} attempt(s) remaining.`,
      400,
      'INVALID_OTP',
      { attemptsRemaining: attemptsLeft }
    );
  }

  // Mark OTP consumed so the same code cannot be replayed
  try {
    await fastify.db
      .update(schema.otpRequests)
      .set({ consumedAt: new Date() })
      .where(eq(schema.otpRequests.id, otpRecord.id));
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to mark OTP as consumed');
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

  let membership = userId ? await resolveActiveMembership(fastify, userId) : null;

  // 3. Handle non-existent user or user without active membership
  if (!membership) {
    if (requestedRole === 'OWNER') {
      if (input.organizationName) {
        const createdUserAndOrg = await fastify.db.transaction(async (tx) => {
          let uId = userId;
          let uName = fullName;
          if (!uId) {
            const [newUser] = await tx
              .insert(schema.users)
              .values({
                email,
                fullName: input.fullName || email.split('@')[0],
                isActive: true,
              })
              .returning();
            uId = newUser.id;
            uName = newUser.fullName;
          }

          const [newOrg] = await tx
            .insert(schema.organizations)
            .values({
              ownerUserId: uId,
              name: input.organizationName!,
              timezone: input.timezone || 'Asia/Kolkata',
              currency: input.currency || 'INR',
            })
            .returning();

          if (input.premisesName) {
            await tx.insert(schema.premises).values({
              organizationId: newOrg.id,
              name: input.premisesName,
              address: input.premisesAddress,
              latitude: input.latitude || '0.0000000',
              longitude: input.longitude || '0.0000000',
              radiusMeters: input.radiusMeters || 50,
              isActive: true,
            });
          }

          return { userId: uId, fullName: uName };
        });

        userId = createdUserAndOrg.userId;
        fullName = createdUserAndOrg.fullName;
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

  // Fetch active user record and resolve the authoritative organization role.
  const [userRecord] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId!))
    .limit(1);

  if (!userRecord || !userRecord.isActive) {
    throw new AppError('This account has been deactivated', 403, 'ACCOUNT_DEACTIVATED');
  }

  membership = await resolveActiveMembership(fastify, userId!);
  if (!membership) {
    throw new AppError('No active organization membership found', 403, 'NO_MEMBERSHIP');
  }

  return issueUserSession(fastify, {
    userId: userId!,
    googleSub: `email-sub-${userId!}`,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    organizationLogoUrl: membership.organizationLogoUrl,
    premisesId: membership.premisesId,
    premisesName: membership.premisesName,
    email: userRecord.email,
    fullName: userRecord.fullName,
    avatarUrl: userRecord.avatarUrl,
    role: membership.role,
    deviceInfo: mergedDeviceContext,
  });
}

/**
 * Resolves the caller's Google identity from either an ID token (Android
 * Credential Manager / GoogleSignIn) or an authorization code (web redirect or
 * Android `requestServerAuthCode`).
 */
async function resolveGoogleProfile(
  fastify: FastifyInstance,
  input: GoogleExchangeInput
): Promise<GoogleUserProfile> {
  if (input.idToken) {
    return googleAuthService.verifyIdToken(input.idToken, fastify.log);
  }

  if (input.code) {
    return googleAuthService.exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri ?? undefined,
      codeVerifier: input.codeVerifier,
      logger: fastify.log,
    });
  }

  throw new AppError(
    'Provide a Google idToken or authorization code',
    400,
    'MISSING_GOOGLE_CREDENTIAL'
  );
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
  const googleProfile = await resolveGoogleProfile(fastify, input);


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

  const membership = await resolveActiveMembership(fastify, userId);
  if (!membership) {
    throw new AppError('No active organization membership found', 403, 'NO_MEMBERSHIP');
  }

  return issueUserSession(fastify, {
    userId,
    googleSub: googleProfile.googleSub,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    organizationLogoUrl: membership.organizationLogoUrl,
    premisesId: membership.premisesId,
    premisesName: membership.premisesName,
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
    const [createdUser] = await tx
      .insert(schema.users)
      .values({
        email: googleProfile.email,
        fullName: googleProfile.fullName,
        avatarUrl: googleProfile.picture,
        isActive: true,
      })
      .returning();

    const [createdOrganization] = await tx
      .insert(schema.organizations)
      .values({
        ownerUserId: createdUser.id,
        name: input.organizationName || 'My Organization',
        timezone: input.timezone || 'Asia/Kolkata',
        currency: input.currency || 'INR',
      })
      .returning();

    await tx.insert(schema.googleIdentities).values({
      userId: createdUser.id,
      googleSub: googleProfile.googleSub,
      email: googleProfile.email,
    });

    await tx.insert(schema.premises).values({
      organizationId: createdOrganization.id,
      name: input.premisesName || 'Main Premises',
      address: input.premisesAddress,
      latitude: input.latitude || '0.0000000',
      longitude: input.longitude || '0.0000000',
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

type RefreshRotationOutcome =
  | {
      status: 'rotated';
      deviceId: string;
      userId: string;
      sessionJti: string;
      refreshToken: string;
    }
  | { status: 'invalid' }
  | { status: 'inactive' }
  | { status: 'expired' }
  | { status: 'reuse' };

/**
 * Atomically exchanges a refresh token for a brand new one.
 *
 * The session row is locked with `SELECT ... FOR UPDATE`, so two concurrent
 * refreshes can never both rotate the same token. The token that was just
 * replaced is retained as `previousRefreshTokenHash`; presenting it again
 * outside a short grace window is treated as token theft and revokes the
 * session. All state changes are committed before any error is thrown so a
 * detected replay cannot be rolled back.
 */
async function rotateRefreshToken(
  fastify: FastifyInstance,
  presentedToken: string,
  deviceContext?: DeviceContext
): Promise<RefreshRotationOutcome> {
  const presentedHash = hashRefreshToken(presentedToken, env.REFRESH_TOKEN_SECRET);

  return fastify.db.transaction(async (tx) => {
    const [device] = await tx
      .select()
      .from(schema.loggedDevices)
      .where(
        or(
          eq(schema.loggedDevices.refreshTokenHash, presentedHash),
          eq(schema.loggedDevices.previousRefreshTokenHash, presentedHash)
        )
      )
      .limit(1)
      .for('update');

    if (!device) {
      return { status: 'invalid' } as const;
    }

    const now = new Date();

    if (!device.isActive) {
      return { status: 'inactive' } as const;
    }

    if (device.expiresAt.getTime() <= now.getTime()) {
      await tx
        .update(schema.loggedDevices)
        .set({ isActive: false, revokedAt: now, revokedReason: 'EXPIRED' })
        .where(eq(schema.loggedDevices.id, device.id));
      return { status: 'expired' } as const;
    }

    const isReplay = device.previousRefreshTokenHash === presentedHash;
    if (isReplay) {
      const rotatedAt = device.previousRotatedAt?.getTime() ?? 0;
      const withinGrace =
        now.getTime() - rotatedAt <= REFRESH_TOKEN_REUSE_GRACE_SECONDS * 1000;

      if (!withinGrace) {
        await tx
          .update(schema.loggedDevices)
          .set({
            isActive: false,
            revokedAt: now,
            revokedReason: 'REFRESH_TOKEN_REUSE',
          })
          .where(eq(schema.loggedDevices.id, device.id));

        fastify.log.warn(
          { userId: device.userId, sessionJti: device.sessionJti },
          'Refresh token reuse detected; session revoked'
        );
        return { status: 'reuse' } as const;
      }
    }

    const nextToken = generateRefreshToken(env.REFRESH_TOKEN_SECRET);
    const [updated] = await tx
      .update(schema.loggedDevices)
      .set({
        refreshTokenHash: nextToken.hash,
        previousRefreshTokenHash: device.refreshTokenHash,
        previousRotatedAt: now,
        expiresAt: refreshTokenExpiry(now),
        lastActiveAt: now,
        deviceName: deviceContext?.deviceName || device.deviceName,
        deviceType: deviceContext?.deviceType || device.deviceType,
        osName: deviceContext?.osName || device.osName,
        ipAddress: deviceContext?.ipAddress || device.ipAddress,
        userAgent: deviceContext?.userAgent || device.userAgent,
      })
      .where(
        and(
          eq(schema.loggedDevices.id, device.id),
          eq(schema.loggedDevices.isActive, true)
        )
      )
      .returning({ id: schema.loggedDevices.id });

    if (!updated) {
      return { status: 'inactive' } as const;
    }

    return {
      status: 'rotated',
      deviceId: device.id,
      userId: device.userId,
      sessionJti: device.sessionJti,
      refreshToken: nextToken.token,
    } as const;
  });
}

export async function processRefreshToken(
  fastify: FastifyInstance,
  input: RefreshTokenInput,
  deviceContext?: DeviceContext
): Promise<AuthResponse> {
  const presentedToken = input.refreshToken.trim();

  if (!isRefreshTokenFormat(presentedToken)) {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }

  const mergedDeviceContext: DeviceContext = {
    deviceName: input.deviceName || deviceContext?.deviceName,
    deviceType: input.deviceType || deviceContext?.deviceType,
    osName: input.osName || deviceContext?.osName,
    ipAddress: deviceContext?.ipAddress,
    userAgent: deviceContext?.userAgent,
  };

  const rotation = await rotateRefreshToken(
    fastify,
    presentedToken,
    mergedDeviceContext
  );

  if (rotation.status === 'reuse') {
    throw new AppError(
      'This refresh token has already been used. All sessions were revoked; please sign in again.',
      401,
      'REFRESH_TOKEN_REUSE'
    );
  }

  if (rotation.status === 'expired') {
    throw new AppError('Session expired. Please sign in again.', 401, 'SESSION_EXPIRED');
  }

  if (rotation.status === 'inactive') {
    throw new AppError(
      'Session expired or revoked on this device',
      401,
      'SESSION_REVOKED'
    );
  }

  if (rotation.status === 'invalid') {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }

  const [userRecord] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, rotation.userId))
    .limit(1);

  if (!userRecord || !userRecord.isActive) {
    await fastify.db
      .update(schema.loggedDevices)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedReason: 'ACCOUNT_DEACTIVATED',
      })
      .where(eq(schema.loggedDevices.id, rotation.deviceId));
    throw new AppError('Account deactivated', 403, 'ACCOUNT_DEACTIVATED');
  }

  const membership = await resolveActiveMembership(fastify, rotation.userId);
  if (!membership) {
    await fastify.db
      .update(schema.loggedDevices)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedReason: 'NO_MEMBERSHIP',
      })
      .where(eq(schema.loggedDevices.id, rotation.deviceId));
    throw new AppError('No active membership found', 403, 'NO_MEMBERSHIP');
  }

  const accessToken = fastify.jwt.sign(
    {
      userId: rotation.userId,
      googleSub: `sub-${rotation.userId}`,
      organizationId: membership.organizationId,
      role: membership.role,
      jti: rotation.sessionJti,
    },
    { expiresIn: '15m' }
  );

  return {
    accessToken,
    expiresIn: 900,
    refreshToken: rotation.refreshToken,
    user: {
      id: rotation.userId,
      email: userRecord.email,
      fullName: userRecord.fullName,
      role: membership.role,
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      premisesId: membership.premisesId || null,
      premisesName: membership.premisesName || null,
      avatarUrl: userRecord.avatarUrl || null,
      organizationLogoUrl: membership.organizationLogoUrl || null,
    },
  };
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

  const membership = await resolveActiveMembership(fastify, userId);
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
    premisesId: membership.premisesId || null,
    premisesName: membership.premisesName || null,
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
        revokedReason: 'LOGOUT',
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
        revokedReason: 'LOGOUT_ALL',
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
        revokedReason: 'REVOKED_BY_USER',
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
    premisesId?: string | null;
    premisesName?: string | null;
    email: string;
    fullName: string;
    avatarUrl?: string | null;
    role: 'OWNER' | 'MANAGER' | 'STAFF';
    deviceInfo?: DeviceContext;
  }
): Promise<AuthResponse> {
  // Single active device rule for ALL roles: Automatically revoke all prior active device sessions.
  // This is a security property of the single-device policy, so a failure is fatal:
  // continuing would leave an old device signed in alongside the new one.
  try {
    await fastify.db
      .update(schema.loggedDevices)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedReason: 'REPLACED_BY_NEW_LOGIN',
      })
      .where(
        and(
          eq(schema.loggedDevices.userId, params.userId),
          eq(schema.loggedDevices.isActive, true)
        )
      );
  } catch (err) {
    fastify.log.error({ err, userId: params.userId }, 'Failed to revoke prior device sessions');
    throw new AppError('Could not start a secure session', 500, 'SESSION_REVOKE_FAILED');
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
  const { token: refreshToken, hash: refreshTokenHash } = generateRefreshToken(
    env.REFRESH_TOKEN_SECRET
  );
  const now = new Date();

  try {
    await fastify.db.insert(schema.loggedDevices).values({
      userId: params.userId,
      sessionJti: jti,
      refreshTokenHash,
      expiresAt: refreshTokenExpiry(now),
      deviceName: params.deviceInfo?.deviceName || null,
      deviceType: params.deviceInfo?.deviceType || null,
      osName: params.deviceInfo?.osName || null,
      ipAddress: params.deviceInfo?.ipAddress || null,
      userAgent: params.deviceInfo?.userAgent || null,
      isActive: true,
      lastActiveAt: now,
    });
  } catch (err) {
    // Without this row every subsequent request fails SESSION_NOT_FOUND, so never
    // hand out tokens for a session that was not persisted.
    fastify.log.error({ err, userId: params.userId }, 'Failed to persist login session');
    throw new AppError('Could not create a login session', 500, 'SESSION_CREATE_FAILED');
  }

  // To reduce DB burden: keep up to 5 most recent logged_devices records per user for audit tracking, prune older ones
  try {
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
    fastify.log.warn({ err, userId: params.userId }, 'Failed to prune excess device history');
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
      premisesId: params.premisesId || null,
      premisesName: params.premisesName || null,
      avatarUrl: params.avatarUrl || null,
      organizationLogoUrl: params.organizationLogoUrl || null,
    },
  };
}
