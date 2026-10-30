import { z } from 'zod';

export const roleSchema = z.enum(['OWNER', 'MANAGER', 'STAFF']);

export const otpRequestSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  role: roleSchema.optional().default('STAFF'),
});

export const otpVerifySchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  code: z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  role: roleSchema.optional().default('STAFF'),
  fullName: z.string().trim().min(2).optional(),
  organizationName: z.string().trim().min(2).optional(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  premisesName: z.string().optional(),
  premisesAddress: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  radiusMeters: z.number().optional(),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
  osName: z.string().optional(),
});

export const googleExchangeSchema = z.object({
  /**
   * Google ID token from Android Credential Manager / GoogleSignIn.
   * Recommended for the Android app: no client secret leaves the server.
   */
  idToken: z.string().min(1).optional(),
  /** Google authorization code (browser redirect flow or Android `requestServerAuthCode`). */
  code: z.string().min(1).optional(),
  /** Browser flow only. Android `requestServerAuthCode` exchanges must send null. */
  redirectUri: z.string().url().nullable().optional(),
  /** PKCE verifier, when the Android app generated a code challenge. */
  codeVerifier: z.string().min(43).max(128).optional(),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
  osName: z.string().optional(),
});

export const googleOwnerRegistrationSchema = z.object({
  idToken: z.string().min(1),
  organizationName: z.string().trim().min(2).optional(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  premisesName: z.string().trim().min(2).optional(),
  premisesAddress: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  radiusMeters: z.number().int().min(1).max(10000).optional(),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
  osName: z.string().optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(16).max(512),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
  osName: z.string().optional(),
});

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().nullable().optional(),
  avatar: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
});

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: roleSchema,
  organizationId: z.string(),
  organizationName: z.string(),
  premisesId: z.string().nullable().optional(),
  premisesName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  organizationLogoUrl: z.string().nullable().optional(),
});

export const otpResponseSchema = z.object({
  sent: z.boolean(),
  email: z.string(),
  expiresInSeconds: z.number(),
  devOtp: z.string().optional(),
});

export const authResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string(),
  user: authUserSchema,
});

export const logoutResponseSchema = z.object({
  loggedOut: z.boolean(),
  revokedSessions: z.number().optional(),
});

export const loggedDeviceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionJti: z.string(),
  deviceName: z.string().nullable().optional(),
  deviceType: z.string().nullable().optional(),
  osName: z.string().nullable().optional(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  isActive: z.boolean(),
  isCurrentDevice: z.boolean().optional(),
  lastActiveAt: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable().optional(),
});

export const loggedDevicesResponseSchema = z.object({
  devices: z.array(loggedDeviceSchema),
});

export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export type GoogleExchangeInput = z.infer<typeof googleExchangeSchema>;
export type GoogleOwnerRegistrationInput = z.infer<typeof googleOwnerRegistrationSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type OtpResponse = z.infer<typeof otpResponseSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type LoggedDevice = z.infer<typeof loggedDeviceSchema>;
export type LoggedDevicesResponse = z.infer<typeof loggedDevicesResponseSchema>;
