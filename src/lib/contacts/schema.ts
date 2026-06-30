import { z } from 'zod';

export const createContactSchema = z
  .object({
    firstName: z
      .string()
      .trim()
      .max(100, 'First name must be 100 characters or fewer')
      .nullable(),
    lastName: z
      .string()
      .trim()
      .max(100, 'Last name must be 100 characters or fewer')
      .nullable(),
    email: z
      .email({ message: 'Enter a valid email address' })
      .max(255, 'Email is too long')
      .nullable(),
    phone: z
      .string()
      .trim()
      .max(50, 'Phone must be 50 characters or fewer')
      .nullable(),
    title: z
      .string()
      .trim()
      .max(100, 'Title must be 100 characters or fewer')
      .nullable(),
    companyId: z.uuid({ message: 'Pick a valid company' }).nullable(),
    ownerId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
  .refine((data) => Boolean(data.firstName || data.lastName || data.email), {
    message: 'Provide a first name, last name, or email.',
    path: ['firstName'],
  });

export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    id: z.uuid({ message: 'Invalid contact id' }),
    firstName: z.string().trim().max(100).nullable(),
    lastName: z.string().trim().max(100).nullable(),
    email: z.email({ message: 'Enter a valid email address' }).max(255).nullable(),
    phone: z.string().trim().max(50).nullable(),
    title: z.string().trim().max(100).nullable(),
    companyId: z.uuid({ message: 'Pick a valid company' }).nullable(),
  })
  .refine((data) => Boolean(data.firstName || data.lastName || data.email), {
    message: 'Provide a first name, last name, or email.',
    path: ['firstName'],
  });

export type UpdateContactInput = z.infer<typeof updateContactSchema>;

/**
 * Partial update for inline (click-to-edit) contact cells. The
 * "needs a name or email" rule can't be checked here (fields may be absent),
 * so the action enforces it against the merged row.
 */
export const patchContactSchema = z.object({
  id: z.uuid({ message: 'Invalid contact id' }),
  firstName: z.union([z.string().trim().max(100), z.null()]).optional(),
  lastName: z.union([z.string().trim().max(100), z.null()]).optional(),
  email: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.union([
        z.email({ message: 'Enter a valid email address' }).max(255),
        z.null(),
      ]),
    )
    .optional(),
  phone: z.union([z.string().trim().max(50), z.null()]).optional(),
  title: z.union([z.string().trim().max(100), z.null()]).optional(),
  ownerId: z.union([z.string().min(1).max(120), z.null()]).optional(),
});

export type PatchContactInput = z.infer<typeof patchContactSchema>;

export const contactIdSchema = z.object({
  id: z.uuid({ message: 'Invalid contact id' }),
});
