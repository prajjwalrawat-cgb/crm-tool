'use client';

import { FileText, Link2, Loader2, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { createQuoteAction } from '@/lib/quotes/actions';
import type { QuoteDealOption } from '@/lib/quotes/queries';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { DealPicker } from './deal-picker';

export type QuoteTemplateChoice = { id: string; name: string; isDefault: boolean };

/** Centered dialog shell: backdrop click and Escape close it unless `busy`. */
export function QuoteModal({
  title,
  description,
  onClose,
  busy,
  children,
  footer,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  busy?: boolean;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 px-4 py-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-xl rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-[#262626] dark:bg-[#0F0F0F]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4 dark:border-[#1F1F1F]">
          <div>
            <h2 id={titleId} className="text-[16px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {title}
            </h2>
            {description ? <p className="mt-0.5 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-[#181818]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">{children}</div>
        <div className="flex justify-end gap-2 rounded-b-xl border-t border-slate-100 bg-slate-50/60 px-6 py-3 dark:border-[#1F1F1F] dark:bg-[#111111]">
          {footer}
        </div>
      </div>
    </div>
  );
}

/** "New quote" on the Quotes page: link it to a deal or not, pick a template, open the editor. */
export function NewQuoteButton({
  templates,
  limitedToOwnDeals,
}: {
  templates: QuoteTemplateChoice[];
  limitedToOwnDeals: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> New quote
      </Button>
      {open ? (
        <NewQuoteDialog templates={templates} limitedToOwnDeals={limitedToOwnDeals} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

type Mode = 'deal' | 'none';

function NewQuoteDialog({
  templates,
  limitedToOwnDeals,
  onClose,
}: {
  templates: QuoteTemplateChoice[];
  limitedToOwnDeals: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>('deal');
  const [deal, setDeal] = useState<QuoteDealOption | null>(null);
  const defaultTemplateId = (templates.find((t) => t.isDefault) ?? templates[0])?.id ?? '';
  const [templateId, setTemplateId] = useState(defaultTemplateId);

  const ready = mode === 'none' || deal !== null;

  function create() {
    if (!ready) return;
    startTransition(async () => {
      const res = await createQuoteAction({
        dealId: mode === 'deal' && deal ? deal.id : null,
        ...(templateId ? { templateId } : {}),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.push(`/dashboard/quotes/${res.id}`);
    });
  }

  return (
    <QuoteModal
      title="New quote"
      description="Choose who the quote is for. You can change the linked deal later while it is a draft."
      onClose={onClose}
      busy={pending}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} disabled={pending || !ready} title={ready ? undefined : 'Pick a deal first'}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Create quote
          </Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-2 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Link this quote to</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
          <ModeCard
            checked={mode === 'deal'}
            onSelect={() => setMode('deal')}
            icon={<Link2 className="h-4 w-4" aria-hidden />}
            title="A deal"
            hint="Client details come from the deal."
            disabled={pending}
          />
          <ModeCard
            checked={mode === 'none'}
            onSelect={() => setMode('none')}
            icon={<FileText className="h-4 w-4" aria-hidden />}
            title="No deal"
            hint="A standalone quote; you enter the client."
            disabled={pending}
          />
        </div>
      </fieldset>

      {mode === 'deal' ? (
        <div>
          <span className="mb-2 block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
            Deal{deal ? <span className="font-normal text-slate-500 dark:text-[#A1A1AA]"> · {deal.name}</span> : null}
          </span>
          <DealPicker
            selectedId={deal?.id ?? null}
            onSelect={setDeal}
            limitedToOwnDeals={limitedToOwnDeals}
            disabled={pending}
            autoFocus
          />
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-200 px-4 py-3 text-[12.5px] text-slate-600 dark:border-[#2A2A2A] dark:text-[#A1A1AA]">
          The quote opens with an empty client. Fill in the client’s name and details in the editor.
        </p>
      )}

      {templates.length > 1 ? (
        <label className="block">
          <span className="mb-2 block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Template</span>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={pending} className={inputCls}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.isDefault ? `${t.name} (default)` : t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </QuoteModal>
  );
}

function ModeCard({
  checked,
  onSelect,
  icon,
  title,
  hint,
  disabled,
}: {
  checked: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-3 text-left transition',
        checked
          ? 'border-indigo-500 bg-indigo-50/60 ring-2 ring-indigo-500/20 dark:bg-indigo-500/10'
          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-[#2A2A2A] dark:hover:bg-[#161616]',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          checked ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 dark:bg-[#1F1F1F]',
        )}
      >
        {icon}
      </span>
      <span>
        <span className="block text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{title}</span>
        <span className="block text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">{hint}</span>
      </span>
    </button>
  );
}
