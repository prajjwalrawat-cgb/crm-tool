import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { getQuoteTemplate } from '@/lib/quotes/queries';

import { TemplateBuilder } from '../_components/template-builder';

export const metadata = { title: 'Edit quote template · Settings' };

export default async function QuoteTemplateEditorPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePersonas(['admin']);
  const { id } = await params;
  return await withTenantSession(async ({ tenant }) => {
    const [template, defs] = await Promise.all([getQuoteTemplate(tenant.id, id), listCustomFieldDefs(tenant.id, 'deal')]);
    // Archived templates can't be saved (saveQuoteTemplate only updates active rows).
    if (!template || template.archivedAt) notFound();

    return (
      <TemplateBuilder
        id={template.id}
        initialName={template.name}
        initialBody={template.body}
        isDefault={template.isDefault}
        dealCustomFields={defs.map((d) => ({ key: d.key, label: d.label }))}
      />
    );
  });
}
