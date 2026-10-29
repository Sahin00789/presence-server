import { z } from 'zod';

export const holidaySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  date: z.string(),
  isPaid: z.boolean(),
  premisesId: z.string().nullable().optional(),
  createdAt: z.date().or(z.string()).optional(),
});

export const createHolidaySchema = z.object({
  name: z.string().trim().min(2).max(120),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  isPaid: z.boolean().default(true),
  premisesId: z.string().uuid().optional(),
});

export const updateHolidaySchema = createHolidaySchema.partial();

export type Holiday = z.infer<typeof holidaySchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;
