import { currentUser } from '@/lib/auth/server';
import {
  ArrowRight,
  Briefcase,
  Building2,
  Compass,
  Mail,
  Sparkles,
  Target,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';

import {
  readRevenueTrendView,
  readStageConversionView,
  readStageDonutView,
} from '@/lib/chart-studio/queries';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
} from '@/lib/currency/format';
import {
  getRecentWins,
  getRevenueTrend,
  getStaleDeals,
  getUpcomingFollowUps,
} from '@/lib/dashboard/queries';
import { resolveStageProbabilities } from '@/lib/deals/stage-probability';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { pipelineByStageRunner } from '@/lib/reports/queries/pipeline-by-stage';
import { getMyTasksSummary } from '@/lib/tasks/queries';

import { RevenueTrendChart } from '../revenue-trend-chart';
import { StageConversionBars } from '../stage-conversion-bars';
import { StageDonut } from '../stage-donut';
import {
  MyTasksCard,
  RecentWinsCard,
  StaleDealsCard,
  UpcomingFollowUpsCard,
} from '../intel-widgets';

import { Greeting } from './greeting';

/**
 * Sales Home — the rep's execution console. Owner-scoped to the
 * current user across every aggregate: funnel, donut, stale list,
 * follow-ups, wins. No team-wide leaderboards, no system telemetry.
 * The job is: "what should I do today?"
 *
 * Hero: revenue-weighted funnel of MY deals.
 * Below hero: split — donut (my deal-count distribution) + tasks.
 * Below that: follow-ups, stale, recent wins, quick actions.
 */
export async function SalesHome({
  tenantId,
  tenantName,
  userId,
}: {
  tenantId: string;
  tenantName: string;
  userId: string;
}) {
  const [
    user,
    settings,
    pipeline,
    trend,
    myTasks,
    followUps,
    stale,
    wins,
    savedChartView,
    savedStageConversionView,
    savedStageDonutView,
  ] = await Promise.all([
    currentUser(),
    getOrgSettings(tenantId),
    pipelineByStageRunner(
      tenantId,
      { range: 'last_90d', owner: { type: 'mine' } },
      { currentUserId: userId },
    ),
    getRevenueTrend(tenantId, { days: 90, ownerId: userId }),
    getMyTasksSummary(tenantId, userId),
    // Member persona — scope follow-ups / stale / wins to the
    // current user's owned deals so a rep never sees another rep's
    // pipeline. Admin/manager homes pass null (tenant-wide).
    getUpcomingFollowUps(tenantId, { lookAheadDays: 14, limit: 6, ownerId: userId }),
    getStaleDeals(tenantId, { staleDays: 14, limit: 5, ownerId: userId }),
    getRecentWins(tenantId, 5, { ownerId: userId }),
    readRevenueTrendView({ tenantId, userId }),
    readStageConversionView({ tenantId, userId }),
    readStageDonutView({ tenantId, userId }),
  ]);

  const money = (m: number) =>
    settings.compactNumbers
      ? formatCompactTenantCurrency(m, settings)
      : formatTenantCurrency(m, settings);

  // Onboarding state — no deals, no tasks, no follow-ups, no wins.
  // We surface a teaching banner above the dashboard when the rep has
  // nothing to act on yet, instead of a screen full of empty cards.
  const totalDealRevenue = pipeline.rows.reduce(
    (s, r) => s + r.totalAmountMinor,
    0,
  );
  const isOnboarding =
    totalDealRevenue === 0 &&
    myTasks.openCount === 0 &&
    followUps.length === 0 &&
    wins.length === 0;

  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
      <Greeting
        firstName={user?.firstName}
        tenantName={tenantName}
        personaLabel="Sales"
        className="mb-5"
      />

      {isOnboarding ? <OnboardingBanner firstName={user?.firstName} /> : null}

      {/* Hero: revenue trend chart, scoped to MY deals (90-day window).
          We pass the *currency context* (serializable scalars), not a
          formatter function — functions can't cross the RSC boundary. */}
      <RevenueTrendChart
        data={trend}
        currency={settings}
        title="My revenue trend"
        subtitle={`Last 90 days · ${tenantName}`}
        initialConfig={savedChartView?.config ?? null}
        initialTitleOverride={savedChartView?.title ?? null}
        persona="sales"
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <StageConversionBars
          rows={pipeline.rows}
          currency={settings}
          className="lg:col-span-2"
          title="My pipeline by stage"
          subtitle="Revenue-weighted bars · deals currently in stage"
          stageProbabilities={resolveStageProbabilities(
            settings.stageProbabilities,
          )}
          initialConfig={savedStageConversionView?.config ?? null}
          initialTitleOverride={savedStageConversionView?.title ?? null}
          persona="sales"
        />
        <MyTasksCard summary={myTasks} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <StageDonut
          rows={pipeline.rows}
          currency={settings}
          className="lg:col-span-1"
          title="My deal distribution"
          subtitle="How many deals sit in each stage"
          initialConfig={savedStageDonutView?.config ?? null}
          initialTitleOverride={savedStageDonutView?.title ?? null}
          persona="sales"
        />
        <UpcomingFollowUpsCard rows={followUps} />
        <StaleDealsCard rows={stale} staleDays={14} />
      </div>

      <div className="mt-4">
        <RecentWinsCard rows={wins} />
      </div>

      <SalesQuickLinks />
    </main>
  );
}

function SalesQuickLinks() {
  const links = [
    {
      href: '/dashboard/deals',
      label: 'My deals',
      icon: Briefcase,
      sub: 'Pipeline list view',
    },
    {
      href: '/dashboard/deals/board',
      label: 'Pipeline board',
      icon: Target,
      sub: 'Kanban by stage',
    },
    {
      href: '/dashboard/contacts',
      label: 'Contacts',
      icon: UsersRound,
      sub: 'People I work with',
    },
    {
      href: '/dashboard/companies',
      label: 'Companies',
      icon: Building2,
      sub: 'Accounts I own',
    },
  ];
  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <h2 className="mb-3 text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
        Jump back in
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="group flex items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 transition hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-[#1F1F1F] dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/10"
          >
            <l.icon
              className="h-4 w-4 flex-shrink-0 text-indigo-600 dark:text-indigo-300"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                {l.label}
              </div>
              <div className="text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
                {l.sub}
              </div>
            </div>
            <ArrowRight
              className="h-3 w-3 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500 dark:text-[#3F3F46]"
              aria-hidden
            />
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ============================================================ */
/* Onboarding banner — shown when the rep has no deals/tasks yet */
/* ============================================================ */

function OnboardingBanner({ firstName }: { firstName?: string | null }) {
  const steps = [
    {
      href: '/dashboard/companies',
      icon: Building2,
      label: 'Add a company',
      sub: 'Your account list lives here. Start with one you sell into.',
    },
    {
      href: '/dashboard/contacts',
      icon: UsersRound,
      label: 'Add a contact',
      sub: 'A real person at that company. Email/phone are optional.',
    },
    {
      href: '/dashboard/deals',
      icon: Briefcase,
      label: 'Create your first deal',
      sub: 'Stage + amount. Drag it across the pipeline as it moves.',
    },
    {
      href: '/dashboard/settings/email',
      icon: Mail,
      label: 'Connect your email',
      sub: 'Optional — log conversations under the right deal.',
    },
  ];
  const name = firstName?.trim();
  return (
    <section className="mb-5 overflow-hidden rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 p-5 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-indigo-500/30 dark:from-indigo-500/10 dark:via-[#0A0A0A] dark:to-violet-500/10">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-white/80 p-2 ring-1 ring-indigo-200 dark:bg-[#111111] dark:ring-indigo-500/30">
          <Sparkles className="h-5 w-5 text-indigo-600 dark:text-indigo-300" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {name ? `Welcome, ${name}.` : 'Welcome.'} Let&apos;s get you to your first win.
          </h2>
          <p className="mt-0.5 text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Your dashboard is quiet because there&apos;s no data yet. Four
            quick steps and the funnel will start filling itself.
          </p>
        </div>
      </div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, i) => (
          <li key={step.href}>
            <Link
              href={step.href}
              className="group flex h-full flex-col gap-1 rounded-lg border border-slate-200 bg-white/70 px-3 py-2.5 transition hover:border-indigo-400 hover:bg-white dark:border-[#1F1F1F] dark:bg-[#111111]/70 dark:hover:border-indigo-500/50 dark:hover:bg-[#111111]"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 font-mono text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                  {i + 1}
                </span>
                <step.icon
                  className="h-3.5 w-3.5 text-slate-500 dark:text-[#A1A1AA]"
                  aria-hidden
                />
                <span className="text-[12.5px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                  {step.label}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                {step.sub}
              </p>
              <span className="mt-auto inline-flex items-center gap-0.5 text-[10.5px] font-medium text-indigo-600 group-hover:text-indigo-500 dark:text-indigo-300">
                Go <Compass className="h-3 w-3" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
