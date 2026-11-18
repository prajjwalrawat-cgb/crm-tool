import { headers } from 'next/headers';

import { withTenantSession } from '@/lib/auth-guard';
import {
  listCaptureForms,
  listDistributionRules,
  listIngestEvents,
  listLeadSources,
} from '@/lib/lead-capture/admin';
import { tenantTransaction } from '@/lib/db-context';
import { requirePersonas } from '@/lib/personas/guards';
import { leadSources } from '@/db/schema';
import { eq } from 'drizzle-orm';

import { LeadSourcesManager, type SourceView } from './_components/lead-sources-manager';

export const metadata = { title: 'Lead sources · Settings' };

async function appOrigin(): Promise<string> {
  const env = process.env.APP_URL?.trim();
  if (env) return env.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export default async function LeadSourcesPage() {
  await requirePersonas(['admin']);
  const origin = await appOrigin();
  return await withTenantSession(async ({ tenant }) => {
    const [list, full, rules, forms, events] = await Promise.all([
      listLeadSources(tenant.id),
      tenantTransaction((tx) => tx.select().from(leadSources).where(eq(leadSources.tenantId, tenant.id))),
      listDistributionRules(tenant.id),
      listCaptureForms(tenant.id),
      listIngestEvents(tenant.id, { limit: 200 }),
    ]);
    const byId = new Map(full.map((s) => [s.id, s]));
    const sources: SourceView[] = list.map((s) => {
      const f = byId.get(s.id)!;
      return {
        id: s.id,
        name: s.name,
        type: f.type,
        isActive: s.isActive,
        secretToken: f.secretToken,
        fieldMapping: f.fieldMapping ?? {},
        defaultRuleId: f.defaultRuleId,
        allowedOrigins: f.allowedOrigins ?? [],
        config: { page_id: f.config?.page_id ?? '', form_ids: f.config?.form_ids ?? [], hasPageToken: !!f.config?.page_token },
        lastEventAt: s.lastEventAt?.toISOString() ?? null,
        events7d: s.events7d,
        failed7d: s.failed7d,
      };
    });
    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Lead sources</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Every place leads come in from — your website, landing pages, IndiaMART and other portals, Meta lead ads,
            CSV imports. Each source has its own endpoint and secret. Every payload is stored before it is processed,
            so a lead is never lost even when its fields don&apos;t map.
          </p>
        </header>
        <LeadSourcesManager
          origin={origin}
          tenantSlug={tenant.slug}
          sources={sources}
          rules={rules.map((r) => ({ id: r.id, name: r.name }))}
          forms={forms.map((f) => ({ id: f.id, slug: f.slug, title: f.title, sourceId: f.sourceId, isPublished: f.isPublished }))}
          events={events.map((e) => ({
            id: e.id,
            sourceId: e.sourceId,
            status: e.status,
            error: e.error,
            dealId: e.dealId,
            receivedAt: e.receivedAt.toISOString(),
            attempts: e.attempts,
            preview: e.preview,
          }))}
        />
      </main>
    );
  });
}
