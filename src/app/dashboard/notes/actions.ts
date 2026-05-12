'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { notes, type Note } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';

const ENTITY_TYPES = ['deal', 'company', 'contact'] as const;

const PERMISSION_FOR: Record<(typeof ENTITY_TYPES)[number], 'manageDeals' | 'manageCompanies' | 'manageContacts'> = {
  deal: 'manageDeals',
  company: 'manageCompanies',
  contact: 'manageContacts',
};

function pathFor(entityType: (typeof ENTITY_TYPES)[number], entityId: string): string {
  if (entityType === 'deal') return `/dashboard/deals/${entityId}`;
  return `/dashboard/${entityType === 'company' ? 'companies' : 'contacts'}`;
}

const createNoteSchema = z.object({
  body: z.string().min(1, 'Note can’t be empty').max(8000),
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.uuid(),
});

const updateNoteSchema = z.object({
  id: z.uuid(),
  body: z.string().min(1).max(8000),
});

const idSchema = z.object({ id: z.uuid() });

export type NoteResult =
  | { ok: true; note: Note }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export type SimpleNoteResult = { ok: true } | { ok: false; message: string };

export async function createNoteAction(
  input: { body: string; entityType: 'deal' | 'company' | 'contact'; entityId: string },
): Promise<NoteResult> {
  const parsed = createNoteSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: flat.formErrors[0] ?? 'Invalid note input.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  const gate = await checkPermission(PERMISSION_FOR[parsed.data.entityType]);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const inserted = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(notes)
          .values({
            tenantId: tenant.id,
            authorUserId: membership.userId,
            entityType: parsed.data.entityType,
            entityId: parsed.data.entityId,
            body: parsed.data.body.trim(),
          })
          .returning();
        if (!row) throw new Error('Insert failed');

        // Log on the parent entity — so the per-deal/per-company activity
        // timeline picks up "Priya added a note" alongside other actions.
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          action: 'updated',
          metadata: {
            noteId: row.id,
            notePreview: parsed.data.body.slice(0, 120),
            fields: ['notes'],
          },
        });

        return row;
      });

      revalidatePath(pathFor(parsed.data.entityType, parsed.data.entityId));
      return { ok: true, note: inserted };
    },
  );
}

export async function updateNoteAction(
  input: { id: string; body: string },
): Promise<NoteResult> {
  const parsed = updateNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid note input.' };
  }

  // Need to discover the entity type for permission gate + path
  // revalidation. Look up the note first.
  const lookupGate = await checkPermission('manageDeals'); // weakest permission for read
  if (!lookupGate.ok) return { ok: false, message: lookupGate.message };
  const { tenant, membership } = lookupGate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const existing = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(notes)
          .where(
            and(
              eq(notes.id, parsed.data.id),
              eq(notes.tenantId, tenant.id),
              isNull(notes.deletedAt),
            ),
          )
          .limit(1),
      );
      const note = existing[0];
      if (!note) return { ok: false, message: 'Note not found.' };
      if (note.authorUserId !== membership.userId) {
        return { ok: false, message: 'You can only edit your own notes.' };
      }

      const updated = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(notes)
          .set({ body: parsed.data.body.trim() })
          .where(eq(notes.id, parsed.data.id))
          .returning();
        if (!row) throw new Error('Update failed');
        return row;
      });

      revalidatePath(pathFor(note.entityType as 'deal' | 'company' | 'contact', note.entityId));
      return { ok: true, note: updated };
    },
  );
}

export async function deleteNoteAction(id: string): Promise<SimpleNoteResult> {
  const parsed = idSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, message: 'Invalid id' };

  const lookupGate = await checkPermission('manageDeals');
  if (!lookupGate.ok) return { ok: false, message: lookupGate.message };
  const { tenant, membership } = lookupGate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const existing = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(notes)
          .where(
            and(
              eq(notes.id, parsed.data.id),
              eq(notes.tenantId, tenant.id),
              isNull(notes.deletedAt),
            ),
          )
          .limit(1),
      );
      const note = existing[0];
      if (!note) return { ok: true }; // already gone, treat idempotent

      if (note.authorUserId !== membership.userId) {
        return { ok: false, message: 'You can only delete your own notes.' };
      }

      await tenantTransaction(async (tx) => {
        await tx
          .update(notes)
          .set({ deletedAt: new Date(), deletedBy: membership.userId })
          .where(eq(notes.id, parsed.data.id));
      });

      revalidatePath(pathFor(note.entityType as 'deal' | 'company' | 'contact', note.entityId));
      return { ok: true };
    },
  );
}
