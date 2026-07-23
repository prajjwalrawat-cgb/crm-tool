'use client';

import { ChevronDown, Filter, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import { formatNumber } from '@/lib/dates/format';
import {
  DEAL_FILTER_URL_KEYS,
  type DealFilters,
  dealFiltersToSearchParams,
  hasActiveDealFilters,
} from '@/lib/deals/filters';
import { type DealStage, DEAL_STAGES, DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

/**
 * URL-driven filter bar for the deals table.
 *
 * Single source of truth = URL search params. Each control reads from
 * the current params and writes back via router.replace, which:
 *   - Keeps the back/forward stack quiet (no history pollution).
 *   - Lets users share or bookmark a filtered view.
 *   - Plays cleanly with the existing `q=` search and `cursor=`
 *     pagination on the same page.
 *
 * Filter chips render once below the bar so the active state is
 * always visible — even when the popovers are closed.
 */
export function DealFilterBar({
  initialFilters,
  companyOptions,
  teammates,
  basePath = '/dashboard/deals',
}: {
  initialFilters: DealFilters;
  companyOptions: CompanyOption[];
  teammates?: Teammate[];
  /**
   * Route the URL-replace targets. Defaults to the deals list; the
   * board view passes `/dashboard/deals/board` so filter chips stay
   * scoped to whichever surface is rendering them.
   */
  basePath?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const pushFilters = useCallback(
    (next: DealFilters) => {
      const merged = new URLSearchParams(params.toString());
      // Drop every filter key we own so a toggled-off filter (e.g.
      // unchecking "My deals") actually clears its URL param — the
      // previous list missed `mine`, `unassigned`, and `owner`, so
      // those filters were sticky.
      for (const k of DEAL_FILTER_URL_KEYS) merged.delete(k);
      merged.delete('cursor'); // any filter change resets pagination
      const filterParams = dealFiltersToSearchParams(next);
      for (const [k, v] of filterParams.entries()) merged.set(k, v);
      const qs = merged.toString();
      router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [router, params, basePath],
  );

  const setStages = useCallback(
    (stages: DealStage[]) => pushFilters({ ...initialFilters, stages }),
    [initialFilters, pushFilters],
  );
  const setAmountRange = useCallback(
    (min: number | undefined, max: number | undefined) =>
      pushFilters({
        ...initialFilters,
        amountMinorMin: min,
        amountMinorMax: max,
      }),
    [initialFilters, pushFilters],
  );
  const setCloseWindow = useCallback(
    (from: string | undefined, to: string | undefined) =>
      pushFilters({
        ...initialFilters,
        expectedCloseFrom: from,
        expectedCloseTo: to,
      }),
    [initialFilters, pushFilters],
  );
  const setStale = useCallback(
    (next: boolean) => pushFilters({ ...initialFilters, stale: next }),
    [initialFilters, pushFilters],
  );
  const setCompanies = useCallback(
    (ids: string[]) =>
      pushFilters({
        ...initialFilters,
        companyIds: ids.length > 0 ? ids : undefined,
      }),
    [initialFilters, pushFilters],
  );
  const setOwners = useCallback(
    (ids: string[]) =>
      pushFilters({
        ...initialFilters,
        ownerIds: ids.length > 0 ? ids : undefined,
      }),
    [initialFilters, pushFilters],
  );
  const setMine = useCallback(
    (next: boolean) =>
      pushFilters({ ...initialFilters, mine: next, unassigned: false }),
    [initialFilters, pushFilters],
  );
  const setUnassigned = useCallback(
    (next: boolean) =>
      pushFilters({ ...initialFilters, unassigned: next, mine: false }),
    [initialFilters, pushFilters],
  );
  const setAwaitingApproval = useCallback(
    (next: boolean) =>
      pushFilters({
        ...initialFilters,
        awaitingApproval: next,
        approvedOnly: false,
      }),
    [initialFilters, pushFilters],
  );
  const setApprovedOnly = useCallback(
    (next: boolean) =>
      pushFilters({
        ...initialFilters,
        approvedOnly: next,
        awaitingApproval: false,
      }),
    [initialFilters, pushFilters],
  );
  const setScore = useCallback(
    (next: DealFilters['score']) =>
      pushFilters({ ...initialFilters, score: next }),
    [initialFilters, pushFilters],
  );
  const setRevisitDue = useCallback(
    (next: boolean) => pushFilters({ ...initialFilters, revisitDue: next }),
    [initialFilters, pushFilters],
  );

  const clearAll = useCallback(
    () => pushFilters({}),
    [pushFilters],
  );

  const active = hasActiveDealFilters(initialFilters);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 inline-flex items-center gap-1 text-[11px] text-slate-500">
          <Filter className="h-3 w-3" aria-hidden />
          Filter
        </span>
        <StagePopover
          selected={initialFilters.stages ?? []}
          onChange={setStages}
        />
        <AmountPopover
          min={initialFilters.amountMinorMin}
          max={initialFilters.amountMinorMax}
          onChange={setAmountRange}
        />
        <DatePopover
          from={initialFilters.expectedCloseFrom}
          to={initialFilters.expectedCloseTo}
          onChange={setCloseWindow}
        />
        <ToggleChip
          label="My deals"
          active={!!initialFilters.mine}
          onClick={() => setMine(!initialFilters.mine)}
        />
        <ToggleChip
          label="Unassigned"
          active={!!initialFilters.unassigned}
          onClick={() => setUnassigned(!initialFilters.unassigned)}
        />
        <ToggleChip
          label="Stale only"
          active={!!initialFilters.stale}
          onClick={() => setStale(!initialFilters.stale)}
        />
        <ToggleChip
          label="Awaiting approval"
          active={!!initialFilters.awaitingApproval}
          onClick={() => setAwaitingApproval(!initialFilters.awaitingApproval)}
        />
        <ToggleChip
          label="Approved"
          active={!!initialFilters.approvedOnly}
          onClick={() => setApprovedOnly(!initialFilters.approvedOnly)}
        />
        <ScorePopover selected={initialFilters.score} onChange={setScore} />
        <ToggleChip
          label="Revisit due"
          active={!!initialFilters.revisitDue}
          onClick={() => setRevisitDue(!initialFilters.revisitDue)}
        />
        <CompanyPopover
          selectedIds={initialFilters.companyIds ?? []}
          options={companyOptions}
          onChange={setCompanies}
        />
        {teammates && teammates.length > 0 ? (
          <OwnerPopover
            selectedIds={initialFilters.ownerIds ?? []}
            teammates={teammates}
            onChange={setOwners}
          />
        ) : null}
        {active ? (
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-3 w-3" aria-hidden />
            Clear all
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ----- shared chip + popover primitives ----- */

function Chip({
  children,
  active,
  onClick,
  onClear,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick?: () => void;
  onClear?: () => void;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition',
        active
          ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1"
      >
        {children}
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform',
            active ? 'text-indigo-600' : 'text-slate-400',
          )}
          aria-hidden
        />
      </button>
      {active && onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear filter"
          className="-mr-0.5 rounded p-0.5 text-indigo-600 hover:bg-indigo-100"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

function ToggleChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition',
        active
          ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {label}
    </button>
  );
}

function Popover({
  open,
  onClose,
  children,
  anchorRef,
  align = 'left',
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  align?: 'left' | 'right';
}) {
  if (!open) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Close popover"
        onClick={onClose}
        className="fixed inset-0 z-30 cursor-default"
      />
      <div
        ref={anchorRef}
        className={cn(
          'absolute top-[calc(100%+4px)] z-40 min-w-[14rem] rounded-md border border-slate-200 bg-white p-2 shadow-md',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        {children}
      </div>
    </>
  );
}

/* ----- specific popovers ----- */

function StagePopover({
  selected,
  onChange,
}: {
  selected: DealStage[];
  onChange: (next: DealStage[]) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const toggle = (stage: DealStage) => {
    const set = new Set(selected);
    if (set.has(stage)) set.delete(stage);
    else set.add(stage);
    onChange(Array.from(set));
  };
  const active = selected.length > 0;
  const label = active
    ? `Stage: ${selected.map((s) => DEAL_STAGE_LABELS[s]).join(', ')}`
    : 'Stage';

  return (
    <div className="relative">
      <Chip
        active={active}
        onClick={() => setOpen((v) => !v)}
        onClear={() => onChange([])}
      >
        {label}
      </Chip>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        <ul className="flex flex-col">
          {DEAL_STAGES.map((stage) => {
            const checked = selected.includes(stage);
            return (
              <li key={stage}>
                <button
                  type="button"
                  onClick={() => toggle(stage)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-slate-50"
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded border',
                      checked
                        ? 'border-indigo-500 bg-indigo-500 text-white'
                        : 'border-slate-300 bg-white',
                    )}
                    aria-hidden
                  >
                    {checked ? <span className="text-[8px]">✓</span> : null}
                  </span>
                  <span className="capitalize">{DEAL_STAGE_LABELS[stage]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Popover>
    </div>
  );
}

const SCORE_OPTIONS: Array<{
  value: NonNullable<DealFilters['score']>;
  label: string;
  dot: string;
}> = [
  { value: 'strong', label: 'Strong (≥70)', dot: 'bg-emerald-500' },
  { value: 'moderate', label: 'Moderate (40–69)', dot: 'bg-amber-400' },
  { value: 'at_risk', label: 'At risk (<40)', dot: 'bg-rose-500' },
];

function ScorePopover({
  selected,
  onChange,
}: {
  selected: DealFilters['score'] | undefined;
  onChange: (next: DealFilters['score']) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = !!selected;
  const current = SCORE_OPTIONS.find((o) => o.value === selected);
  const label = active ? `Score: ${current?.label.split(' ')[0]}` : 'Score';

  return (
    <div className="relative">
      <Chip
        active={active}
        onClick={() => setOpen((v) => !v)}
        onClear={() => onChange(undefined)}
      >
        {label}
      </Chip>
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)}>
        <ul className="flex flex-col">
          {SCORE_OPTIONS.map((o) => {
            const checked = selected === o.value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(checked ? undefined : o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition',
                    checked
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span className={cn('h-2.5 w-2.5 rounded-full', o.dot)} aria-hidden />
                  <span>{o.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Popover>
    </div>
  );
}

function AmountPopover({
  min,
  max,
  onChange,
}: {
  min: number | undefined;
  max: number | undefined;
  onChange: (min: number | undefined, max: number | undefined) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [minStr, setMinStr] = useState(min ? String(min / 100) : '');
  const [maxStr, setMaxStr] = useState(max ? String(max / 100) : '');
  // Re-sync local inputs whenever the URL params change externally
  // (e.g. user clicks "Clear all"). The deps comparison guarantees we
  // don't blow away in-progress typing.
  useEffect(() => {
    setMinStr(min ? String(min / 100) : '');
    setMaxStr(max ? String(max / 100) : '');
  }, [min, max]);

  const active = min !== undefined || max !== undefined;
  const label = active
    ? `Amount: ${min ? '≥' + formatNumber(min / 100) : ''}${
        min && max ? ' · ' : ''
      }${max ? '≤' + formatNumber(max / 100) : ''}`
    : 'Amount';

  const apply = () => {
    const parsedMin = minStr ? Math.round(Number(minStr) * 100) : undefined;
    const parsedMax = maxStr ? Math.round(Number(maxStr) * 100) : undefined;
    onChange(
      Number.isFinite(parsedMin as number) ? parsedMin : undefined,
      Number.isFinite(parsedMax as number) ? parsedMax : undefined,
    );
    setOpen(false);
  };

  return (
    <div className="relative">
      <Chip
        active={active}
        onClick={() => setOpen((v) => !v)}
        onClear={() => onChange(undefined, undefined)}
      >
        {label}
      </Chip>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        <div className="flex flex-col gap-2 p-1">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-slate-500">
              Min
              <input
                type="number"
                inputMode="decimal"
                value={minStr}
                onChange={(e) => setMinStr(e.target.value)}
                placeholder="0"
                className="rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-slate-500">
              Max
              <input
                type="number"
                inputMode="decimal"
                value={maxStr}
                onChange={(e) => setMaxStr(e.target.value)}
                placeholder="∞"
                className="rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
              />
            </label>
          </div>
          <p className="text-[10px] text-slate-400">
            Values are in major currency units (e.g. 5000 = ₹5,000 or $5,000
            depending on the deal&apos;s own currency).
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setMinStr('');
                setMaxStr('');
                onChange(undefined, undefined);
                setOpen(false);
              }}
              className="rounded px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              Apply
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

function DatePopover({
  from,
  to,
  onChange,
}: {
  from: string | undefined;
  to: string | undefined;
  onChange: (from: string | undefined, to: string | undefined) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [fromStr, setFromStr] = useState(from ?? '');
  const [toStr, setToStr] = useState(to ?? '');
  useEffect(() => {
    setFromStr(from ?? '');
    setToStr(to ?? '');
  }, [from, to]);

  const active = !!from || !!to;
  const label = active
    ? `Close: ${from ?? '…'} → ${to ?? '…'}`
    : 'Close date';

  const apply = () => {
    onChange(fromStr || undefined, toStr || undefined);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Chip
        active={active}
        onClick={() => setOpen((v) => !v)}
        onClear={() => onChange(undefined, undefined)}
      >
        {label}
      </Chip>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        <div className="flex flex-col gap-2 p-1">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-slate-500">
              From
              <input
                type="date"
                value={fromStr}
                onChange={(e) => setFromStr(e.target.value)}
                className="rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-slate-500">
              To
              <input
                type="date"
                value={toStr}
                onChange={(e) => setToStr(e.target.value)}
                className="rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setFromStr('');
                setToStr('');
                onChange(undefined, undefined);
                setOpen(false);
              }}
              className="rounded px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              Apply
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

function CompanyPopover({
  selectedIds,
  options,
  onChange,
}: {
  selectedIds: string[];
  options: CompanyOption[];
  onChange: (next: string[]) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const active = selectedIds.length > 0;

  // Selected rows first, then matches; cap the visible list so a huge
  // tenant doesn't melt the popover. Search narrows further.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? options.filter((o) => o.name.toLowerCase().includes(q))
      : options;
    return matches.slice(0, 50);
  }, [options, query]);

  const toggle = (id: string) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const label = active
    ? `Company: ${
        selectedIds.length === 1
          ? options.find((o) => o.id === selectedIds[0])?.name ?? '…'
          : `${selectedIds.length} selected`
      }`
    : 'Company';

  return (
    <div className="relative">
      <Chip
        active={active}
        onClick={() => setOpen((v) => !v)}
        onClear={() => onChange([])}
      >
        {label}
      </Chip>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        <div className="flex flex-col gap-1 p-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search companies…"
            className="rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
            autoFocus
          />
          <ul className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-[11px] text-slate-400">
                No matches
              </li>
            ) : (
              filtered.map((c) => {
                const checked = selectedSet.has(c.id);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => toggle(c.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition',
                        checked
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border',
                          checked
                            ? 'border-indigo-500 bg-indigo-500 text-white'
                            : 'border-slate-300 bg-white',
                        )}
                        aria-hidden
                      >
                        {checked ? <span className="text-[8px]">✓</span> : null}
                      </span>
                      <span className="truncate">{c.name}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {active ? (
            <div className="flex justify-end border-t border-slate-100 pt-1">
              <button
                type="button"
                onClick={() => onChange([])}
                className="rounded px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
              >
                Clear
              </button>
            </div>
          ) : null}
        </div>
      </Popover>
    </div>
  );
}

function OwnerPopover({
  selectedIds,
  teammates,
  onChange,
}: {
  selectedIds: string[];
  teammates: Teammate[];
  onChange: (next: string[]) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const active = selectedIds.length > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? teammates.filter(
          (t) =>
            t.displayName.toLowerCase().includes(q) ||
            (t.email?.toLowerCase().includes(q) ?? false),
        )
      : teammates;
    return matches.slice(0, 50);
  }, [teammates, query]);

  const toggle = (id: string) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const label = active
    ? `Owner: ${
        selectedIds.length === 1
          ? teammates.find((t) => t.id === selectedIds[0])?.displayName ?? '…'
          : `${selectedIds.length} selected`
      }`
    : 'Owner';

  return (
    <div className="relative">
      <Chip
        active={active}
        onClick={() => setOpen((v) => !v)}
        onClear={() => onChange([])}
      >
        {label}
      </Chip>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        <div className="flex flex-col gap-1 p-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teammates…"
            className="rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
            autoFocus
          />
          <ul className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-[11px] text-slate-400">
                No matches
              </li>
            ) : (
              filtered.map((t) => {
                const checked = selectedSet.has(t.id);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => toggle(t.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition',
                        checked
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border',
                          checked
                            ? 'border-indigo-500 bg-indigo-500 text-white'
                            : 'border-slate-300 bg-white',
                        )}
                        aria-hidden
                      >
                        {checked ? <span className="text-[8px]">✓</span> : null}
                      </span>
                      <span className="truncate">{t.displayName}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {active ? (
            <div className="flex justify-end border-t border-slate-100 pt-1">
              <button
                type="button"
                onClick={() => onChange([])}
                className="rounded px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
              >
                Clear
              </button>
            </div>
          ) : null}
        </div>
      </Popover>
    </div>
  );
}
