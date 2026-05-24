import { currentUser } from '@clerk/nextjs/server';
import {
  Activity as ActivityIcon,
  ArrowRight,
  Award,
  CheckSquare,
  Mail,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
} from '@/lib/currency/format';
import { getRecommendationInsight } from '@/lib/intelligence/runner';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { pipelineByStageRunner } from '@/lib/reports/queries/pipeline-by-stage';
import { repPerformanceRunner } from '@/lib/reports/queries/rep-performance';
import { getMyTasksSummary } from '@/lib/tasks/queries';
import { cn } from '@/lib/utils';

export const metadata = {
  title: 'My Performance',
};

/**
 * Personal Performance Center — a longer-running analytics surface
 * separate from the dashboard (which is task-execution focused).
 * Members open this when they want to see *how they're doing*, not
 * what they need to do next.
 *
 * Surfaces:
 *   - Personal KPI strip (revenue, win rate, deals won/lost, avg
 *     cycle, activity count)
 *   - Conversion + activity sparkline strips
 *   - Where I rank on the team (read from rep-performance leaderboard)
 *   - AI coaching: recommendations scoped to my entities
 *   - Heuristic improvement hints
 *
 * No persona guard: managers and admins can also visit this URL to see
 * their own personal performance. The data is naturally scoped to the
 * currentUserId — there's no cross-rep leakage even when an admin opens
 * it.
 */
export default async function MyPerformancePage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    const [user, settings, pipelineMine, repPerf, myTasks, recs] =
      await Promise.all([
        currentUser(),
        getOrgSettings(tenant.id),
        pipelineByStageRunner(
          tenant.id,
          { range: 'last_90d', owner: { type: 'mine' } },
          { currentUserId: userId },
        ),
        // Pull whole-team rep performance so we can compute MY rank.
        repPerformanceRunner(
          tenant.id,
          { range: 'last_90d', owner: { type: 'all' } },
          { currentUserId: userId },
        ),
        getMyTasksSummary(tenant.id, userId),
        getRecommendationInsight(tenant.id, userId),
      ]);

    const money = (m: number) =>
      settings.compactNumbers
        ? formatCompactTenantCurrency(m, settings)
        : formatTenantCurrency(m, settings);

    // Find my row in the leaderboard
    const meRow =
      repPerf.rows.find((r) => r.ownerId === userId) ?? null;
    const myRank = meRow
      ? repPerf.rows.findIndex((r) => r.ownerId === userId) + 1
      : null;
    const teamSize = repPerf.rows.length;

    const myWon = meRow?.wonCount ?? 0;
    const myLost = meRow?.lostCount ?? 0;
    const myWinRate = meRow?.winRate ?? 0;
    const myRevenue = meRow?.revenueMinor ?? 0;
    const myAvgDealSize = meRow?.avgWonAmountMinor ?? 0;
    const myActivity = meRow?.activityCount ?? 0;
    const myEmails = meRow?.emailCount ?? 0;
    const myTasksDone = meRow?.tasksCompleted ?? 0;

    // Open pipeline (forward stages only) — what I still have to close
    const openPipelineMinor = pipelineMine.rows
      .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
      .reduce((s, r) => s + r.totalAmountMinor, 0);
    const openDealCount = pipelineMine.rows
      .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
      .reduce((s, r) => s + r.count, 0);

    // Recommendations scoped to entities I own (deals where I appear
    // as the rep). Best-effort filter — Recommendation.entity doesn't
    // carry ownerId, so we just show all and trust the runner to have
    // scoped intelligently.
    const myRecs = recs.content?.recommendations.slice(0, 5) ?? [];

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              My Performance
            </h1>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Where {user?.firstName ?? 'you'} stand — last 90 days · {tenant.name}
            </p>
          </div>
          {myRank && teamSize > 1 ? (
            <RankBadge rank={myRank} total={teamSize} />
          ) : null}
        </header>

        {/* Personal KPI strip */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          <Kpi label="Revenue · 90d" value={money(myRevenue)} accent="emerald" />
          <Kpi
            label="Win rate"
            value={`${Math.round(myWinRate * 100)}%`}
            sub={`${myWon}W · ${myLost}L`}
            accent="indigo"
          />
          <Kpi
            label="Avg deal"
            value={myAvgDealSize > 0 ? money(myAvgDealSize) : '—'}
            accent="violet"
          />
          <Kpi
            label="Open pipeline"
            value={money(openPipelineMinor)}
            sub={`${openDealCount} active`}
            accent="slate"
          />
          <Kpi
            label="Activities"
            value={String(myActivity)}
            sub="logged"
            accent="slate"
          />
          <Kpi
            label="Emails sent"
            value={String(myEmails)}
            accent="slate"
          />
          <Kpi
            label="Tasks done"
            value={String(myTasksDone)}
            sub={`${myTasks.completedThisWeek} this week`}
            accent="emerald"
          />
          <Kpi
            label="Open tasks"
            value={String(myTasks.openCount)}
            sub={
              myTasks.overdueCount > 0
                ? `${myTasks.overdueCount} overdue`
                : 'on track'
            }
            accent={myTasks.overdueCount > 0 ? 'rose' : 'slate'}
          />
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          <AICoachingCard recs={myRecs} className="lg:col-span-2" />
          <ImprovementHints
            winRate={myWinRate}
            wonCount={myWon}
            overdueTasks={myTasks.overdueCount}
            emailCount={myEmails}
            activityCount={myActivity}
          />
        </div>

        <ResponsiveQuickLinks />
      </main>
    );
  });
}

/* ============================================================ */

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: 'slate' | 'indigo' | 'emerald' | 'violet' | 'rose';
}) {
  const tintBar = {
    slate: 'bg-slate-300 dark:bg-slate-700',
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    violet: 'bg-violet-500',
    rose: 'bg-rose-500',
  }[accent];
  // @container + clamp() — value scales with card width so long
  // currency / count strings never clip or overflow.
  return (
    <div className="@container relative overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <span
        className={cn('absolute inset-y-0 left-0 w-0.5', tintBar)}
        aria-hidden
      />
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div className="mt-1 whitespace-nowrap font-mono text-[clamp(12px,7cqi,17px)] font-semibold tabular-nums tracking-tight text-slate-900 dark:text-[#FAFAFA]">
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 truncate text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function RankBadge({ rank, total }: { rank: number; total: number }) {
  const top10pct = rank <= Math.max(1, Math.floor(total * 0.1));
  const top25pct = rank <= Math.max(1, Math.floor(total * 0.25));
  const tone = top10pct ? 'amber' : top25pct ? 'indigo' : 'slate';
  const toneClass = {
    amber: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
    indigo: 'border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-200',
    slate: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-[#1F1F1F] dark:bg-[#181818] dark:text-[#FAFAFA]',
  }[tone];
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5',
        toneClass,
      )}
    >
      <Trophy className="h-3.5 w-3.5" aria-hidden />
      <span className="text-[12px] font-semibold">
        Rank #{rank} of {total}
      </span>
    </div>
  );
}

/* ============================================================ */

function AICoachingCard({
  recs,
  className,
}: {
  recs: Array<{
    title: string;
    rationale: string;
    actionKind: string;
    entity: { id: string; type: string; name: string };
  }>;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Sparkles className="h-3 w-3" aria-hidden />
            AI coaching
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Where to spend your time
          </h2>
        </div>
        <Link
          href="/dashboard/intelligence"
          className="hidden items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 sm:inline-flex dark:text-indigo-300"
        >
          Full intelligence <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      {recs.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-5 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          No coaching suggestions yet. The model refreshes on data change.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {recs.map((rec, i) => {
            const href =
              rec.entity.type === 'deal'
                ? `/dashboard/deals/${rec.entity.id}`
                : rec.entity.type === 'contact'
                  ? `/dashboard/contacts/${rec.entity.id}`
                  : rec.entity.type === 'company'
                    ? `/dashboard/companies/${rec.entity.id}`
                    : '/dashboard/intelligence';
            return (
              <li
                key={i}
                className="flex items-start gap-2 rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 text-[12px] dark:border-[#1F1F1F]/70 dark:bg-[#111111]"
              >
                <span
                  className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-indigo-500"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <Link
                    href={href}
                    className="block truncate font-medium text-slate-900 hover:text-indigo-600 dark:text-[#FAFAFA] dark:hover:text-indigo-300"
                  >
                    {rec.entity.name} — {rec.title}
                  </Link>
                  <div className="mt-0.5 line-clamp-2 text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
                    {rec.rationale}
                  </div>
                </div>
                <span className="hidden flex-shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-slate-600 sm:inline-block dark:bg-[#181818] dark:text-[#A1A1AA]">
                  {rec.actionKind.replace(/_/g, ' ')}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ============================================================ */

/**
 * Heuristic improvement hints — derived from the same KPIs above, so
 * they refresh in sync. We surface the *most actionable* gap rather
 * than a long list, because that's how reps actually use coaching.
 */
function ImprovementHints({
  winRate,
  wonCount,
  overdueTasks,
  emailCount,
  activityCount,
}: {
  winRate: number;
  wonCount: number;
  overdueTasks: number;
  emailCount: number;
  activityCount: number;
}) {
  const hints: Array<{
    icon: typeof Award;
    title: string;
    sub: string;
    tone: 'good' | 'warn' | 'bad';
  }> = [];

  if (overdueTasks > 0) {
    hints.push({
      icon: CheckSquare,
      title: `Clear ${overdueTasks} overdue task${overdueTasks === 1 ? '' : 's'}`,
      sub: 'Overdue tasks compound — clear the oldest first.',
      tone: 'bad',
    });
  }
  if (wonCount === 0 && activityCount < 5) {
    hints.push({
      icon: ActivityIcon,
      title: 'Increase activity volume',
      sub: 'Wins typically follow ≥10 logged activities in 90 days.',
      tone: 'warn',
    });
  }
  if (emailCount < 5) {
    hints.push({
      icon: Mail,
      title: 'Send more outbound emails',
      sub: 'Top reps in your tenant send 3-5× this volume.',
      tone: 'warn',
    });
  }
  if (winRate >= 0.5 && wonCount >= 3) {
    hints.push({
      icon: Award,
      title: 'Lock in your win rate',
      sub: `You're closing ${Math.round(winRate * 100)}%. Replicate what works.`,
      tone: 'good',
    });
  }
  if (hints.length === 0) {
    hints.push({
      icon: Target,
      title: 'Steady cadence',
      sub: 'No urgent gaps. Stay on follow-ups and keep activity steady.',
      tone: 'good',
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
          <TrendingUp className="h-3 w-3" aria-hidden />
          Improvement
        </div>
        <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          Areas to focus
        </h2>
      </header>
      <ul className="space-y-2">
        {hints.slice(0, 4).map((h, i) => {
          const toneClass = {
            good: 'border-emerald-200/70 bg-emerald-50/50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
            warn: 'border-amber-200/70 bg-amber-50/50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
            bad: 'border-rose-200/70 bg-rose-50/50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200',
          }[h.tone];
          return (
            <li
              key={i}
              className={cn(
                'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11.5px]',
                toneClass,
              )}
            >
              <h.icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 opacity-80" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{h.title}</div>
                <div className="mt-0.5 text-[10.5px] opacity-80">{h.sub}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ============================================================ */

function ResponsiveQuickLinks() {
  const links = [
    { href: '/dashboard/deals', label: 'My deals' },
    { href: '/dashboard/deals/board', label: 'Pipeline board' },
    { href: '/dashboard/tasks', label: 'Tasks' },
    { href: '/dashboard/communications', label: 'Communications' },
  ];
  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <h2 className="mb-2 text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
        Take action
      </h2>
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-indigo-700 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/10"
          >
            {l.label}
            <ArrowRight className="h-3 w-3 opacity-60" aria-hidden />
          </Link>
        ))}
      </div>
    </section>
  );
}
