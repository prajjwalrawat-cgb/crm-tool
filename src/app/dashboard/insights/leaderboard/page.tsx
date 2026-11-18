import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { leaderboard } from '@/lib/reports/manager/services';

import { LeaderboardBoard } from '../_components/leaderboard-board';
import { PageHeader } from '../_components/page-header';

export default async function LeaderboardPage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const initial = await leaderboard(ctx.scope, 'won_value', 'month');
    return (
      <>
        <PageHeader ctx={ctx} title="Leaderboard" description="Live ranking; refreshes every 30 seconds." showRange={false} />
        <LeaderboardBoard currency={ctx.currency} initial={{ rows: initial.rows, generatedAt: initial.generatedAt }} />
      </>
    );
  });
}
