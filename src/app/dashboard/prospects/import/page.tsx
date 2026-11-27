import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { isOfferingsEnabled, listOfferingOptions } from '@/lib/offerings/queries';
import { getProspectSettings } from '@/lib/prospects/settings';
import { can } from '@/lib/rbac';

import { DumpInput } from './_components/dump-input';

export const metadata = { title: 'Quick dump' };

export default async function QuickDumpPage() {
  return await withTenantSession(async ({ tenant }) => {
    const membership = await requireMembership();
    if (!can(membership.role, 'manageProspects')) {
      return (
        <main className="mx-auto w-full max-w-[80rem] px-4 py-6 sm:px-5 lg:px-6">
          <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You do not have access to Quick dump.{' '}
            <Link href="/dashboard/prospects" className="underline">
              Back to the board
            </Link>
          </p>
        </main>
      );
    }
    // Product fit follows the workspace "Offerings" switch, like deals do.
    const offerings = (await isOfferingsEnabled(tenant.id)) ? await listOfferingOptions(tenant.id, { activeOnly: true }) : [];
    const { sources } = await getProspectSettings(tenant.id);
    return (
      <main className="mx-auto w-full max-w-[90rem] space-y-4 px-4 py-6 sm:px-5 lg:px-6">
        <header>
          <Link href="/dashboard/prospects" className="text-[12px] text-slate-500 hover:underline">
            Back to the board
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Quick dump</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
            Paste notes, upload a CSV or a photo of visiting cards. Review the prospects it finds, fix anything, then
            add them to the Dump column.
          </p>
        </header>
        <DumpInput sources={sources} offerings={offerings.map((o) => ({ id: o.id, name: o.name }))} />
      </main>
    );
  });
}
