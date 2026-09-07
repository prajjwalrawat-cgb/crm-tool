import { AlertTriangle } from 'lucide-react';

import { bandFor, ratioOf } from '@/lib/deals/completeness';
import type { TeamScorecard } from '@/lib/team-analytics/scorecard';
import { cn } from '@/lib/utils';

import {
  fieldFills,
  ragStyle,
  weakestFirst,
  type FieldFill,
} from './completeness-rag';
import {
  CompletenessTable,
  type CompletenessTableRow,
} from './completeness-table';
import { EmptyRow, Notes, Section } from './scorecard-primitives';

/** How many of the team's weakest fields the collapsed table shows. */
const COLLAPSED_FIELD_COUNT = 2;

/**
 * FIELD-LEVEL COMPLETENESS — a heatmap of what each rep's open deals are
 * missing, with the team's weakest column called out above it.
 *
 * The matrix is the point. A single "data quality: 74%" per rep says
 * nothing anyone can act on; a column of red under "Next step" says the
 * team never fills it in, and one red cell in an otherwise green row says
 * this rep does not. Those are different fixes.
 *
 * Every cell is filled ÷ APPLICABLE, never filled ÷ total. A field a deal
 * does not owe at its stage is in neither number — see
 * `@/lib/deals/completeness` for which stage owes what and why.
 *
 * This file computes; `./completeness-table` renders and holds the
 * collapsed/expanded state. The split keeps the ranking (which field is
 * weakest, which two the collapsed view shows) on the server, where it is
 * computed once from the same numbers the callout quotes.
 */
export function CompletenessSection({
  scorecard,
}: {
  scorecard: TeamScorecard;
}) {
  const { rows, team, fields } = scorecard;

  // No sort. Rows arrive in the order the scorecard assembled them and stay
  // that way; only reps with open deals to score are dropped, because a row
  // of "n/a" teaches nobody anything.
  const scored = rows.filter((r) => r.completeness.dealsScored > 0);
  if (scored.length === 0) {
    return (
      <Section title="Deal data completeness">
        <EmptyRow>No open deals to score.</EmptyRow>
      </Section>
    );
  }

  // Per-field team totals — summed from the tallies, not averaged from the
  // rep percentages. An average of averages would let a rep with two deals
  // weigh as heavily as one with forty.
  const teamByField: Record<string, { applicable: number; filled: number }> = {};
  for (const f of fields) {
    let applicable = 0;
    let filled = 0;
    for (const r of scored) {
      const t = r.completeness.byField[f.key];
      if (!t) continue;
      applicable += t.applicable;
      filled += t.filled;
    }
    teamByField[f.key] = { applicable, filled };
  }

  const teamFills = fieldFills(fields, teamByField);
  const ranked = weakestFirst(teamFills);
  const weakest = ranked[0] ?? null;
  const collapsedKeys = ranked.slice(0, COLLAPSED_FIELD_COUNT).map((f) => f.key);

  const teamRatio = ratioOf(
    team.completeness.filled,
    team.completeness.applicable,
  );
  const teamPct = Math.round(teamRatio * 100);
  const dealsScored = scored.reduce(
    (n, r) => n + r.completeness.dealsScored,
    0,
  );

  const tableRows: CompletenessTableRow[] = scored.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    role: r.role,
    dealsScored: r.completeness.dealsScored,
    overall: overallFill(
      r.completeness.total.filled,
      r.completeness.total.applicable,
    ),
    fills: fieldFills(fields, r.completeness.byField),
    overallDelta: r.deltas.completeness,
    ownerId: r.userId,
  }));

  const teamRow: CompletenessTableRow = {
    userId: '__team__',
    displayName: 'Team',
    role: null,
    dealsScored,
    overall: overallFill(
      team.completeness.filled,
      team.completeness.applicable,
    ),
    fills: teamFills,
    overallDelta: team.deltas.completeness,
    // Null, not '__team__': the drill-through opens the workspace's open
    // deals rather than filtering on an owner id no deal carries.
    ownerId: null,
  };

  return (
    <Section
      title="Deal data completeness"
      subtitle={
        <>
          Open deals only, scored against what each deal owes at its current
          stage — a Lead is not marked down for a missing margin, a Proposal
          is. Percentages are filled ÷ applicable.
        </>
      }
    >
      {/* The headline and the one thing to do about it, side by side. The
          flagged field is whichever column is lowest across the team right
          now — it is read from the numbers below, never named in code. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2.5 dark:border-[#1F1F1F] dark:bg-[#111111]">
        <div>
          <div className="text-[18px] font-semibold leading-none tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {teamPct}%{' '}
            <span className="text-[12px] font-medium text-slate-500 dark:text-[#A1A1AA]">
              overall
            </span>
          </div>
          <div className="mt-1 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            across {dealsScored} open {dealsScored === 1 ? 'deal' : 'deals'}
          </div>
        </div>
        {weakest ? <WeakestChip fill={weakest} /> : null}
      </div>

      <CompletenessTable
        fields={fields}
        rows={tableRows}
        team={teamRow}
        collapsedKeys={collapsedKeys}
      />

      <Notes
        notes={[
          'Won and lost deals are not scored. Their data is history a rep cannot usefully be asked to go back and fix, and including it would move the score with close volume rather than with the habit.',
          'Competitor and probability are deliberately not scored: “no competitor” is a real answer that looks identical to an empty column, and probability is stage-derived unless someone overrides it.',
        ]}
      />
    </Section>
  );
}

/**
 * The Overall column, shaped like any other cell so the table can render it
 * with the same component. It carries no field key, so it colours on the
 * DEFAULT ladder — a roll-up across eleven fields has no single field's
 * realistic ceiling to be judged against.
 */
function overallFill(filled: number, applicable: number): FieldFill {
  const pct = Math.round(ratioOf(filled, applicable) * 100);
  return {
    key: '__overall__',
    label: 'Overall',
    applicable,
    filled,
    pct,
    band: bandFor(pct),
  };
}

/**
 * The weakest column, flagged.
 *
 * Coloured through `ragStyle` rather than pinned to the danger role: the
 * chip is red exactly when the weakest field is genuinely poor, and a team
 * whose worst column is 94% gets a green chip instead of a false alarm that
 * would teach everyone to ignore the next real one.
 */
function WeakestChip({ fill }: { fill: FieldFill }) {
  const { bg, fg } = ragStyle(fill.pct, fill.key);
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium',
        bg,
        fg,
      )}
      title={`${fill.filled} of ${fill.applicable} open deals that owe this field have it`}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Weakest field: {fill.label} — {fill.pct}% team-wide
      </span>
    </div>
  );
}
