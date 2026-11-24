'use client';

import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';

import { useUnsavedChangesWarning } from '@/components/quotes/use-unsaved-changes';
import { updateQuoteDraftAction } from '@/lib/quotes/actions';
import {
  formFromQuote,
  formToDraftInput,
  formTotals,
  friendlyMessage,
  previewQuote,
  type QuoteEditorForm,
} from '@/lib/quotes/editor-form';
import type { QuoteRenderInput } from '@/lib/quotes/pdf/context';
import type { QuoteSellerChoice } from '@/lib/quotes/queries';
import type { QuoteSection } from '@/lib/quotes/template-schema';
import { cn } from '@/lib/utils';

import { inputCls } from '../../../settings/lead-capture/_components/ui';
import { QuoteStatusBadge } from '../../_components/quote-ui';
import { LineItemsTable, type OfferingChoice } from './line-items-table';
import { QuoteActionsBar, type ActionsBarDeal } from './quote-actions-bar';
import { QuoteDealLink } from './quote-deal-link';
import { ClientDetailsEditor, FieldErrors, SectionContentEditor, errorCls } from './section-content-editor';

const QuotePdfPreview = dynamic(() => import('@/components/quotes/quote-pdf-preview'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center rounded-lg border border-slate-200 text-[12px] text-slate-500 dark:border-[#262626] dark:text-[#A1A1AA]">
      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> Loading preview…
    </div>
  ),
});

const SECTION_NAMES: Record<QuoteSection['type'], string> = {
  header: 'Header',
  client: 'Client details',
  text: 'Text',
  line_items: 'Line items',
  totals: 'Totals',
  payment_schedule: 'Payment schedule',
  terms: 'Terms',
  custom_fields: 'Deal fields',
  signature: 'Signature',
  page_break: 'Page break',
};

const READ_ONLY_NOTE: Partial<Record<QuoteSection['type'], string>> = {
  totals: 'Calculated from the line items.',
  custom_fields: 'Filled from the deal’s fields.',
  page_break: 'Starts a new page.',
};

const snapshotOf = (f: QuoteEditorForm) => JSON.stringify(f);
const newKey = () => crypto.randomUUID();

function mapErrors(fieldErrors: Record<string, string[]> | undefined): Record<string, string[]> {
  return Object.fromEntries(Object.entries(fieldErrors ?? {}).map(([k, v]) => [k, v.map(friendlyMessage)]));
}

export type EditorDeal = ActionsBarDeal & { id: string; name: string };

export function QuoteEditor({
  renderInput,
  canManage,
  canSetDealValue,
  templateChanged,
  fileUrl,
  deal,
  newerRevision,
  offerings,
  limitedToOwnDeals,
  sellerChoices,
}: {
  /** Server-built PDF input (buildQuoteRenderInput) for the saved quote. */
  renderInput: QuoteRenderInput;
  canManage: boolean;
  canSetDealValue: boolean;
  templateChanged: boolean;
  fileUrl: string | null;
  deal: EditorDeal | null;
  newerRevision: { id: string; revision: number } | null;
  offerings: OfferingChoice[];
  /** Reps: the deal picker lists only their own and unassigned deals. */
  limitedToOwnDeals: boolean;
  /** Seller profiles (Invoice settings) this draft can be issued from; [] when not editable. */
  sellerChoices: QuoteSellerChoice[];
}) {
  const router = useRouter();
  const quote = renderInput.quote;
  const body = renderInput.body;
  const editable = quote.status === 'draft' && canManage;

  const [form, setForm] = useState<QuoteEditorForm>(() => formFromQuote(quote));
  const [saved, setSaved] = useState(() => snapshotOf(formFromQuote(quote)));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  // Inputs freeze while a save is in flight: the refresh after it remounts
  // the editor from the server copy, which would drop keystrokes typed meanwhile.
  const readOnly = !editable || saving;

  const dirty = editable && snapshotOf(form) !== saved;
  useUnsavedChangesWarning(dirty, 'You have unsaved changes to this quote. Leave without saving?');

  const totals = useMemo(() => formTotals(form), [form]);
  const sellers = useMemo(() => Object.fromEntries(sellerChoices.map((c) => [c.id, c.seller])), [sellerChoices]);
  // Draft: the server input with only `quote` replaced by the form's edits.
  // Otherwise: exactly what the server renders.
  const previewInput = useMemo(() => {
    if (!editable) return renderInput;
    const q = previewQuote(quote, form, sellers);
    if (!q) return null;
    return { ...renderInput, quote: q, placeholderValues: { ...renderInput.placeholderValues, 'seller.name': q.seller.name } };
  }, [editable, renderInput, quote, form, sellers]);

  function save() {
    const sent = form;
    startSaving(async () => {
      const res = await updateQuoteDraftAction(quote.id, formToDraftInput(sent));
      if (!res.ok) {
        setErrors(mapErrors(res.fieldErrors));
        setFormError(friendlyMessage(res.error));
        toast.error(friendlyMessage(res.error));
        return;
      }
      setErrors({});
      setFormError(null);
      setSaved(snapshotOf(sent));
      toast.success('Quote saved');
      router.refresh();
    });
  }

  const ref = `${quote.quoteNumber} · Rev ${quote.revision}`;
  const groupByLabel = body.sections.some((s) => s.type === 'line_items' && s.settings.groupByLabel);

  function renderSection(s: QuoteSection): ReactNode {
    const title = s.title.trim() || SECTION_NAMES[s.type];
    switch (s.type) {
      case 'client':
        return (
          <SectionCard key={s.id} title={title}>
            <ClientDetailsEditor
              section={s}
              buyer={form.buyer}
              consignee={form.consignee}
              onBuyerChange={(buyer) => setForm((f) => ({ ...f, buyer }))}
              onConsigneeChange={(consignee) => setForm((f) => ({ ...f, consignee }))}
              errors={errors}
              readOnly={readOnly}
            />
          </SectionCard>
        );
      case 'line_items':
        return (
          <SectionCard key={s.id} title={title}>
            <LineItemsTable
              items={form.items}
              onChange={(items) => setForm((f) => ({ ...f, items }))}
              overallDiscount={form.overallDiscount}
              onOverallDiscountChange={(overallDiscount) => setForm((f) => ({ ...f, overallDiscount }))}
              totals={totals}
              groupByLabel={groupByLabel}
              offerings={offerings}
              errors={errors}
              readOnly={readOnly}
              newKey={newKey}
            />
          </SectionCard>
        );
      case 'text':
      case 'terms':
      case 'payment_schedule':
        if (s.settings.repEditable) {
          return (
            <SectionCard key={s.id} title={title}>
              <SectionContentEditor
                section={s}
                content={form.content[s.id]}
                onChange={(c) => setForm((f) => ({ ...f, content: { ...f.content, [s.id]: c } }))}
                errors={errors}
                readOnly={readOnly}
              />
            </SectionCard>
          );
        }
        return <ReadOnlySection key={s.id} title={title} note="Set by the template." />;
      default:
        return <ReadOnlySection key={s.id} title={title} note={READ_ONLY_NOTE[s.type] ?? 'Set by the template.'} />;
    }
  }

  return (
    <main className="mx-auto w-full max-w-[88rem] space-y-4 px-4 py-6 sm:px-5 lg:px-6">
      <header className="space-y-3">
        <QuoteDealLink
          quoteId={quote.id}
          deal={deal ? { id: deal.id, name: deal.name } : null}
          canChange={editable}
          dirty={dirty}
          limitedToOwnDeals={limitedToOwnDeals}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">{ref}</h1>
            <QuoteStatusBadge status={quote.status} />
            {editable ? (
              <span className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
            ) : null}
          </div>
          <QuoteActionsBar
            quoteId={quote.id}
            status={quote.status}
            revision={quote.revision}
            canManage={canManage}
            canSetDealValue={canSetDealValue}
            dirty={dirty}
            saving={saving}
            onSave={save}
            templateChanged={templateChanged}
            fileUrl={fileUrl}
            deal={deal}
            linkedToDeal={quote.dealId !== null}
            dealValueMinor={quote.totals.taxableMinor}
          />
        </div>
        <StatusNotice
          status={quote.status}
          revision={quote.revision}
          canManage={canManage}
          newerRevision={newerRevision}
          linkedToDeal={quote.dealId !== null}
        />
        {formError ? (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            {formError}
          </p>
        ) : null}
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <SectionCard title="Quote details">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <DateField label="Quote date" value={form.quoteDate} onChange={(quoteDate) => setForm((f) => ({ ...f, quoteDate }))} errors={errors.quoteDate} readOnly={readOnly} />
              <DateField label="Valid until" value={form.validUntil} onChange={(validUntil) => setForm((f) => ({ ...f, validUntil }))} errors={errors.validUntil} readOnly={readOnly} />
            </div>
            {editable && sellerChoices.length > 1 ? (
              <SellerField
                choices={sellerChoices}
                value={form.sellerProfileId}
                onChange={(sellerProfileId) => setForm((f) => ({ ...f, sellerProfileId }))}
                errors={errors.sellerProfileId}
                readOnly={readOnly}
              />
            ) : null}
          </SectionCard>
          {body.sections.filter((s) => s.enabled).map(renderSection)}
        </div>

        <div className="h-[80vh] xl:sticky xl:top-20">
          <QuotePdfPreview
            input={previewInput}
            caption={editable ? 'unsaved edits included' : undefined}
            invalidMessage="Some numbers can’t be read yet. Showing the last valid version."
          />
        </div>
      </div>
    </main>
  );
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <h2 className="mb-3 text-[13.5px] font-semibold text-slate-900 dark:text-[#FAFAFA]">{title}</h2>
      {children}
    </section>
  );
}

function ReadOnlySection({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-slate-200 px-4 py-2 text-[12.5px] dark:border-[#262626]">
      <span className="font-medium text-slate-700 dark:text-[#D4D4D8]">{title}</span>
      <span className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">{note}</span>
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
  errors,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  errors?: string[];
  readOnly: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">{label}</span>
      <input type="date" className={cn(inputCls, 'py-1.5', errorCls(errors))} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
      <FieldErrors messages={errors} />
    </label>
  );
}

/** Which seller profile (state GSTIN, address, bank) the quote is issued from. */
function SellerField({
  choices,
  value,
  onChange,
  errors,
  readOnly,
}: {
  choices: QuoteSellerChoice[];
  value: string | null;
  onChange: (v: string | null) => void;
  errors?: string[];
  readOnly: boolean;
}) {
  const known = value !== null && choices.some((c) => c.id === value);
  return (
    <label className="mt-2 block space-y-1">
      <span className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Seller</span>
      <select
        className={cn(inputCls, 'py-1.5', errorCls(errors))}
        value={known ? value! : ''}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {!known ? <option value="">Choose a seller…</option> : null}
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.seller.name} · {c.label}
          </option>
        ))}
      </select>
      <span className="block text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
        GSTIN, address and bank details printed on the quote. Edit them in Invoice settings.
      </span>
      <FieldErrors messages={errors} />
    </label>
  );
}

function StatusNotice({
  status,
  revision,
  canManage,
  newerRevision,
  linkedToDeal,
}: {
  status: QuoteEditorStatus;
  revision: number;
  canManage: boolean;
  newerRevision: { id: string; revision: number } | null;
  linkedToDeal: boolean;
}) {
  const cls = 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:border-[#262626] dark:bg-[#111111] dark:text-[#A1A1AA]';
  if (status === 'superseded') {
    return (
      <p className={cls}>
        Rev {revision} has been replaced and can no longer change.{' '}
        {newerRevision ? (
          <Link href={`/dashboard/quotes/${newerRevision.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Open Rev {newerRevision.revision}
          </Link>
        ) : null}
      </p>
    );
  }
  if (status === 'sent') {
    return (
      <p className={cls}>
        Rev {revision} was sent and is locked{linkedToDeal ? '; its PDF is filed on the deal' : ''}.
        {canManage ? ' To change it, create a new revision.' : ''}
      </p>
    );
  }
  if (!canManage) return <p className={cls}>You can view and download this quote, but not edit it.</p>;
  return null;
}

type QuoteEditorStatus = QuoteRenderInput['quote']['status'];
