import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';

import { captureForms } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { listLeadSources } from '@/lib/lead-capture/admin';
import { requirePersonas } from '@/lib/personas/guards';

import { FormsManager } from './_components/forms-manager';

export const metadata = { title: 'Capture forms · Settings' };

export default async function LeadFormsPage() {
  await requirePersonas(['admin']);
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const origin = (process.env.APP_URL?.trim() || `${h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')}://${host}`).replace(/\/+$/, '');
  return await withTenantSession(async ({ tenant }) => {
    const [forms, sources] = await Promise.all([
      tenantTransaction((tx) => tx.select().from(captureForms).where(eq(captureForms.tenantId, tenant.id))),
      listLeadSources(tenant.id),
    ]);
    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Capture forms</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Build an enquiry form once and use it two ways: as a hosted page you can link to, or embedded on your own
            website with one line of code. Submissions land as leads on the form&apos;s source and are distributed like
            any other lead.
          </p>
        </header>
        <FormsManager
          origin={origin}
          tenantSlug={tenant.slug}
          sources={sources.map((s) => ({ id: s.id, name: s.name, allowedOrigins: s.allowedOrigins }))}
          forms={forms
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .map((f) => ({
              id: f.id,
              sourceId: f.sourceId,
              slug: f.slug,
              title: f.title,
              fields: f.fields ?? [],
              thankYouMessage: f.thankYouMessage,
              redirectUrl: f.redirectUrl,
              consentText: f.consentText,
              accent: typeof f.theme?.accent === 'string' ? f.theme.accent : '#4f46e5',
              isPublished: f.isPublished,
            }))}
        />
      </main>
    );
  });
}
