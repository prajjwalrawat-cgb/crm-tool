import { z } from 'zod';

export const createCompanySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(200, 'Name must be 200 characters or fewer'),
  domain: z
    .string()
    .trim()
    .max(255, 'Domain must be 255 characters or fewer')
    .nullable(),
  industry: z
    .string()
    .trim()
    .max(100, 'Industry must be 100 characters or fewer')
    .nullable(),
  ownerId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema.extend({
  id: z.uuid({ message: 'Invalid company id' }),
});

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

/** Partial update for inline (click-to-edit) company cells. */
export const patchCompanySchema = z.object({
  id: z.uuid({ message: 'Invalid company id' }),
  name: z.string().trim().min(1, 'Name is required').max(200).optional(),
  domain: z.union([z.string().trim().max(255), z.null()]).optional(),
  industry: z.union([z.string().trim().max(100), z.null()]).optional(),
  ownerId: z.union([z.string().min(1).max(120), z.null()]).optional(),
});

export type PatchCompanyInput = z.infer<typeof patchCompanySchema>;

export const companyIdSchema = z.object({
  id: z.uuid({ message: 'Invalid company id' }),
});
