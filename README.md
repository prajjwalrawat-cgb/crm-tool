This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Prospect Board

The Prospect Board is a staging area for companies that are not leads yet. A prospect moves through five stages: `dump`, `researching`, `qualified`, `ready`, `parked`. A `ready` prospect is promoted to a lead.

| Page | Route |
| --- | --- |
| Board | `/dashboard/prospects` |
| Quick Dump (paste text, CSV or image) | `/dashboard/prospects/import` |
| Report (funnel, source quality) | `/dashboard/reports/prospect-board` |
| Settings | `/dashboard/settings/prospects` |

### Permissions

| Permission | Roles |
| --- | --- |
| `manageProspects`, `claimProspects`, `promoteProspects` | owner, admin, manager, member |
| `manageProspectClaims`, `bulkParkProspects`, `viewProspectReports` | owner, admin, manager |

Settings can be changed by owner and admin only.

### Promote rules

- A strong match blocks the promote: same company name, domain, email, phone, or an open lead for the company.
- A similar name only warns.
- The user must pick a match for each kind that has a strong match, or link to the open lead.
- "Create anyway" is for managers, owner and admin.
- The lead goes to the claimer if their claim is still active and they can still claim; otherwise your distribution rules decide; if routing fails it waits in the unassigned queue for retry. A claim-owned lead is kept out of the SLA watchdog.
- A promoted prospect is read-only. Its pending AI suggestions are superseded.

### Claims and settings

A claim lasts 14 days by default. Defaults in `src/lib/prospects/settings.ts`:

| Setting | Default |
| --- | --- |
| Claim length | 14 days (valid range 1–90) |
| Claim expiry | on |
| Auto-park after | 45 days (valid range 7–365) |
| Auto-park | on |
| AI enrichment | off |

### Background jobs

Both are Inngest functions, registered in `src/app/api/inngest/route.ts`.

| Id | Trigger | Does |
| --- | --- | --- |
| `prospects-daily-maintenance` | cron `30 20 * * *` UTC (02:00 IST) | auto-park stale prospects, expire claims |
| `prospect-enrich` | event `crm/prospect.created` | AI enrichment |

### AI

| Use | Env var | Default |
| --- | --- | --- |
| Quick Dump parsing | `PROSPECT_PARSE_MODEL` | `claude-opus-5-5` |
| Enrichment | `PROSPECT_ENRICH_MODEL` | `claude-haiku-5-5` |

- Both need `ANTHROPIC_API_KEY`. Without it, parsing and enrichment are skipped.
- Enrichment also needs the AI suggestions setting and the prospect enrichment setting on. Both are off by default.
- Haiku does not support server-side fallback, so the code leaves it out for Haiku models.
- Cost: about ₹0.03 per prospect on Haiku 5.5 (about 2,200 input and 290 output tokens per call, at $0.10 and $0.50 per MTok).

### Storage

Create a **private** Supabase bucket named `prospect-imports`, or set `SUPABASE_PROSPECT_IMPORTS_BUCKET`. Never make it public. Quick Dump images are stored there and read with signed URLs.

### Limits

| Input | Limit |
| --- | --- |
| Pasted text | 60,000 characters |
| CSV | 4 MB |
| Image | 5 MB (downscaled in the browser) |
| Rows per import | 500 |

### Hosting

`maxDuration = 300` is set on `/dashboard/prospects` (this also covers its server actions, such as bulk promote) and on `/api/prospects/import`. Your Vercel plan must allow 300 seconds.

### Migration

`drizzle/0079_prospect_board.sql` runs from `scripts/apply-0079.ts`, which is in the `pnpm build` chain. It is safe to replay. The widened CHECK constraints on `ai_suggestions` and `lead_sources` only rewrite when the constraint lacks this migration's value. Any later migration that widens them must keep that guard, or a deploy will re-narrow them.

### Seed data

```
pnpm seed:prospects -- --tenant <slug-or-id> [--reset]
```

It adds 30 prospects, 2 promoted leads and 3 fixed AI suggestions. It never calls Claude. It refuses to run unless `DATABASE_URL` contains `:15434` (the local test DB) or `SEED_ALLOW_REMOTE=1` is set.

### Tests

Run with the API key blanked, for example `ANTHROPIC_API_KEY= pnpm selftest:prospect-import`. Scripts: `selftest:prospects-db`, `selftest:prospect-import`, `selftest:prospect-enrich`, `selftest:prospect-report-db`. The pure test is `tsx scripts/selftest-prospects.ts`. The DB tests need a test database, never production.

### Known limits

- There is no prospect delete yet.
- The `pnpm selftest` chain stops at the existing `selftest-forecast` failure, so the prospect tests at the end of the chain do not run there. Run them one by one.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
