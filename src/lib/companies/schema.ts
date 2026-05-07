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
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema.extend({
  id: z.uuid({ message: 'Invalid company id' }),
});

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const companyIdSchema = z.object({
  id: z.uuid({ message: 'Invalid company id' }),
});
