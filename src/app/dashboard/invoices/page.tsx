import { withTenantSession } from '@/lib/auth-guard';
import { invoiceStatusesFor } from '@/lib/collections/queries';
import { listInvoices } from '@/lib/invoices/queries';
import { listSellerProfiles } from '@/lib/invoices/seller-profiles';
import { getInvoiceSettings } from '@/lib/invoices/settings';
import { isAdmin, requireMembership } from '@/lib/membership';
import { can } from '@/lib/rbac';
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
    // Members see only their own PIs; owners/admins see all. Whoever records
    // payments (managers too, 0069) must also see all — they collect against
    // reps' invoices. Seeing is not editing: edit/delete stay owner/admin or
    // the creator, enforced in the actions.
    const canManageAll = isAdmin(membership);
    const canSeeAll = canManageAll || can(membership.role, 'recordPayments');
    const [{ rows, total }, settings, sellerProfiles] = await Promise.all([
      listInvoices(tenant.id, {
        page,
        size,
        search,
        restrictToCreatedBy: canSeeAll ? undefined : userId,
      }),
      getInvoiceSettings(tenant.id),
      listSellerProfiles(tenant.id),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / size));
    const statuses = await invoiceStatusesFor(
      tenant.id,
      rows.map((r) => r.id),
      new Date().toISOString().slice(0, 10),
    );

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
          canManageAll={canManageAll}
          sellerProfiles={sellerProfiles}
          defaultPaymentTerms={settings.paymentTerms}
          defaultDeliveryTerms={settings.deliveryTerms}
          statuses={Object.fromEntries(statuses)}
        />
      </main>
    );
  });
}
