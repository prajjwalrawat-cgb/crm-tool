'use client';

import { Package, Plus, Star, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  type DealOfferingRow,
  groupByCategory,
  OFFERING_CATEGORY_CHIP,
  OFFERING_CATEGORY_LABELS,
  OFFERING_CATEGORY_PLURAL,
  type OfferingOption,
  UNCATEGORIZED_LABEL,
} from '@/lib/offerings/types';
import { cn } from '@/lib/utils';

import {
  addDealOfferingAction,
  removeDealOfferingAction,
  setPrimaryDealOfferingAction,
} from '../offering-actions';

/**
 * Offerings on an EXISTING deal.
 *
 * Editing here is optional, unlike on the create form. Every deal that
 * predates 0066 is untagged and there is no backfill, so this card nudges
 * (an amber prompt, once) and never blocks: nothing on this page refuses to
 * save because the deal has no offering. The team works the backlog down via
 * the Uncategorized filter on the deals list, one deal at a time, when
 * somebody knows the answer.
 *
 * Retired offerings already tagged on the deal keep rendering, struck
 * through — that is the promise the `active` flag makes and the reason
 * nothing in this feature deletes a catalog row.
 */
export function DealOfferingsCard({
  dealId,
  initialOfferings,
  offeringOptions,
  canEdit,
}: {
  dealId: string;
  initialOfferings: DealOfferingRow[];
  /** ACTIVE catalog entries only — the picker must not offer retired ones. */
  offeringOptions: OfferingOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, startTransition] = useTransition();

  const taggedIds = new Set(initialOfferings.map((o) => o.id));
  const term = query.trim().toLowerCase();
  const available = offeringOptions.filter(
    (o) => !taggedIds.has(o.id) && o.name.toLowerCase().includes(term),
  );

  function run(
    fn: () => Promise<{ ok: boolean; message?: string }>,
    success?: string,
  ) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.error(result.message ?? 'Something went wrong');
        return;
      }
      if (success) toast.success(success);
      setAdding(false);
      setQuery('');
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Offerings
          </span>
        </div>
        {canEdit && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
          >
            <Plus className="h-3 w-3" aria-hidden />
            Add
          </button>
        ) : null}
      </div>

      {initialOfferings.length === 0 ? (
        <p className="rounded-md border border-dashed border-amber-200 bg-amber-50/60 px-2 py-2 text-[11.5px] text-amber-700">
          <span className="font-medium">{UNCATEGORIZED_LABEL}.</span> This deal
          isn&apos;t in any offering&apos;s funnel yet. Tag what it sells when
          you know — nothing else here is blocked by it.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-100">
          {initialOfferings.map((o) => {
            const isLastTag = initialOfferings.length === 1;
            return (
            <li key={o.linkId} className="flex items-center gap-2 py-1.5">
              {canEdit ? (
                <button
                  type="button"
                  aria-label={
                    o.isPrimary ? 'Primary offering' : `Make ${o.name} primary`
                  }
                  disabled={pending || o.isPrimary}
                  onClick={() =>
                    run(
                      () =>
                        setPrimaryDealOfferingAction({
                          id: o.linkId,
                          dealId,
                        }),
                      `${o.name} is now the primary offering`,
                    )
                  }
                  className="shrink-0"
                >
                  <Star
                    className={cn(
                      'h-3.5 w-3.5',
                      o.isPrimary
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-slate-300 hover:text-amber-400',
                    )}
                    aria-hidden
                  />
                </button>
              ) : o.isPrimary ? (
                <Star
                  className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400"
                  aria-hidden
                />
              ) : (
                <span className="h-3.5 w-3.5 shrink-0" />
              )}

              <span
                className={cn(
                  'shrink-0 rounded border px-1 py-0 text-[10px] font-medium uppercase tracking-wide',
                  OFFERING_CATEGORY_CHIP[o.category],
                )}
              >
                {OFFERING_CATEGORY_LABELS[o.category]}
              </span>

              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-800',
                  !o.active && 'text-slate-400 line-through',
                )}
                title={
                  o.active
                    ? undefined
                    : `${o.name} has been retired from the catalog — it stays on this deal and in its funnel`
                }
              >
                {o.name}
              </span>

              {canEdit ? (
                // A tagged deal can't be emptied — see removeDealOfferingAction.
                // Disabled rather than clickable-then-rejected: the constraint
                // is knowable from what's on screen, so showing it beats a
                // toast that arrives after the click.
                <button
                  type="button"
                  aria-label={
                    isLastTag
                      ? `Can't remove ${o.name} — it's the only offering on this deal`
                      : `Remove ${o.name}`
                  }
                  title={
                    isLastTag
                      ? 'Add the replacement first — a tagged deal can’t be left with no offering.'
                      : undefined
                  }
                  disabled={pending || isLastTag}
                  onClick={() =>
                    run(
                      () =>
                        removeDealOfferingAction({ id: o.linkId, dealId }),
                      'Offering removed',
                    )
                  }
                  className="shrink-0 text-slate-300 transition hover:text-rose-500 disabled:cursor-not-allowed disabled:hover:text-slate-200"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </li>
            );
          })}
        </ul>
      )}

      {initialOfferings.length === 1 ? (
        <p className="mt-1.5 text-[10.5px] text-slate-400">
          To change what this deal sells, add the replacement first — a tagged
          deal can&apos;t be left with no offering.
        </p>
      ) : null}

      {initialOfferings.length > 1 ? (
        <p className="mt-1.5 text-[10.5px] text-slate-400">
          The starred offering labels this deal in the list. All{' '}
          {initialOfferings.length} count toward their own funnels.
        </p>
      ) : null}

      {adding ? (
        <div className="mt-2 border-t border-slate-200 pt-2">
          <div className="mb-1.5 flex items-center gap-2">
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search offerings…"
              className="w-full rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setQuery('');
              }}
              aria-label="Close"
              className="shrink-0 text-slate-400 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          {available.length === 0 ? (
            <p className="text-[11px] text-slate-500">
              {offeringOptions.length === 0
                ? 'No active offerings. An admin can add them in Settings → Offerings.'
                : 'Nothing left to add.'}
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto rounded border border-slate-100">
              {groupByCategory(available).map(({ category, items }) =>
                items.length === 0 ? null : (
                  <div key={category}>
                    <div className="bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {OFFERING_CATEGORY_PLURAL[category]}
                    </div>
                    {items.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () =>
                              addDealOfferingAction({
                                dealId,
                                offeringId: o.id,
                              }),
                            `${o.name} tagged`,
                          )
                        }
                        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-indigo-50 disabled:opacity-50"
                      >
                        <Plus
                          className="h-3 w-3 shrink-0 text-slate-400"
                          aria-hidden
                        />
                        <span className="truncate">{o.name}</span>
                      </button>
                    ))}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
