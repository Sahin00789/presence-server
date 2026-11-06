import { z } from 'zod';

export const holidaySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  premisesId: z.string(),
  name: z.string(),
  date: z.string(),
  isPaid: z.boolean(),
  createdAt: z.date().or(z.string()).optional(),
});

export const createHolidaySchema = z.object({
  premisesId: z.string().uuid('premisesId must be a valid UUID'),
  name: z.string().trim().min(2).max(120),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  isPaid: z.boolean().default(true),
});

export const updateHolidaySchema = z.object({
  premisesId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
  isPaid: z.boolean().optional(),
});

export type Holiday = z.infer<typeof holidaySchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;
