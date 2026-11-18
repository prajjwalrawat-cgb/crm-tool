import { withTenantSession } from '@/lib/auth-guard';
import { listLeadSources } from '@/lib/lead-capture/admin';
import { requirePersonas } from '@/lib/personas/guards';

import { ImportWizard } from './_components/import-wizard';

export const metadata = { title: 'Import leads' };

export default async function ImportLeadsPage() {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const sources = await listLeadSources(tenant.id);
    return (
      <main className="mx-auto w-full max-w-[80rem] space-y-4 px-4 py-6 sm:px-5 lg:px-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Import leads</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
            Upload a CSV (portal export, trade-show list, old CRM). Columns are matched to lead fields automatically —
            only the column names are used for that, never the data in them. Every row is deduplicated by phone and
            email and distributed like a captured lead. Up to 10,000 rows / 4 MB per file.
          </p>
        </header>
        <ImportWizard sources={sources.filter((s) => s.isActive).map((s) => ({ id: s.id, name: s.name, type: s.type }))} />
      </main>
    );
  });
}
