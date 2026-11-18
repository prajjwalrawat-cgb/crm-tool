import Script from 'next/script';
import { notFound } from 'next/navigation';

import { lookupPublicForm } from '@/lib/lead-capture/forms';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ tenantSlug: string; formSlug: string }> };

export async function generateMetadata({ params }: Props) {
  const { tenantSlug, formSlug } = await params;
  const form = await lookupPublicForm(tenantSlug, formSlug);
  return { title: form?.title ?? 'Form', robots: { index: false } };
}

/**
 * Hosted capture form (/f/:tenantSlug/:formSlug). Renders the same embed
 * script a customer would paste on their own site, so the hosted page and the
 * embed can't drift apart. Public: no session.
 */
export default async function HostedFormPage({ params }: Props) {
  const { tenantSlug, formSlug } = await params;
  const form = await lookupPublicForm(tenantSlug, formSlug);
  if (!form) notFound();
  return (
    <main className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-[480px]">
        <div data-saleinx-form={`${tenantSlug}/${formSlug}`} />
        <Script src="/embed/form.js" strategy="afterInteractive" />
      </div>
    </main>
  );
}
