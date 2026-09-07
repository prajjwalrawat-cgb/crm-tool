# Team Performance — trends, thresholds, drill-through

Reference for the three mechanisms behind `/dashboard/team-performance`. Each
has its reasoning next to the code; this is the one page that says where they
all live.

---

## 1. Historical snapshots (the "vs last month" deltas)

### Where it writes

`team_metric_snapshots` (migration `0061`). One row per
**(tenant, metric, rep, period)**; `rep_id IS NULL` is the team-wide row, the
same convention `forecast_snapshots` uses.

| column | meaning |
| --- | --- |
| `metric` | a key from `TEAM_METRICS` in `src/lib/team-analytics/snapshots.ts` |
| `rep_id` | `deals.owner_id`, or NULL for the team row |
| `period` | `YYYY-MM` — the month that closed |
| `value` | raw counter (minor units for money, plain count otherwise) |
| `computed_at` | when the capture ran |

**Only raw counters are stored — never a percentage.** Attainment is kept as
`fy_revenue_minor` *and* `revenue_target_minor`; completeness as
`completeness_filled` *and* `completeness_applicable`. A stored percentage
cannot be re-derived if a definition changes, and it lies when the denominator
moves: a rep whose target was raised in September would appear to have gone
backwards in October having closed more.

### How often

| trigger | when | what it captures |
| --- | --- | --- |
| `team-metrics-monthly` Inngest cron | `20 0 1 * *` (00:20 UTC on the 1st) | the month that just **ended** |
| `pnpm snapshot:team-metrics` | manual | last month, or `-- --period=YYYY-MM` |

Both run the same `snapshotTenant` function, which calls `getTeamScorecard` —
the very function the page renders from. Nothing re-derives a metric with its
own SQL, because a baseline computed by a second implementation is not a
baseline, it is a second opinion.

Re-running is safe. The unique index on
`(tenant_id, metric, COALESCE(rep_id,''), period)` makes the capture an upsert,
so a cron retry or a repeated manual run overwrites the period rather than
doubling it. (Verified: two consecutive captures of one period leave the same
171 rows.)

### First run, with no prior period

Every delta comes back as `{ kind: 'none' }` with a null baseline and the UI
renders the words **"no comparison yet"** — never `0%`, which is
indistinguishable from a month in which genuinely nothing moved. The tile strip
also carries one line under it stating that no snapshot exists and when the
first one lands. Nothing errors and no arrow is drawn.

### Two baselines, not one

`readBaselines` resolves two periods because the two kinds of metric cannot
share one:

- **cumulative** (`fy_revenue_minor`, `push_events`, `days_pushed`,
  `deals_created`) accrues from the start of the fiscal year and **resets at the
  year boundary**. These only ever compare against a baseline inside the same
  fiscal year — otherwise every January would show a fake collapse.
- **state** (`open_deals`, `stale_open_deals`, `completeness_*`) is true as of
  capture time and carries happily across a year boundary.

Each picks the most recent *available* period before the current one, so a
missed cron run degrades to "vs two months ago" — labelled with the month it
actually used — instead of disappearing.

### Arrow direction

In `DELTA_HIGHER_IS_BETTER` (`src/lib/team-analytics/deltas.ts`), never in a
renderer:

| metric | good direction |
| --- | --- |
| Attainment | up |
| Field completeness | up |
| Deals added | up |
| Close dates pushed | **down** |
| Untouched deals | **down** |

Rates (attainment, completeness) move in percentage **points**; counts go
through `computeDelta`, which has its own escape hatches for a near-zero
baseline. The arithmetic is `src/lib/dashboard/delta.ts`, shared with both
dashboards.

---

## 2. Completeness thresholds (red / amber / green)

**One place: the `thresholds` field on each entry of `DEAL_FIELD_SPECS` in
`src/lib/deals/completeness.ts`.** `DEFAULT_FIELD_THRESHOLDS` (40 / 75) covers
the Overall column and required custom fields. Everything colours through
`bandFor(pct, thresholdsFor(key))`; no renderer holds a number.

| field | amber from | green from |
| --- | --- | --- |
| Company | 60 | 90 |
| Contact | 60 | 90 |
| Contact email | 25 | 60 |
| Value | 50 | 85 |
| Margin | 50 | 85 |
| Revenue breakdown | 25 | 60 |
| Close date | 60 | 90 |
| Deal type | 30 | 70 |
| Source | 25 | 60 |
| Next step | 30 | 70 |
| Description | 25 | 60 |
| *default (Overall, custom fields)* | 40 | 75 |

### Why per field

Measured across every tenant, the fields sit anywhere from 0% filled (Contact
email, Source) to 92% (Contact). A single bar either paints the 0% fields
permanently red — carrying no information from one month to the next — or lets
a 92% field fall thirty points while staying green.

### Why not derived from the data

A percentile of the live distribution would repaint every rep's row whenever
another rep improved, and would define "good" as "whatever the team already
does". These numbers are a policy about what each field is worth, informed by
where the team stands but not dictated by it. Changing one is a one-line edit
next to that field's rationale.

### What recalibration did and did not achieve

Measured on live data (95 scored cells across 3 tenants):

```
global 40/80 : red 54 (57%)  amber  7 (7%)  green 34 (36%)
global 40/75 : red 54 (57%)  amber  7 (7%)  green 34 (36%)   ← identical
per-field    : red 53 (56%)  amber  8 (8%)  green 34 (36%)
```

Moving the global green cut from 80 to 75 changes nothing: no cell sits in
75–79. The counts barely move under per-field ladders either, and the reason is
the data, not the thresholds — **42 of 95 cells are ≤9% and 30 are exactly
100%**. A field is either filled out of habit or never touched.

What per-field ladders *did* change is which fields can express a middle:
amber now appears in **8 fields** (Company, Contact, Description, Revenue
breakdown, Value, Margin, Deal type, Source) instead of clustering in a few, and
a green on Source now means something different from a green on Contact. The
thresholds are the lever; the current numbers are a starting policy, not a
measurement.

Thresholds are deliberately **not** per-stage yet. See the note on
`CompletenessBand` for why that is the next step if wanted.

---

## 3. Drill-through

Every rep row and every heatmap cell links into the Deals list with the filter
that produced it.

### The prerequisite that had to ship first

The Deals view had no way to express "deals missing field X". Added as
`missing=<field_key>` — see `DealFilters.missingField` in
`src/lib/deals/filters.ts`, applied in both predicate builders in
`src/lib/deals/queries.ts`, and rendered as a "Missing: Next step" chip.

The predicate is generated from the completeness spec itself
(`fieldMissingSql`), so a cell and the list it opens cannot disagree about what
missing means. Crucially it is **owes it AND lacks it**, not merely blank: a
Lead is not missing a close date, it is forbidden from having one.

### Where each link goes

| clicked | URL |
| --- | --- |
| rep name (completeness / engagement) | `?owner=<id>&stage=<open stages>` |
| rep name (pushbacks) | `?owner=<id>&slipped=1` |
| completeness cell | `?owner=<id>&stage=<open>&missing=<field>` |
| Team row / Team open-deals | `?stage=<open stages>` |
| untouched deals | `?owner=<id>&stale=1` |
| deals pushed | `?owner=<id>&slipped=1` |

URLs are built by handing a `DealFilters` object to the Deals view's own
serializer (`dealsHref` in
`src/app/dashboard/team-performance/_components/drill-links.ts`), so a link
either round-trips through `parseDealFilters` or fails to compile. It cannot
silently produce a filter the list ignores and land the user on an unfiltered
page that looks like the right one.

A cell with nothing to drill into (a 100% column, a zero) renders as plain text
rather than advertising a click that lands on an empty list.

---

## Tests

`scripts/selftest-team-analytics.ts` (in `pnpm selftest`) — 155 checks, including:

- every heatmap cell drills through to exactly its own deals (the aggregate's
  `FILTER` count and the list's `WHERE` count agree, per rep per field, on live
  data)
- one percentage bands differently under two different ladders
- each ladder is exclusive at its own boundaries
- down is good for pushes and untouched deals, up is good for the rest
- attainment compares the ratio, so a raised target is not a collapse
- with no snapshot yet every delta is "none" with a null baseline
- every declared metric is actually written by the capture
- a drill-through URL round-trips through the Deals view parser

### The URL is the source of truth

A drill-through only works if nothing on the Deals page rewrites the URL from
its own state. Two things guarantee that:

- `page.tsx` derives `initialFilters` from `searchParams` on every render, and
  passes them straight through — no filter is ever held in React state. A hard
  reload, a `router.refresh()` after a server action, and a remount therefore
  all re-derive the same filters from the same URL.
- Every client-side URL write **merges** into the existing params and deletes
  only the keys it owns: `pushFilters` and the filter bar own the filter keys,
  `pagination-controls` owns `cursor`/`size`, and the search box owns `q` via
  `withSearchTerm`.

The search box was the exception until this pass. Its debounce effect built a
fresh query string containing only `q` and `size`, deleting every filter key in
the URL, and it guarded itself with a first-render ref — which React consumes on
the first of the two mount invocations it makes in development, so the second
scheduled a write. A deep link from Team Performance arrived correctly filtered
and was stripped 250ms later. It now merges, and writes only when the box and
the URL actually disagree, so a remount / refresh / double-invoke writes
nothing at all.
