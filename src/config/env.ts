import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url(),

  /** Web OAuth client ID. Android apps pass this as `serverClientId`, so ID tokens carry it as `aud`. */
  GOOGLE_WEB_CLIENT_ID: z.string().min(1),
  /** Only needed for the authorization-code flow; installed/Android clients have no secret. */
  GOOGLE_WEB_CLIENT_SECRET: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().min(1).optional()
  ),
  /**
   * Only used by the browser redirect flow. Android `requestServerAuthCode` exchanges
   * must omit it, so it stays optional.
   */
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  /**
   * Additional client IDs whose ID tokens are accepted, comma separated.
   * Android/installed OAuth clients have no secret, so they belong here.
   */
  GOOGLE_EXTRA_CLIENT_IDS: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().min(1).optional()
  ),

  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),

  /**
   * SFace cosine-similarity threshold. OpenCV's reference value for the
   * bundled SFace model is 0.363; anything higher rejects genuine matches.
   */
  FACE_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.363),
  /** Minimum normalised Laplacian texture score accepted as passive liveness. */
  FACE_PASSIVE_LIVENESS_MIN: z.coerce.number().min(0).max(1).default(0.2),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.preprocess((val) => {
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return Boolean(val);
  }, z.boolean()).default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Presence App <noreply@presence.app>'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('Invalid Environment Variables:', _env.error.format());
  throw new Error('Invalid Environment Variables');
}

export const env = _env.data;
export type Env = z.infer<typeof envSchema>;
