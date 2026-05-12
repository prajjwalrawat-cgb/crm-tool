import {
  Briefcase,
  Building2,
  CheckCircle2,
  Plus,
  TrendingUp,
  UsersRound,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';

import type { DashboardOverview } from '@/lib/dashboard/queries';
import { formatCurrency } from '@/lib/deals/currency';
import { type DealStage, DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

/**
 * Six-tile KPI strip — companies, contacts, active pipeline count,
 * active pipeline value, won (30d), lost (30d). Tile content is dense
 * but breathable: small label, big numeric, subtle icon.
 */
export function KpiStrip({ overview }: { overview: DashboardOverview }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <KpiTile
        href="/dashboard/companies"
        label="Companies"
        value={fmtNumber(overview.companies)}
        icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
        accent="indigo"
      />
      <KpiTile
        href="/dashboard/contacts"
        label="Contacts"
        value={fmtNumber(overview.contacts)}
        icon={<UsersRound className="h-3.5 w-3.5" aria-hidden />}
        accent="indigo"
      />
      <KpiTile
        href="/dashboard/deals"
        label="Active deals"
        value={fmtNumber(overview.dealsActive)}
        icon={<Briefcase className="h-3.5 w-3.5" aria-hidden />}
        accent="indigo"
      />
      <KpiTile
        href="/dashboard/deals"
        label="Pipeline value"
        value={formatCurrency(overview.pipelineMinor, overview.pipelineCurrency)}
        icon={<TrendingUp className="h-3.5 w-3.5" aria-hidden />}
        mono
        accent="violet"
      />
      <KpiTile
        href="/dashboard/deals"
        label="Won (30d)"
        value={fmtNumber(overview.wonRecent)}
        icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
        accent="emerald"
      />
      <KpiTile
        href="/dashboard/deals"
        label="Lost (30d)"
        value={fmtNumber(overview.lostRecent)}
        icon={<XCircle className="h-3.5 w-3.5" aria-hidden />}
        accent="rose"
      />
    </div>
  );
}

function KpiTile({
  href,
  label,
  value,
  icon,
  mono,
  accent,
}: {
  href: string;
  label: string;
  value: string;
  icon: React.ReactNode;
  mono?: boolean;
  accent: 'indigo' | 'violet' | 'emerald' | 'rose';
}) {
  const accentClass: Record<typeof accent, string> = {
    indigo: 'text-indigo-600 bg-indigo-50',
    violet: 'text-violet-600 bg-violet-50',
    emerald: 'text-emerald-600 bg-emerald-50',
    rose: 'text-rose-600 bg-rose-50',
  };
  return (
    <Link
      href={href}
      className="group rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(15,23,42,0.04)] transition hover:border-slate-300"
    >
      <div className="flex items-center gap-1.5">
        <div
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded',
            accentClass[accent],
          )}
        >
          {icon}
        </div>
        <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-slate-500">
          {label}
        </div>
      </div>
      <div
        className={cn(
          'mt-1 text-[22px] font-semibold leading-none tabular-nums text-slate-900 transition-colors group-hover:text-indigo-700',
          mono && 'font-mono text-[15px]',
        )}
      >
        {value}
      </div>
    </Link>
  );
}

/**
 * Pipeline distribution — horizontal stacked bar showing deals per
 * stage with a calm palette and a per-stage legend strip below.
 * Reads only from the per-stage counts already computed by
 * getDashboardOverview, so this widget costs nothing extra.
 */
const STAGE_COLORS: Record<DealStage, { bar: string; dot: string }> = {
  lead: { bar: 'bg-slate-300', dot: 'bg-slate-400' },
  qualified: { bar: 'bg-blue-300', dot: 'bg-blue-500' },
  proposal: { bar: 'bg-indigo-400', dot: 'bg-indigo-500' },
  negotiation: { bar: 'bg-amber-300', dot: 'bg-amber-500' },
  won: { bar: 'bg-emerald-400', dot: 'bg-emerald-500' },
  lost: { bar: 'bg-rose-300', dot: 'bg-rose-500' },
};

export function PipelineDistribution({
  byStage,
}: {
  byStage: Record<DealStage, number>;
}) {
  const stages: DealStage[] = [
    'lead',
    'qualified',
    'proposal',
    'negotiation',
    'won',
    'lost',
  ];
  const total = stages.reduce((sum, s) => sum + byStage[s], 0);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold text-slate-900">Pipeline by stage</h2>
          <span className="text-[11px] tabular-nums text-slate-400">{total} total</span>
        </div>
        <Link
          href="/dashboard/deals/board"
          className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
        >
          Open board →
        </Link>
      </header>
      {total === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
          No deals yet. Create one to see the pipeline shape here.
        </p>
      ) : (
        <>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
            {stages.map((stage) => {
              const n = byStage[stage];
              if (n === 0) return null;
              const pct = (n / total) * 100;
              return (
                <div
                  key={stage}
                  className={STAGE_COLORS[stage].bar}
                  style={{ width: `${pct}%` }}
                  title={`${DEAL_STAGE_LABELS[stage]}: ${n} (${pct.toFixed(0)}%)`}
                />
              );
            })}
          </div>
          <ul className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-6">
            {stages.map((stage) => {
              const n = byStage[stage];
              const pct = total > 0 ? Math.round((n / total) * 100) : 0;
              return (
                <li
                  key={stage}
                  className="flex flex-col gap-0.5"
                >
                  <span className="flex items-center gap-1.5 text-slate-500">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        STAGE_COLORS[stage].dot,
                      )}
                    />
                    <span className="truncate capitalize">
                      {DEAL_STAGE_LABELS[stage]}
                    </span>
                  </span>
                  <span className="pl-3 font-semibold tabular-nums text-slate-900">
                    {n}
                    <span className="ml-1 text-[10px] font-normal text-slate-400">{pct}%</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Quick actions — three primary creation flows. Links navigate to the
 * entity page; the user clicks "+ New" there to open the create
 * drawer. This keeps the dashboard a *summary* surface, not a place
 * where data mutation happens directly.
 */
export function QuickActions({ canCreate }: { canCreate: boolean }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-slate-900">Quick actions</h2>
        {!canCreate ? (
          <span className="text-[10px] text-slate-400">read-only</span>
        ) : null}
      </header>
      {!canCreate ? (
        <p className="mb-2 text-[11px] text-slate-500">
          Your role can&apos;t create records. Ask an owner to invite an admin.
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <QuickActionLink
          href="/dashboard/companies"
          label="Add company"
          icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
          disabled={!canCreate}
        />
        <QuickActionLink
          href="/dashboard/contacts"
          label="Add contact"
          icon={<UsersRound className="h-3.5 w-3.5" aria-hidden />}
          disabled={!canCreate}
        />
        <QuickActionLink
          href="/dashboard/deals"
          label="Create deal"
          icon={<Briefcase className="h-3.5 w-3.5" aria-hidden />}
          disabled={!canCreate}
        />
      </div>
    </section>
  );
}

function QuickActionLink({
  href,
  label,
  icon,
  disabled,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
}) {
  if (disabled) {
    return (
      <span className="inline-flex cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-400">
        <span className="text-slate-300">{icon}</span>
        <span className="flex-1">{label}</span>
        <Plus className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-700 transition hover:bg-slate-50 hover:text-indigo-700"
    >
      <span className="text-slate-400 group-hover:text-indigo-500">{icon}</span>
      <span className="flex-1">{label}</span>
      <Plus className="h-3 w-3 text-slate-300 group-hover:text-indigo-500" aria-hidden />
    </Link>
  );
}

/* -------- helpers -------- */

function fmtNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

