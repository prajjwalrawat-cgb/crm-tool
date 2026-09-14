import { withTenantSession } from '@/lib/auth-guard';
import {
  isOfferingsEnabled,
  listOfferingsWithUsage,
} from '@/lib/offerings/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { OfferingsManager } from './_components/offerings-manager';

export const metadata = { title: 'Offerings · Settings' };

export default async function OfferingsSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [rows, enabled] = await Promise.all([
      listOfferingsWithUsage(tenant.id),
      isOfferingsEnabled(tenant.id),
    ]);

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Offerings
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            What this workspace sells, split into Products and Services. Every
            new deal is tagged with at least one, which is what makes the
            per-offering funnel possible.
            <br />
            Offerings are <span className="font-medium">retired</span>, never
            deleted — closed deals reference them, so removing one would
            rewrite history. A retired offering keeps showing on the deals
            already tagged with it and simply stops appearing in the picker.
          </p>
        </header>
        <OfferingsManager
          enabled={enabled}
          initial={rows.map((o) => ({
            id: o.id,
            name: o.name,
            category: o.category,
            active: o.active,
            sortOrder: o.sortOrder,
            dealCount: o.dealCount,
          }))}
        />
      </main>
    );
  });
}
