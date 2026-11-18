# Sales reports: what every number means

This is for sales managers and admins who use **Sales reports** (`/dashboard/insights`), and for engineers who change them.

Each metric is defined once, in `src/lib/reports/metrics.ts`. Its counting rules live in `src/lib/reports/manager/facts.ts`. Tiles, tables, exports, digests and the AI narrative all read from there.

## Who sees what

| You are | You see |
|---|---|
| Rep (member) | Your own numbers only |
| Manager | You and everyone below you in **Settings › Reporting lines**, all the way down. If nobody reports to you yet, you see the whole workspace until reporting lines are set. |
| Admin / owner | The whole workspace |

No one ever sees another workspace's data.

## Days and periods

- **A day** is a calendar day in the workspace timezone (**Settings › Organization**, default Asia/Kolkata). A lead at 23:50 IST counts on that day; one at 00:10 IST counts on the next.
- **Last 7 / 30 days** include today. **Month to date** starts on the 1st.
- **vs previous period** compares with the same number of days just before. For month to date, that means the same days of last month.
- **vs same period last year** compares with the same dates one year back.
- **Freshness:** past days come from a daily summary. It is refreshed every 15 minutes for today and yesterday, and rebuilt nightly for the last 7 days. Today is always counted live. Until the one-time history build finishes, everything is counted live: the numbers are the same, just slower to load.

## Activity and results

| Metric | Plain definition |
|---|---|
| Leads | Deals created in the period |
| Qualified / Proposals | Deals that moved into Qualified / Proposal in the period (once per deal per day) |
| Deals won / Won value | Deals closed Won in the period, and their value |
| Win rate | Won ÷ (won + lost) closed in the period; "—" if nothing closed |
| Average deal value | Won value ÷ deals won |
| Calls made | Outbound calls started |
| Contact rate | Answered outbound calls ÷ outbound calls |
| Talk time | Minutes on answered calls |
| Emails sent | CRM emails sent or delivered |
| Meetings | Meetings logged on deals |
| Activities / rep / day | All logged activity ÷ reps ÷ days |

Credit goes to whoever owns the work: the deal owner for deals, the assignee for assignments, the person who logged an activity or email, and the agent for calls. Unassigned deals count only in whole-workspace views.

## Funnel (follows a group of leads)

- The group is the leads **created** in the period.
- A lead counts at a stage if it reached that stage **or any later one**. A lead that skipped Qualified still counts at Qualified, so no bar is bigger than the one before it.
- A lead counts **once per stage**, even if it went back and forth. Moving backwards doesn't remove it from a stage it already reached. Hold and Lost are not funnel stages.
- **Step %** = this bar ÷ the previous bar. **% of group** = this bar ÷ the whole group.
- **Median days** = typical time from first reaching the previous stage to first reaching this one.
- Clicking a bar lists exactly those leads. **Qualified rate** = the Qualified bar ÷ the group.

## Pipeline and forecast (right now; no comparison)

- **Open pipeline**: value of all open deals. **Weighted** multiplies each deal by its stage probability (Settings › Pipeline).
- **Forecast this month**: weighted value of open deals expected to close this calendar month.
- **Sales cycle**: days from creation to Won, for deals won in the period (median, and the 75th percentile).
- **Stale leads**: open deals with no activity for more than X days (default 7).

## Response time and SLA

- **First response**: minutes from assignment to the owner's first call, email or note (median, and the 90th percentile).
- **SLA met**: of the assignments that are due, the share answered by the deadline. An assignment is due once its deadline has passed or once it has been answered. Leads still inside their deadline aren't counted yet.
- **Breach**: answered late, or not answered by the deadline. The heatmap shows breaches by weekday and hour of assignment, in workspace time.

## Lead sources

- Leads, won and won value are grouped by source. Qualified % is the funnel's qualified rate for that source.
- **Spend** is what you enter for each month the period touches; click a spend cell to set it.
- Cost per lead = spend ÷ leads. Cost per won = spend ÷ won. ROI = won value ÷ spend.
- Spend is recorded for the whole workspace, so spend and ROI appear only in whole-workspace views.

## Every number can be clicked

A KPI tile opens the rows behind it, counted by the same rules, so the count or total always matches the tile. Each list exports as CSV, up to 100,000 rows. Every export is logged.

## AI "What changed and why"

- **What's sent:** only aggregate numbers (this period vs the previous one, and the top movers by rep and by source). Reps are sent as "Rep 1", "Rep 2" and so on, and their names are put back only after the checks below pass. Lead names, phones, emails and notes are never sent.
- **Checks:** every number in the answer must appear in those aggregates, or the card shows "Narrative unavailable".
- **Wording:** causes are described as "likely", and segments with fewer than 20 leads are called too small to conclude from.
- **Caching:** results are kept for 30 minutes. **Regenerate** gets a fresh one.
- **Turning it off:** admins can switch it off in Settings › Reporting lines.
- **Model:** `claude-sonnet-5-5`, with a server-side fallback model if it declines.

## Email digests

- **Daily, 09:00 workspace time:** yesterday vs the day before, SLA breaches, stale leads, the top rep and the rep who needs a look, and up to 3 suggested actions.
- **Weekly, Mondays 09:00:** last week vs the week before, the funnel, and lead sources.
- **Saved reports** can be emailed daily or weekly at a chosen hour. Each recipient sees their own team's numbers.
- Each person gets each digest at most once per period. Mute them under **Settings › Report digests**.
- WhatsApp isn't sent yet because there is no WhatsApp provider. The 5-line version is ready for when there is.

## Performance

To be measured on a non-production database. Run these in order:

1. `ALLOW_LOAD_SEED=1 pnpm seed:report-load`
2. `ALLOW_LOAD_SEED=1 pnpm loadtest:reports --backfill`
3. `ALLOW_LOAD_SEED=1 pnpm loadtest:reports`

Then paste the resulting table here. Targets: p95 under 800 ms for rollup-backed endpoints, and under 300 ms for the leaderboard.

### Indexes added in 0074

EXPLAIN ANALYZE before/after is still to be measured on a non-production database.

| Index | Serves |
|---|---|
| `deals_tenant_created_live_idx` | deals created in a range |
| `deals_tenant_closed_live_idx` | won/lost in a range |
| `activity_logs_tenant_actor_created_idx` | activities per rep |
| `deal_stage_history_tenant_entered_idx` | stage moves in a range |
| `deal_stage_history_tenant_deal_entered_idx` | cohort lookup |
| `lead_assignments_tenant_assigned_idx` | SLA |
| `report_daily_rollup_tenant_owner_day_idx` + unique key | rollup reads |

The six heaviest queries to EXPLAIN are `dailyFactsSql`, `fetchCohort`, `slaStats`, the SLA heatmap, `teamPipeline` and `staleLeads`.
