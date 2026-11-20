import { withTenantSession } from '@/lib/auth-guard';
import { requirePersonas } from '@/lib/personas/guards';
import { ensureStarterTemplate, listQuoteTemplates } from '@/lib/quotes/queries';

import { TemplateList } from './_components/template-list';

export const metadata = { title: 'Quote templates · Settings' };

export default async function QuoteTemplatesPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant, userId }) => {
    await ensureStarterTemplate(tenant.id, userId);
    const rows = await listQuoteTemplates(tenant.id);

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Quote templates
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            The layout every quote PDF is built from: which sections appear, in what order, and the default wording
            reps start with. New quotes use the default template. A quote keeps a copy of its template, so editing a
            template never changes quotes that already exist.
          </p>
        </header>
        <TemplateList
          templates={rows.map((t) => ({
            id: t.id,
            name: t.name,
            isDefault: t.isDefault,
            updatedAt: t.updatedAt.toISOString(),
          }))}
        />
      </main>
    );
  });
}
