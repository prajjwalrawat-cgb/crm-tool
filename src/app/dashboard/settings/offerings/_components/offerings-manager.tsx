'use client';

import {
  ArrowDown,
  ArrowUp,
  Check,
  Loader2,
  Pencil,
  Plus,
  Undo2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  OFFERING_CATEGORIES,
  OFFERING_CATEGORY_CHIP,
  OFFERING_CATEGORY_LABELS,
  OFFERING_CATEGORY_PLURAL,
  type OfferingCategory,
} from '@/lib/offerings/types';
import { cn } from '@/lib/utils';

import {
  createOfferingAction,
  reorderOfferingsAction,
  setOfferingActiveAction,
  setOfferingsEnabledAction,
  updateOfferingAction,
} from '../actions';

/** The subset of an offering this page renders. */
export type OfferingListItem = {
  id: string;
  name: string;
  category: OfferingCategory;
  active: boolean;
  sortOrder: number;
  dealCount: number;
};

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#FAFAFA]';

export function OfferingsManager({
  enabled: initialEnabled,
  initial,
}: {
  enabled: boolean;
  initial: OfferingListItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initialEnabled);

  // Optimistic flip, reverted on failure — same shape as the Stage Gates
  // switch, so the two workspace kill-switches behave identically.
  function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      const res = await setOfferingsEnabledAction(next);
      if (!res.ok) {
        setEnabled(!next);
        toast.error(res.message);
        return;
      }
      toast.success(
        next
          ? 'Offerings turned on — new deals now require one'
          : 'Offerings turned off — hidden everywhere, nothing deleted',
      );
      router.refresh();
    });
  }

  // Add-form state.
  const [name, setName] = useState('');
  const [category, setCategory] = useState<OfferingCategory>('product');

  const [editingId, setEditingId] = useState<string | null>(null);

  function run(
    action: () => Promise<{ ok: boolean; message?: string }>,
    okMsg?: string,
  ) {
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        toast.error(res.message ?? 'Something went wrong');
        return;
      }
      if (okMsg) toast.success(okMsg);
      setEditingId(null);
      router.refresh();
    });
  }

  function addOffering() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Give the offering a name');
      return;
    }
    run(() => createOfferingAction({ name: trimmed, category }), 'Offering added');
    setName('');
  }

  /**
   * Move one row within its category by rewriting the whole category's order.
   *
   * The list sent is the ACTIVE and retired rows together, in the order shown
   * — reordering across a retired row would otherwise silently reshuffle it,
   * and an admin who reactivates it later would find it somewhere unexpected.
   */
  function move(item: OfferingListItem, direction: -1 | 1) {
    const siblings = initial.filter((o) => o.category === item.category);
    const from = siblings.findIndex((o) => o.id === item.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const next = [...siblings];
    [next[from], next[to]] = [next[to]!, next[from]!];
    run(() =>
      reorderOfferingsAction({
        category: item.category,
        orderedIds: next.map((o) => o.id),
      }),
    );
  }

  return (
    <div>
      {/* -------- workspace switch -------- */}
      <div className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-[#262626] dark:bg-[#0F0F0F]">
        <div>
          <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
            Use offerings in this workspace
          </div>
          <div className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            {enabled
              ? 'On: new deals must be tagged, and the Offering column, filters, deal card and funnel report are shown.'
              : 'Off: hidden everywhere and never required. Existing tags and this catalog are kept, and come back when you turn it on.'}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Use offerings in this workspace"
          onClick={toggleEnabled}
          disabled={pending}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60',
            enabled ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-[#333]',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition',
              enabled ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>

      {/* Editable while OFF, on purpose: a workspace should be able to
          replace the seeded list with its own portfolio BEFORE the mandatory
          picker goes live for its reps, not after. Dimmed, not disabled. */}
      {!enabled ? (
        <p className="mb-3 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          You can set up the catalog below before turning offerings on —
          retire anything this workspace doesn&apos;t sell and add what it
          does.
        </p>
      ) : null}

      <div className={cn(!enabled && 'opacity-70')}>
      {/* -------- add -------- */}
      <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-[#2A2A2A] dark:bg-[#111111]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label
              htmlFor="offering-name"
              className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-[#A1A1AA]"
            >
              Name
            </label>
            <input
              id="offering-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addOffering();
                }
              }}
              placeholder="e.g. SafeOps360"
              className={inputCls}
            />
          </div>
          <div className="sm:w-44">
            <label
              htmlFor="offering-category"
              className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-[#A1A1AA]"
            >
              Category
            </label>
            <select
              id="offering-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as OfferingCategory)}
              className={inputCls}
            >
              {OFFERING_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {OFFERING_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={addOffering}
            disabled={pending}
            className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-[13px] font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden />
            )}
            Add
          </button>
        </div>
      </div>

      {/* -------- grouped list -------- */}
      {OFFERING_CATEGORIES.map((cat) => {
        const rows = initial.filter((o) => o.category === cat);
        return (
          <section key={cat} className="mb-6">
            <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              {OFFERING_CATEGORY_PLURAL[cat]}
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-normal text-slate-500 dark:bg-[#181818] dark:text-[#71717A]">
                {rows.length}
              </span>
            </h2>

            {rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-[12px] text-slate-500 dark:border-[#2A2A2A] dark:text-[#71717A]">
                No {OFFERING_CATEGORY_PLURAL[cat].toLowerCase()} yet.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 dark:divide-[#1F1F1F] dark:border-[#2A2A2A]">
                {rows.map((o, i) => (
                  <li
                    key={o.id}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2',
                      !o.active && 'bg-slate-50/70 dark:bg-[#111111]',
                    )}
                  >
                    {editingId === o.id ? (
                      <EditRow
                        item={o}
                        pending={pending}
                        onCancel={() => setEditingId(null)}
                        onSave={(next) =>
                          run(
                            () => updateOfferingAction({ id: o.id, ...next }),
                            'Offering updated',
                          )
                        }
                      />
                    ) : (
                      <>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            className={cn(
                              'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                              OFFERING_CATEGORY_CHIP[o.category],
                              !o.active && 'opacity-50',
                            )}
                          >
                            {OFFERING_CATEGORY_LABELS[o.category]}
                          </span>
                          <span
                            className={cn(
                              'truncate text-[13px] font-medium text-slate-800 dark:text-[#FAFAFA]',
                              !o.active &&
                                'text-slate-400 line-through dark:text-[#71717A]',
                            )}
                          >
                            {o.name}
                          </span>
                          {!o.active ? (
                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-600">
                              Retired
                            </span>
                          ) : null}
                        </div>

                        {/* Usage count, so a deactivation is never a guess about
                            what it will affect. Also the answer to "why is there
                            no delete button" — these rows are referenced. */}
                        <span
                          className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400 dark:text-[#71717A]"
                          title={`${o.dealCount} deal${o.dealCount === 1 ? '' : 's'} tagged with this offering`}
                        >
                          {o.dealCount === 0 ? '—' : `${o.dealCount} deals`}
                        </span>

                        <div className="flex shrink-0 items-center gap-0.5">
                          <IconButton
                            label="Move up"
                            disabled={pending || i === 0}
                            onClick={() => move(o, -1)}
                          >
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          </IconButton>
                          <IconButton
                            label="Move down"
                            disabled={pending || i === rows.length - 1}
                            onClick={() => move(o, 1)}
                          >
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                          </IconButton>
                          <IconButton
                            label={`Edit ${o.name}`}
                            disabled={pending}
                            onClick={() => setEditingId(o.id)}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </IconButton>
                          <IconButton
                            label={
                              o.active
                                ? `Deactivate ${o.name}`
                                : `Reactivate ${o.name}`
                            }
                            disabled={pending}
                            onClick={() =>
                              run(
                                () =>
                                  setOfferingActiveAction({
                                    id: o.id,
                                    active: !o.active,
                                  }),
                                o.active
                                  ? `${o.name} retired — it stays on the ${o.dealCount} deal${o.dealCount === 1 ? '' : 's'} already tagged with it`
                                  : `${o.name} is available again`,
                              )
                            }
                          >
                            {o.active ? (
                              <X className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Undo2 className="h-3.5 w-3.5" aria-hidden />
                            )}
                          </IconButton>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      </div>
    </div>
  );
}

function EditRow({
  item,
  pending,
  onCancel,
  onSave,
}: {
  item: OfferingListItem;
  pending: boolean;
  onCancel: () => void;
  onSave: (next: { name: string; category: OfferingCategory }) => void;
}) {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState<OfferingCategory>(item.category);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({ name: trimmed, category });
  }

  return (
    <div className="flex flex-1 items-center gap-2">
      <input
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') onCancel();
        }}
        aria-label="Offering name"
        className={cn(inputCls, 'py-1 text-[13px]')}
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as OfferingCategory)}
        aria-label="Offering category"
        className={cn(inputCls, 'w-36 py-1 text-[13px]')}
      >
        {OFFERING_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {OFFERING_CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <IconButton label="Save" disabled={pending} onClick={save}>
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      </IconButton>
      <IconButton label="Cancel" disabled={pending} onClick={onCancel}>
        <X className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]"
    >
      {children}
    </button>
  );
}
