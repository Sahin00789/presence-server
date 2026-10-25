import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url(),

  GOOGLE_WEB_CLIENT_ID: z.string().min(1),
  GOOGLE_WEB_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),

  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),

  /**
   * SFace cosine-similarity threshold. OpenCV's reference value for the
   * bundled SFace model is 0.363; anything higher rejects genuine matches.
   */
  FACE_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.363),
  /** Minimum normalised Laplacian texture score accepted as passive liveness. */
  FACE_PASSIVE_LIVENESS_MIN: z.coerce.number().min(0).max(1).default(0.2),

  CLOUDINARY_CLOUD_NAME: z.string().default('dhhzoshz7'),
  CLOUDINARY_API_KEY: z.string().default('743661874227473'),
  CLOUDINARY_API_SECRET: z.string().default('MtTKUL3LUHGOWWrnBx7Ruz6_P3I'),

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
