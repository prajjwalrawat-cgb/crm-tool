import { withTenantSession } from '@/lib/auth-guard';
import { listInvoices } from '@/lib/invoices/queries';
import { isAdmin, requireMembership } from '@/lib/membership';
import { parsePageSize } from '@/lib/pagination/page-size';

import { InvoicesView } from './_components/invoices-view';

export const metadata = { title: 'Invoices' };

function asInt(v: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const size = parsePageSize(sp.size);
  const page = asInt(sp.page, 1);
  const search = typeof sp.q === 'string' ? sp.q.trim() || undefined : undefined;

  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const { rows, total } = await listInvoices(tenant.id, { page, size, search });
    const totalPages = Math.max(1, Math.ceil(total / size));

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Invoices</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Proforma invoices for {tenant.name}
          </p>
        </header>

        <InvoicesView
          rows={rows}
          total={total}
          page={page}
          size={size}
          totalPages={totalPages}
          initialSearch={search ?? ''}
          currentUserId={userId}
          canManageAll={isAdmin(membership)}
        />
      </main>
    );
  });
}
