import {
  completenessBand,
  ratioOf,
  type CompletenessBand,
} from '@/lib/deals/completeness';
import type { TeamScorecard } from '@/lib/team-analytics/scorecard';

import {
  EmptyRow,
  Notes,
  PctCell,
  RepCell,
  Section,
  TableFrame,
  Td,
  Th,
  type ChipTone,
} from './scorecard-primitives';

const BAND_TONES: Record<CompletenessBand, ChipTone> = {
  good: 'good',
  patchy: 'warn',
  poor: 'bad',
};

/**
 * FIELD-LEVEL COMPLETENESS — one column per data point a deal owes, one
 * row per rep, and a team row that says which field the whole workspace is
 * worst at.
 *
 * The matrix is the point. A single "data quality: 74%" per rep says
 * nothing anyone can act on; a column of red under "Next step" says the
 * team never fills it in, and one red cell in an otherwise green row says
 * this rep does not. Those are different fixes.
 *
 * Every cell is filled ÷ APPLICABLE, never filled ÷ total. A field a deal
 * does not owe at its stage is in neither number — see
 * `@/lib/deals/completeness` for which stage owes what and why.
 */
export function CompletenessSection({
  scorecard,
}: {
  scorecard: TeamScorecard;
}) {
  const { rows, team, fields } = scorecard;

  const scored = rows.filter((r) => r.completeness.dealsScored > 0);
  if (scored.length === 0) {
    return (
      <Section title="Deal data completeness">
        <EmptyRow>No open deals to score.</EmptyRow>
      </Section>
    );
  }

  // Per-field team totals, so the footer can show the workspace-wide fill
  // rate for each column rather than an average of averages.
  const fieldTotals = new Map<string, { applicable: number; filled: number }>();
  for (const field of fields) {
    let applicable = 0;
    let filled = 0;
    for (const r of scored) {
      const t = r.completeness.byField[field.key];
      if (!t) continue;
      applicable += t.applicable;
      filled += t.filled;
    }
    fieldTotals.set(field.key, { applicable, filled });
  }

  const worstField = [...fieldTotals.entries()]
    .filter(([, t]) => t.applicable > 0)
    .sort((a, b) => ratioOf(a[1].filled, a[1].applicable) - ratioOf(b[1].filled, b[1].applicable))[0];
  const worstLabel = worstField
    ? fields.find((f) => f.key === worstField[0])?.label
    : null;

  const teamRatio = ratioOf(team.completeness.filled, team.completeness.applicable);

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
      aside={
        <span className="text-[11px] text-slate-400 dark:text-[#71717A]">
          {Math.round(teamRatio * 100)}% across {team.openDeals} open deals
        </span>
      }
    >
      <TableFrame>
        <thead>
          <tr>
            <Th align="left" sticky>
              Rep
            </Th>
            <Th title="Open deals behind this row">Deals</Th>
            <Th title="Every applicable field on every open deal they own">
              Overall
            </Th>
            {fields.map((f) => (
              <Th key={f.key} title={f.hint}>
                {f.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scored.map((r) => {
            const overall = ratioOf(
              r.completeness.total.filled,
              r.completeness.total.applicable,
            );
            return (
              <tr key={r.userId}>
                <RepCell name={r.displayName} role={r.role} />
                <Td muted>{r.completeness.dealsScored}</Td>
                <PctCell
                  ratio={overall}
                  tone={BAND_TONES[completenessBand(overall)]}
                  title={`${r.completeness.total.filled} of ${r.completeness.total.applicable} applicable fields filled`}
                />
                {fields.map((f) => {
                  const t = r.completeness.byField[f.key];
                  if (!t || t.applicable === 0) {
                    return (
                      <Td
                        key={f.key}
                        muted
                        title="Not owed by any of this rep’s open deals at their current stage"
                      >
                        n/a
                      </Td>
                    );
                  }
                  const ratio = ratioOf(t.filled, t.applicable);
                  return (
                    <PctCell
                      key={f.key}
                      ratio={ratio}
                      tone={BAND_TONES[completenessBand(ratio)]}
                      title={`${t.filled} of ${t.applicable} deals have this`}
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <Td sticky align="left">
              Team
            </Td>
            <Td muted>
              {scored.reduce((n, r) => n + r.completeness.dealsScored, 0)}
            </Td>
            <PctCell
              ratio={teamRatio}
              tone={BAND_TONES[completenessBand(teamRatio)]}
              title={`${team.completeness.filled} of ${team.completeness.applicable} applicable fields filled`}
            />
            {fields.map((f) => {
              const t = fieldTotals.get(f.key);
              if (!t || t.applicable === 0) {
                return (
                  <Td key={f.key} muted>
                    n/a
                  </Td>
                );
              }
              const ratio = ratioOf(t.filled, t.applicable);
              return (
                <PctCell
                  key={f.key}
                  ratio={ratio}
                  tone={BAND_TONES[completenessBand(ratio)]}
                  title={`${t.filled} of ${t.applicable} deals workspace-wide`}
                />
              );
            })}
          </tr>
        </tfoot>
      </TableFrame>

      <Notes
        notes={[
          worstLabel
            ? `Weakest field across the team: ${worstLabel} — filled on ${Math.round(
                ratioOf(worstField![1].filled, worstField![1].applicable) * 100,
              )}% of the deals that owe it.`
            : null,
          'Won and lost deals are not scored. Their data is history a rep cannot usefully be asked to go back and fix, and including it would move the score with close volume rather than with the habit.',
          'Competitor and probability are deliberately not scored: “no competitor” is a real answer that looks identical to an empty column, and probability is stage-derived unless someone overrides it.',
        ]}
      />
    </Section>
  );
}
