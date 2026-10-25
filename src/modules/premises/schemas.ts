import { z } from 'zod';

export const premisesSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  latitude: z.string(),
  longitude: z.string(),
  radiusMeters: z.number(),
  isActive: z.boolean(),
});

export const createPremisesSchema = z.object({
  name: z.string().min(2),
  latitude: z.string().min(1),
  longitude: z.string().min(1),
  radiusMeters: z.number().positive().default(50),
});

export const updatePremisesSchema = createPremisesSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type Premises = z.infer<typeof premisesSchema>;
export type CreatePremisesInput = z.infer<typeof createPremisesSchema>;
export type UpdatePremisesInput = z.infer<typeof updatePremisesSchema>;
