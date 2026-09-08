# Deal risk — Phase 1 (shipped) and Phase 2 (gated)

The risk layer estimates how likely an open deal is to slip or die. Phase 1 is
live. Phase 2 is deliberately not built — the gate it has to clear is at the
bottom of this page.

---

## What the score means, in plain English

Every open deal gets a number from **0 to 100. Higher is worse.**

> ⚠️ The Deal Score already on the deal record is a **health** score where
> **high is good**. This one is the opposite. Both cards say which way they
> point, in the header, for exactly this reason.

The score is a **weighted checklist, not a prediction**. Nothing is learned
from past deals; a person decided each weight and you can read them below. A
deal scoring 70 is not "70% likely to be lost" — it means 70 of the 100 points
of things-that-can-go-wrong are going wrong on it.

### The five things it looks at

| What | Worth up to | Why it counts |
| --- | --- | --- |
| **How often the close date has moved** | 30 points | Chronic rescheduling is the strongest slip signal we have. Counted twice: how *many* times it moved, and how *far* — four one-day slips is a rep managing a date, one 90-day slip is a deal that left the quarter. |
| **How long since anyone touched it** | 25 points | The most actionable signal on the list, and the same one behind the Quiet / Silent labels on Team Performance. |
| **Missing fields for its stage** | 20 points | Only fields the deal actually owes *at its current stage*. A Lead is never marked down for a missing margin — it isn't supposed to have one yet. |
| **Time in stage vs. what's normal here** | 15 points | Compared against your workspace's own median for that stage, not a fixed number. 40 days in Negotiation is routine in one business and a stall in another. |
| **Deal age vs. your average won deal** | 10 points | The lightest weight, because a long deal isn't automatically a bad one. It's a tiebreaker, not an accusation. |

They add to exactly 100. The bands: **0–29 Low**, **30–59 Elevated**,
**60–100 High**.

### Two places it refuses to score

- **Time in stage abstains when your median is under 5 days.** Found on live
  data: one workspace's median time in Qualified came back as 2 days, because
  it was measured over bulk-imported deals that passed through in minutes.
  Against a 2-day benchmark every genuinely-worked deal is "more than twice
  the median" and collects all 15 points — a factor that fires on everything
  tells you nothing while inflating every score in the workspace.
- **Average cycle falls back to 90 days** until a workspace has 10 won deals.
  Two fast early wins would otherwise set the average at a fortnight and mark
  the whole pipeline overdue on day one.

### Which deals are scored

Open and being worked — everything except **won, lost and on hold**. Hold is
excluded on purpose: a parked deal is untouched by design, and flagging it
"nobody has touched this in 60 days" would accuse a rep of doing exactly what
the Hold feature asked. (Held deals past their revisit date have their own
filter.)

Every point is attributed. The deal card and the At Risk view list each factor
with the real figure behind it, so anyone who disagrees with a score can check
it rather than argue with a black box.

**Where the code is:** `src/lib/deals/risk/score.ts` — the weights are the
five numbers at the top of that file.

---

## The written explanation

The one-line "why" under each score is written by **Claude** (`claude-opus-5`)
from the deal's factors. The model writes prose; **it never touches the
score.** If the API is unreachable, or no `ANTHROPIC_API_KEY` is set, the card
shows the same facts assembled by the rubric instead, and the deal is still
scored, ranked and filterable. Nothing about the risk layer depends on an LLM
being up.

### It cannot invent a factor

The model is only shown **bands**, never exact figures: "no change in two to
four weeks", not "no change in 19 days". Two things follow:

1. A generated sentence stays true for as long as the deal is in that band, so
   it can't drift out of sync with the factor chips beside it (which are
   recomputed nightly and always exact).
2. **A specific number in the output is proof of invention.** Every generated
   sentence is checked against the payload it was given, and any digit that
   wasn't in the payload rejects the whole sentence — the deterministic one is
   used and the rejection is logged to `ai_invocations` as an error. The
   self-test re-runs that check over every stored explanation on every run.

### What stops it costing money

| Guard | Effect |
| --- | --- |
| **The cache key is the hash of the prompt itself** | Identical prompt, identical answer, no call. A stagnant deal is explained once per band change — a few times a quarter — not once a night. |
| **Bands, not raw numbers** | "19 days" changes nightly; "two to four weeks" does not. This is what makes the cache hit at all. |
| **Budget of 25 explanations per tenant per run** | The first run on a large workspace explains the riskiest deals and lets the rest arrive over following nights instead of firing hundreds of calls at once. |
| **Nothing on the render path** | Pages read a stored row. No page view has ever called the model, and none can. |
| **`effort: 'low'`** | A one-sentence rewrite needs no deliberation. |

Set `ANTHROPIC_RISK_MODEL` to override the model per deployment.

---

## How it runs

| Trigger | When | What |
| --- | --- | --- |
| `deal-risk-nightly` Inngest cron | 01:30 UTC daily | Score every open deal, prune closed ones, explain up to 25 changed deals per tenant |
| `pnpm risk:score` | manual | The same path; `-- --no-explain` skips the model entirely |

Scores are rewritten every night even when nothing changed, because "days
since last touch" moves on its own — a deal nobody edits still crosses a
threshold eventually. Per-tenant failures are isolated: one workspace with a
bad key cannot stop the others being scored.

### Where you see it

| Surface | What it shows |
| --- | --- |
| Deal record | Score, band, the sentence, and every factor with its points |
| **At Risk Deals** (`/dashboard/deals/at-risk`) | Open deals ranked by score, Elevated+ by default, High-only toggle |
| Deals list | A **Risk** column (score chip), sortable via its header menu, plus `?risk=high` / `?risk=elevated` filters |
| Pipeline board | A risk chip on cards scoring Elevated or above |

### Not to be confused with the Health filter

The deals filter bar has a band filter that reads `deals.health_band` — the
**health** score, where high is good. It is labelled **"Health"** (it used to
say "Score", which stopped being unambiguous the moment a second 0–100 number
existed). Its URL key is still `score=`, so existing links keep working.

Its lowest band is shown as **"Weak (<40)"**, not "At risk": a deal can be
`at_risk` on health and Low risk on the risk score simultaneously, and two
opposite meanings for one word on one screen is how a number stops being read.

| | Health | Risk |
| --- | --- | --- |
| Direction | higher is better | higher is worse |
| Bands | Strong ≥70 · Moderate 40–69 · Weak <40 | Low <30 · Elevated 30–59 · High 60+ |
| Reads | genuine activity, stakeholders, tasks, close date | pushbacks, silence, missing fields, time in stage, age |
| Filter | `?score=strong\|moderate\|at_risk` | `?risk=high\|elevated`, `?sort=risk` |
| Written by | `deal-scores-nightly` (01:00 UTC) | `deal-risk-nightly` (01:30 UTC) |

A sales user sees only their own deals in the At Risk view, matching the Deals
list's scoping.

### Sorting the Deals list by risk

`?sort=risk` orders the list highest-risk first. It is a real server-side sort
with its own keyset cursor over `(score, id)`, not a re-sort of the page you
can see — paging through it works.

Every surface reads `deal_risk_scores` through a **join**. There is no
denormalised column on `deals`.

**Sorting by risk shows only deals that have a score.** A NULL is "not scored
yet", not "safe", and padding the bottom of a risk-ranked list with unscored
rows would imply the opposite.

#### Why there is no cache column (0063 built one, 0064 removed it)

Migration 0060 added `chk_close_date_required` as **NOT VALID** — legacy deals
at Proposal or later with no close date were grandfathered rather than
blocking that migration. NOT VALID skips the back-scan; it does **not** stop
the constraint being checked on every later UPDATE. So writing any column on
one of those rows fails:

```
new row for relation "deals" violates check constraint "chk_close_date_required"
```

This aborted the first full scoring run. Guarding the write around those rows
kept the job green and produced the bug that actually mattered: **12 deals
showed a risk score on their own page and a dash in the Deals list**, because
the list read only the cache and the cache had no value for them.

So the cache is gone (0064) and every surface joins `deal_risk_scores`
instead. One source, one answer, and no row a constraint can silently
exclude. Reintroduce a cache only if list ordering ever becomes expensive
(tens of thousands of open deals per tenant) — and give the dateless deals
close dates first, because the constraint will still be waiting.

Anything else that adds a cache column to `deals` will hit the same wall.

---

## Phase 2 — trained model. NOT BUILT, and here is the gate.

Phase 2 is a real model (gradient-boosted trees in a separate Python service)
predicting win probability and a close date. It is not started, and it must
not ship to any UI until **all** of the following are true. This section
exists so it cannot ship merely because someone finished building it.

### Gate 1 — data volume

- **≥ 500 closed deals** (won or lost) in the tenant population, each with
  Phase 1 signals captured at the time they were open, not reconstructed
  afterwards.
- **≥ 150 losses.** A dataset that is 95% wins teaches a model to predict
  "win" and score 95% accuracy while being useless.
- **≥ 2 fiscal quarters** of history, so at least one full seasonal cycle is
  represented.

Phase 1 does not yet capture the training set. Collecting it is the first task
of Phase 2 and needs its own append-only table — `deal_risk_scores` is
upserted in place and keeps no history by design.

### Gate 2 — beating the naive baselines

Backtested on a held-out set the model never trained on, it must beat **both**:

- **The rep's own close date** — mean absolute error in days, on deals that
  closed. The model must be better by **≥ 20%**.
- **"Everything in this stage closes at the team's historical rate for that
  stage"** — the model's win/loss classification must beat this on **AUC-ROC
  by ≥ 0.10**, with precision and recall reported per class at the operating
  threshold.

Both numbers get written down here, with the date and the dataset size, before
anything reaches a screen. A model that cannot beat the rep's own guess is
worse than the rep's own guess, which is free.

### Gate 3 — deployment shape

- A separate FastAPI (or equivalent) service, called async via Inngest,
  writing scores back to Postgres. **Retraining or redeploying the model must
  never require an app deploy** — that is the whole reason it is a separate
  deployable.
- The app treats it exactly like it treats Claude today: if the service is
  unreachable, Phase 1 scoring continues and the UI loses the prediction, not
  the page.

### Retraining

Monthly, and only when **≥ 50 new closed deals** have accumulated since the
last training run — below that the update is noise, and each retrain risks
moving numbers a sales team has started to trust. Every retrain re-runs the
Gate 2 backtest, and a model that stops beating the baselines is rolled back
rather than shipped.

### Phase 1 stays

Phase 2 sits alongside the rules-based score; it does not replace it. The
rules-based number is explainable to a rep in one sentence, which a
gradient-boosted tree is not, and a workspace with too little history to train
on still needs a risk signal.

---

## Tests

`scripts/selftest-deal-risk.ts` (in `pnpm selftest`) — 25 checks, including:

- the five group maxima sum to exactly 100, and no group exceeds its own
- the score equals the sum of the factors the user is shown
- the time-in-stage factor abstains below a meaningful median
- the payload speaks in bands and never carries an exact day count
- two days inside one band produce the same prompt (so no second API call);
  crossing a band produces a different one
- a sentence inventing a specific day count is rejected
- every stored score is reproducible from its own stored signals (367 rows on
  live data at time of writing)
- no won, lost, held or deleted deal carries a risk row
