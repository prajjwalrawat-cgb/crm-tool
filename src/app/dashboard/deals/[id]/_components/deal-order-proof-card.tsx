'use client';

import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  FileText,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  ORDER_PROOF_TYPES,
  type OrderProofAiRead,
  type OrderProofType,
} from '@/lib/order-proofs/types';
import {
  formatCurrency,
  fromMinorUnits,
  KNOWN_CURRENCIES,
  toMinorUnits,
} from '@/lib/deals/currency';
import {
  matchOrderProofs,
  ORDER_PROOF_FILE_TYPES,
  ORDER_PROOF_MAX_BYTES,
  ORDER_PROOF_TYPE_LABELS,
  orderProofProblem,
  type OrderProofMatch,
} from '@/lib/order-proofs/shared';
import { cn } from '@/lib/utils';

import { patchDealAction } from '../../actions';
import {
  readOrderProofAction,
  removeOrderProofAction,
  submitOrderProofAction,
} from '../order-proof-actions';

export type OrderProofView = {
  id: string;
  proofType: OrderProofType;
  referenceNo: string;
  issuedOn: string | null;
  buyerName: string | null;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  aiRead: OrderProofAiRead | null;
  submittedBy: string;
  createdAt: string;
  fileName: string;
  fileUrl: string;
};

type Draft = {
  proofType: OrderProofType;
  referenceNo: string;
  issuedOn: string;
  buyerName: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
};

/**
 * The client's order confirmation on a deal (0071). A deal is Won only on a
 * PO (or other order proof) whose value before tax equals the deal value; this
 * card is where the rep attaches it, checks what the AI read off it, and sees
 * — before anyone tries to win the deal — whether the numbers agree.
 */
export function DealOrderProofCard({
  dealId,
  stage,
  amountMinor,
  currency,
  amountDerived,
  proofs,
  canEdit,
  aiReads,
  authorLookup,
}: {
  dealId: string;
  stage: string;
  amountMinor: number;
  currency: string;
  /** Amount comes from unit price × qty, so it isn't set directly. */
  amountDerived: boolean;
  proofs: OrderProofView[];
  canEdit: boolean;
  /** The AI reads uploaded POs on this workspace. */
  aiReads: boolean;
  authorLookup: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const isWon = stage === 'won';
  const deal = { amountMinor, currency };
  const match = matchOrderProofs(deal, proofs);

  function remove(proof: OrderProofView) {
    if (!window.confirm(`Remove PO ${proof.referenceNo} and its file from this deal?`)) return;
    startTransition(async () => {
      const result = await removeOrderProofAction({ id: proof.id, dealId });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('PO removed');
      router.refresh();
    });
  }

  function alignDealValue(proofMinor: number) {
    const value = formatCurrency(proofMinor, currency);
    if (!window.confirm(`Set the deal value to ${value}, the PO value before tax?`)) return;
    startTransition(async () => {
      const result = await patchDealAction({ id: dealId, amount: fromMinorUnits(proofMinor, currency) });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Deal value set to ${value}`);
      router.refresh();
    });
  }

  return (
    <section
      id="order-confirmation"
      className="scroll-mt-20 rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <FileCheck2 className="h-3.5 w-3.5 text-teal-600" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">Order confirmation</h2>
          <span className="text-[11px] text-slate-400">client PO</span>
        </div>
        <StatusPill match={match} isWon={isWon} />
      </header>

      <MatchSummary
        match={match}
        deal={deal}
        isWon={isWon}
        canFix={canEdit && !amountDerived}
        amountDerived={amountDerived}
        pending={pending}
        onAlign={alignDealValue}
      />

      {proofs.length > 0 ? (
        <ul className="mt-3 flex flex-col divide-y divide-slate-100">
          {proofs.map((p) => (
            <ProofRow
              key={p.id}
              proof={p}
              submittedBy={authorLookup[p.submittedBy] ?? 'Someone'}
              canRemove={canEdit && !isWon}
              pending={pending}
              onRemove={() => remove(p)}
            />
          ))}
        </ul>
      ) : null}

      {canEdit ? (
        adding ? (
          <AddProofForm
            dealId={dealId}
            deal={deal}
            existingMinor={proofs.reduce((s, p) => s + p.subtotalMinor, 0)}
            aiReads={aiReads}
            onDone={() => {
              setAdding(false);
              router.refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-600"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden />
            {proofs.length === 0 ? 'Attach client PO' : 'Attach another PO'}
          </button>
        )
      ) : null}
    </section>
  );
}

function StatusPill({ match, isWon }: { match: OrderProofMatch; isWon: boolean }) {
  const [label, tone] =
    match.state === 'match'
      ? ['Matches deal value', 'bg-emerald-100 text-emerald-700']
      : match.state === 'none'
        ? isWon
          ? ['PO missing', 'bg-rose-100 text-rose-700']
          : ['Needed for Won', 'bg-slate-100 text-slate-600']
        : ['Doesn’t match', 'bg-amber-100 text-amber-800'];
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10.5px] font-semibold', tone)}>{label}</span>
  );
}

function MatchSummary({
  match,
  deal,
  isWon,
  canFix,
  amountDerived,
  pending,
  onAlign,
}: {
  match: OrderProofMatch;
  deal: { amountMinor: number; currency: string };
  isWon: boolean;
  canFix: boolean;
  amountDerived: boolean;
  pending: boolean;
  onAlign: (proofMinor: number) => void;
}) {
  if (match.state === 'none') {
    return (
      <p
        className={cn(
          'rounded-md px-3 py-2 text-[12px]',
          isWon ? 'bg-rose-50 text-rose-800' : 'bg-slate-50 text-slate-600',
        )}
      >
        {isWon
          ? 'This deal was marked Won before a PO was required. Attach the client’s PO so its value is on record.'
          : 'This deal can be moved to Won only after the client’s PO (or other order confirmation) is attached, and its value before tax matches the deal value.'}
      </p>
    );
  }

  const proofMinor = match.state === 'currency' ? null : match.proofMinor;
  const problem = orderProofProblem(deal, match);
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2',
        problem ? 'border-amber-200 bg-amber-50/60' : 'border-emerald-200 bg-emerald-50/50',
      )}
    >
      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <dt className="text-slate-500">Deal value</dt>
          <dd className="text-[13px] font-semibold tabular-nums text-slate-900">
            {formatCurrency(deal.amountMinor, deal.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">PO value (before tax)</dt>
          <dd className="text-[13px] font-semibold tabular-nums text-slate-900">
            {proofMinor == null ? '—' : formatCurrency(proofMinor, deal.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Gap</dt>
          <dd
            className={cn(
              'text-[13px] font-semibold tabular-nums',
              problem ? 'text-amber-700' : 'text-emerald-700',
            )}
          >
            {match.state === 'gap'
              ? formatCurrency(Math.abs(match.gapMinor), deal.currency)
              : match.state === 'match'
                ? 'None'
                : '—'}
          </dd>
        </div>
      </dl>
      {problem ? (
        <div className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
          <div className="min-w-0">
            <p>
              {problem}
              {!isWon ? ' Until then the deal can’t be moved to Won.' : ''}
            </p>
            {match.state === 'gap' && canFix ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onAlign(match.proofMinor)}
                className="mt-1.5 inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11.5px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Set deal value to {formatCurrency(match.proofMinor, deal.currency)}
              </button>
            ) : null}
            {match.state === 'gap' && amountDerived ? (
              <p className="mt-1 text-[11px] text-amber-800">
                The deal value comes from unit price × quantity — change those to match the PO.
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-emerald-800">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          The PO confirms the deal value.
        </p>
      )}
    </div>
  );
}

function ProofRow({
  proof,
  submittedBy,
  canRemove,
  pending,
  onRemove,
}: {
  proof: OrderProofView;
  submittedBy: string;
  canRemove: boolean;
  pending: boolean;
  onRemove: () => void;
}) {
  const ai = proof.aiRead;
  // Where the rep's figures differ from what the AI read off the document.
  const corrected: string[] = [];
  if (ai) {
    const aiSubtotal = ai.subtotal == null ? null : toMinorUnits(ai.subtotal, proof.currency);
    if (aiSubtotal != null && aiSubtotal !== proof.subtotalMinor) {
      corrected.push(`value before tax (AI read ${formatCurrency(aiSubtotal, proof.currency)})`);
    }
    if (ai.referenceNo && ai.referenceNo.trim() !== proof.referenceNo.trim()) {
      corrected.push(`PO number (AI read ${ai.referenceNo})`);
    }
  }
  return (
    <li className="flex items-start gap-2 py-2.5">
      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <a
            href={proof.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12.5px] font-semibold text-slate-800 hover:text-indigo-600"
          >
            {ORDER_PROOF_TYPE_LABELS[proof.proofType]} {proof.referenceNo}
          </a>
          <span className="text-[12px] tabular-nums text-slate-700">
            {formatCurrency(proof.subtotalMinor, proof.currency)}
            <span className="text-slate-400"> + tax {formatCurrency(proof.taxMinor, proof.currency)}</span>
            <span className="text-slate-400"> = {formatCurrency(proof.totalMinor, proof.currency)}</span>
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
          {proof.buyerName ? <span>{proof.buyerName}</span> : null}
          {proof.issuedOn ? <span>· dated {proof.issuedOn}</span> : null}
          <span>· {proof.fileName}</span>
          <span>· {submittedBy}</span>
          {ai ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-violet-50 px-1 font-medium text-violet-700">
              <Sparkles className="h-2.5 w-2.5" aria-hidden /> AI-read
            </span>
          ) : (
            <span className="rounded bg-slate-100 px-1 font-medium text-slate-500">Entered by hand</span>
          )}
        </div>
        {corrected.length > 0 ? (
          <p className="mt-1 text-[11px] text-amber-700">Corrected by {submittedBy}: {corrected.join('; ')}.</p>
        ) : null}
      </div>
      {canRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          aria-label={`Remove PO ${proof.referenceNo}`}
          className="shrink-0 text-slate-300 hover:text-rose-500 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

const asText = (n: number | null | undefined) => (n == null ? '' : String(n));

function AddProofForm({
  dealId,
  deal,
  existingMinor,
  aiReads,
  onDone,
  onCancel,
}: {
  dealId: string;
  deal: { amountMinor: number; currency: string };
  existingMinor: number;
  aiReads: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState<OrderProofAiRead | null>(null);
  const [seal, setSeal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [submitting, startSubmit] = useTransition();
  const [draft, setDraft] = useState<Draft>({
    proofType: 'purchase_order',
    referenceNo: '',
    issuedOn: '',
    buyerName: '',
    currency: deal.currency,
    subtotal: '',
    tax: '',
    total: '',
  });
  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  async function pick(picked: File | null) {
    if (!picked) return;
    if (!(ORDER_PROOF_FILE_TYPES as readonly string[]).includes(picked.type)) {
      toast.error('Upload the PO as a PDF or an image (JPG, PNG, WebP).');
      return;
    }
    if (picked.size > ORDER_PROOF_MAX_BYTES) {
      toast.error('The file is too large (max 10 MB).');
      return;
    }
    setFile(picked);
    setRead(null);
    setSeal(null);
    setNotice(null);
    if (!aiReads) return;
    setReading(true);
    try {
      const fd = new FormData();
      fd.set('dealId', dealId);
      fd.set('file', picked);
      const result = await readOrderProofAction(fd);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setNotice(result.notice);
      if (result.read) {
        const r = result.read;
        setRead(r);
        setSeal(result.seal);
        setDraft((d) => ({
          ...d,
          referenceNo: r.referenceNo ?? d.referenceNo,
          issuedOn: r.issuedOn ?? d.issuedOn,
          buyerName: r.buyerName ?? d.buyerName,
          currency: r.currency && (KNOWN_CURRENCIES as readonly string[]).includes(r.currency) ? r.currency : d.currency,
          subtotal: asText(r.subtotal) || d.subtotal,
          tax: asText(r.tax) || d.tax,
          total: asText(r.total) || d.total,
        }));
      }
    } finally {
      setReading(false);
    }
  }

  function submit() {
    if (!file) return;
    startSubmit(async () => {
      const fd = new FormData();
      fd.set('dealId', dealId);
      fd.set('file', file);
      for (const [k, v] of Object.entries(draft)) fd.set(k, v);
      if (seal) fd.set('seal', seal);
      const result = await submitOrderProofAction(fd);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.message);
        return;
      }
      toast.success('PO submitted');
      onDone();
    });
  }

  // What the deal's POs come to with this one — shown before submitting so a
  // gap is visible while the rep still has the document open.
  const subtotalNum = Number(draft.subtotal);
  const preview =
    draft.subtotal && Number.isFinite(subtotalNum) && subtotalNum > 0
      ? draft.currency !== deal.currency
        ? null
        : matchOrderProofs(deal, [
            { subtotalMinor: existingMinor, currency: deal.currency },
            { subtotalMinor: toMinorUnits(subtotalNum, deal.currency), currency: deal.currency },
          ])
      : null;
  const subtotalFromAi = read?.subtotal != null && Number(draft.subtotal) !== read.subtotal;

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft.proofType}
          onChange={(e) => set('proofType')(e.target.value)}
          className="rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800"
          aria-label="Kind of order confirmation"
        >
          {ORDER_PROOF_TYPES.map((t) => (
            <option key={t} value={t}>
              {ORDER_PROOF_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={reading || submitting}
          className="inline-flex items-center gap-1.5 rounded border border-dashed border-slate-300 bg-white px-2.5 py-1 text-[12px] text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50"
        >
          {reading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />}
          {file ? file.name : 'Choose PO file (PDF or image)'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ORDER_PROOF_FILE_TYPES.join(',')}
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
      </div>

      {reading ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-violet-700">
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Reading the PO…
        </p>
      ) : null}
      {read ? (
        <div className="mt-2 rounded border border-violet-200 bg-violet-50/60 px-2.5 py-1.5 text-[11.5px] text-violet-900">
          <span className="inline-flex items-center gap-1 font-medium">
            <Sparkles className="h-3 w-3" aria-hidden /> Filled in from the document ({read.confidence} confidence).
          </span>{' '}
          Check every figure against the PO before submitting.
          {read.notes ? <span className="block text-violet-800">Note: {read.notes}</span> : null}
          {read.confidence === 'low' ? (
            <span className="mt-0.5 flex items-center gap-1 font-medium text-rose-700">
              <XCircle className="h-3 w-3" aria-hidden /> This may not be an order confirmation.
            </span>
          ) : null}
        </div>
      ) : null}
      {notice ? <p className="mt-2 text-[11.5px] text-slate-500">{notice}</p> : null}
      {!aiReads && file ? (
        <p className="mt-2 text-[11.5px] text-slate-500">Enter the details as printed on the PO.</p>
      ) : null}

      {file && !reading ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Field label="PO / order number *" error={errors.referenceNo}>
              <input value={draft.referenceNo} onChange={(e) => set('referenceNo')(e.target.value)} className={inputCls} />
            </Field>
            <Field label="PO date" error={errors.issuedOn}>
              <input type="date" value={draft.issuedOn} onChange={(e) => set('issuedOn')(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Client (buyer)" error={errors.buyerName}>
              <input value={draft.buyerName} onChange={(e) => set('buyerName')(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Currency" error={errors.currency}>
              <select value={draft.currency} onChange={(e) => set('currency')(e.target.value)} className={inputCls}>
                {KNOWN_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Value before tax *"
              error={errors.subtotal}
              hint={subtotalFromAi && read?.subtotal != null ? `AI read ${read.subtotal}` : undefined}
            >
              <input inputMode="decimal" value={draft.subtotal} onChange={(e) => set('subtotal')(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Tax (GST etc.)" error={errors.tax}>
              <input inputMode="decimal" value={draft.tax} onChange={(e) => set('tax')(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Total incl. tax" error={errors.total}>
              <input
                inputMode="decimal"
                value={draft.total}
                placeholder="value + tax"
                onChange={(e) => set('total')(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          {draft.currency !== deal.currency ? (
            <p className="mt-2 text-[12px] text-rose-700">
              The deal is in {deal.currency}. Change the deal&apos;s currency to {draft.currency} before submitting this PO.
            </p>
          ) : preview ? (
            <p
              className={cn(
                'mt-2 text-[12px]',
                preview.state === 'match' ? 'text-emerald-700' : 'text-amber-800',
              )}
            >
              {preview.state === 'match'
                ? `With this PO the deal’s POs come to ${formatCurrency(preview.proofMinor, deal.currency)} before tax — matches the deal value.`
                : preview.state === 'gap'
                  ? `With this PO the deal’s POs come to ${formatCurrency(preview.proofMinor, deal.currency)} before tax; the deal value is ${formatCurrency(deal.amountMinor, deal.currency)}. The gap of ${formatCurrency(Math.abs(preview.gapMinor), deal.currency)} has to be resolved before the deal can be Won.`
                  : null}
            </p>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={submitting || !draft.referenceNo.trim() || !draft.subtotal}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Submit PO
            </button>
            <button type="button" onClick={onCancel} className="text-[12px] text-slate-500 hover:text-slate-800">
              Cancel
            </button>
          </div>
        </>
      ) : !reading ? (
        <div className="mt-2">
          <button type="button" onClick={onCancel} className="text-[12px] text-slate-500 hover:text-slate-800">
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

const inputCls =
  'w-full rounded border border-slate-200 bg-white px-2 py-1 text-[12.5px] text-slate-800 focus:border-indigo-400 focus:outline-none';

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string[];
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint ? <span className="text-[10.5px] text-violet-700">{hint}</span> : null}
      {error?.[0] ? <span className="text-[10.5px] text-rose-600">{error[0]}</span> : null}
    </label>
  );
}
