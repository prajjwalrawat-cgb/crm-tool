import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { getCurrentMembership } from '@/lib/membership';
import { captureError } from '@/lib/observability';
import { createImport, IMPORT_MESSAGES, MAX_IMAGE_BYTES, type CreateImportInput } from '@/lib/prospects/import/imports';
import { can } from '@/lib/rbac';
import { getCurrentTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Streaming Claude parses of large dumps can take minutes (chunks run in parallel).
export const maxDuration = 300;

/** Largest file (5 MB image) plus room for the multipart envelope and text fields. */
const MAX_BODY_BYTES = MAX_IMAGE_BYTES + 512 * 1024;

const KINDS = ['text', 'csv', 'image'] as const;

const error = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/prospects/import — Quick Dump parse for the Prospect Board.
 * Multipart fields: `sourceTag`, `kind` (text | csv | image), and `text` or
 * `file`. Parses and stores a `prospect_imports` row for review; nothing is
 * added to the board until confirmImportAction.
 *
 * 200 { importId, rows, dropped, capped, hints } · 400 bad input · 401 no session ·
 * 403 no manageProspects · 413 too large · 422 unreadable dump · 502 AI failure.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { userId } = await auth();
  if (!userId) return error('Sign in again to continue.', 401);
  const tenant = await getCurrentTenant();
  if (!tenant) return error('Choose a workspace first.', 401);

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return error('This upload is too large.', 413);

  try {
    return await runWithTenantContext({ tenantId: tenant.id, userId }, async () => {
      const membership = await getCurrentMembership();
      if (!membership || membership.status !== 'active' || !can(membership.role, 'manageProspects')) {
        return error('You do not have permission.', 403);
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return error('Send the dump as a multipart form.', 400);
      }

      const kind = form.get('kind');
      if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return error(IMPORT_MESSAGES.kind, 400);
      const sourceTag = form.get('sourceTag');
      const text = form.get('text');
      const file = form.get('file');

      const input: CreateImportInput = {
        sourceTag: typeof sourceTag === 'string' ? sourceTag : '',
        kind: kind as CreateImportInput['kind'],
      };
      if (typeof text === 'string') input.text = text;
      if (file && typeof file !== 'string') {
        // Size check before reading the bytes into memory.
        if (file.size > MAX_IMAGE_BYTES) {
          return error(kind === 'csv' ? IMPORT_MESSAGES.csvTooLarge : IMPORT_MESSAGES.imageTooLarge, 413);
        }
        input.file = { bytes: Buffer.from(await file.arrayBuffer()), mediaType: file.type, name: file.name };
      }

      const r = await createImport(tenant.id, { userId, role: membership.role }, input);
      if (!r.ok) return error(r.message, r.status);
      return NextResponse.json(
        { importId: r.importId, rows: r.rows, dropped: r.dropped, capped: r.capped, hints: r.hints },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    });
  } catch (err) {
    captureError(err, { category: 'prospects.import.route_failed', severity: 'medium' });
    return error('Something went wrong reading this dump. Try again.', 500);
  }
}
