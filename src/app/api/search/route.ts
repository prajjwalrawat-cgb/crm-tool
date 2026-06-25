import { auth } from '@/lib/auth/server';
import { sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { getCurrentMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';
import type { SearchHit, SearchResponse } from '@/lib/search/types';
import { requireTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tenant-scoped global search. Used exclusively by the Cmd+K command
 * palette: it issues a debounced GET as the user types.
 *
 * Response shape: groups of up to 5 hits per entity type. We do a
 * single tenantTransaction with five parallel SELECTs — every query
 * targets the same `tenant_id` index plus an `ILIKE name/email/domain`
 * predicate, which Postgres serves cheaply on a populated tenant
 * (~3-8ms wall time observed on the Test 1 fixture).
 *
 * The endpoint deliberately does *not* implement trigram or full-text
 * search yet; ILIKE is fast enough at our current scale and avoids a
 * migration. Swap to pg_trgm + GIN indexes when a tenant exceeds
 * ~10k rows per table — and not before.
 */

const MAX_PER_BUCKET = 5;
const MIN_QUERY_LENGTH = 1;

export async function GET(req: NextRequest): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const tenant = await requireTenant();
  const membership = await getCurrentMembership();
  const persona = personaOf(membership?.role ?? null);

  const rawQuery = req.nextUrl.searchParams.get('q') ?? '';
  const query = rawQuery.trim().slice(0, 100);
  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json<SearchResponse>({ query: '', hits: [] });
  }

  // postgres-js ILIKE wildcards: caller-supplied input is bound as a
  // parameter, so SQL injection is impossible. We escape `%` and `_`
  // so the user can search for literal underscores in workflow ids.
  const escaped = query.replace(/[%_]/g, '\\$&');
  const pattern = `%${escaped}%`;

  // RBAC: sales persona is scoped to records they own (or unassigned
  // ones, matching the list-page rules in listDeals/listContacts/etc).
  // Admin + manager see the full tenant. Bind `mineOnlyId` and
  // `mineOnly` so a single SQL shape covers both cases without
  // branching the queries.
  const mineOnly = persona === 'sales';
  const mineOnlyId = mineOnly ? userId : null;
  // Workflows are admin-only — never expose to non-admin personas.
  const seeWorkflows = persona === 'admin';

  const hits = await runWithTenantContext(
    { tenantId: tenant.id, userId },
    async () =>
      tenantTransaction(async (tx) => {
        const [
          dealRows,
          companyRows,
          contactRows,
          workflowRows,
          taskRows,
        ] = await Promise.all([
            tx.execute(sql`
              SELECT d.id, d.name, d.stage::text AS stage,
                     c.name AS company_name
              FROM deals d
              LEFT JOIN companies c ON c.id = d.company_id
              WHERE d.tenant_id = ${tenant.id}::uuid
                AND d.deleted_at IS NULL
                AND d.name ILIKE ${pattern}
                -- owner_id is text (Clerk ids like "user_xxx"), not
                -- uuid. ::uuid casts of Clerk ids throw at runtime.
                AND (${mineOnlyId}::text IS NULL
                     OR d.owner_id = ${mineOnlyId}::text
                     OR d.owner_id IS NULL)
              ORDER BY d.updated_at DESC
              LIMIT ${MAX_PER_BUCKET}
            `) as unknown as Array<{
              id: string;
              name: string;
              stage: string;
              company_name: string | null;
            }>,
            tx.execute(sql`
              SELECT id, name, domain
              FROM companies
              WHERE tenant_id = ${tenant.id}::uuid
                AND deleted_at IS NULL
                AND (name ILIKE ${pattern} OR domain ILIKE ${pattern})
                AND (${mineOnlyId}::text IS NULL
                     OR owner_id = ${mineOnlyId}::text
                     OR owner_id IS NULL)
              ORDER BY updated_at DESC
              LIMIT ${MAX_PER_BUCKET}
            `) as unknown as Array<{
              id: string;
              name: string;
              domain: string | null;
            }>,
            tx.execute(sql`
              SELECT c.id,
                     c.first_name, c.last_name, c.email,
                     co.name AS company_name
              FROM contacts c
              LEFT JOIN companies co ON co.id = c.company_id
              WHERE c.tenant_id = ${tenant.id}::uuid
                AND c.deleted_at IS NULL
                AND (
                  c.first_name ILIKE ${pattern}
                  OR c.last_name ILIKE ${pattern}
                  OR c.email ILIKE ${pattern}
                )
                AND (${mineOnlyId}::text IS NULL
                     OR c.owner_id = ${mineOnlyId}::text
                     OR c.owner_id IS NULL)
              ORDER BY c.updated_at DESC
              LIMIT ${MAX_PER_BUCKET}
            `) as unknown as Array<{
              id: string;
              first_name: string | null;
              last_name: string | null;
              email: string | null;
              company_name: string | null;
            }>,
            seeWorkflows
              ? (tx.execute(sql`
                  SELECT id, workflow_id, status::text AS status, started_at
                  FROM workflow_runs
                  WHERE tenant_id = ${tenant.id}::uuid
                    AND workflow_id ILIKE ${pattern}
                  ORDER BY started_at DESC
                  LIMIT ${MAX_PER_BUCKET}
                `) as unknown as Promise<Array<{
                  id: string;
                  workflow_id: string;
                  status: string;
                  started_at: Date | string;
                }>>)
              : Promise.resolve([] as Array<{
                  id: string;
                  workflow_id: string;
                  status: string;
                  started_at: Date | string;
                }>),
            tx.execute(sql`
              SELECT id, title, status::text AS status, priority::text AS priority, due_date::text AS due_date
              FROM tasks
              WHERE tenant_id = ${tenant.id}::uuid
                AND deleted_at IS NULL
                AND title ILIKE ${pattern}
                AND (${mineOnlyId}::uuid IS NULL
                     OR assigned_user_id = ${mineOnlyId}::uuid
                     OR assigned_user_id IS NULL)
              ORDER BY
                CASE WHEN status IN ('todo','in_progress') THEN 0 ELSE 1 END,
                updated_at DESC
              LIMIT ${MAX_PER_BUCKET}
            `) as unknown as Array<{
              id: string;
              title: string;
              status: string;
              priority: string;
              due_date: string | null;
            }>,
          ]);

        const out: SearchHit[] = [];
        for (const r of dealRows) {
          out.push({
            kind: 'deal',
            id: r.id,
            title: r.name,
            subtitle: r.company_name,
            stage: r.stage,
            href: `/dashboard/deals/${r.id}`,
          });
        }
        for (const r of companyRows) {
          out.push({
            kind: 'company',
            id: r.id,
            title: r.name,
            subtitle: r.domain,
            href: `/dashboard/companies?q=${encodeURIComponent(r.name)}`,
          });
        }
        for (const r of contactRows) {
          const title =
            [r.first_name, r.last_name].filter(Boolean).join(' ') ||
            r.email ||
            '(unnamed)';
          out.push({
            kind: 'contact',
            id: r.id,
            title,
            subtitle: r.email ?? r.company_name,
            href: `/dashboard/contacts?q=${encodeURIComponent(title)}`,
          });
        }
        for (const r of workflowRows) {
          const dt =
            typeof r.started_at === 'string'
              ? new Date(r.started_at)
              : r.started_at;
          out.push({
            kind: 'workflow',
            id: r.id,
            title: r.workflow_id,
            subtitle: dt.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }),
            status: r.status,
            href: `/dashboard/workflows`,
          });
        }
        for (const r of taskRows) {
          out.push({
            kind: 'task',
            id: r.id,
            title: r.title,
            subtitle: r.due_date ? `due ${r.due_date}` : null,
            status: r.status,
            priority: r.priority,
            href: `/dashboard/tasks?q=${encodeURIComponent(r.title)}`,
          });
        }
        return out;
      }),
  );

  return NextResponse.json<SearchResponse>({ query, hits });
}
