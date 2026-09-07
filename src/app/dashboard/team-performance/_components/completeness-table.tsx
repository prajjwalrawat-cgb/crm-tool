'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { fieldGroupLabel } from '@/lib/deals/completeness';
import type { ScorecardField } from '@/lib/team-analytics/scorecard';
import { cn } from '@/lib/utils';

import { groupRuns, ragStyle, type FieldFill } from './completeness-rag';
import { RepCell, Td, Th } from './scorecard-primitives';

/**
 * The completeness heatmap.
 *
 * A client component for one reason: the collapsed/expanded toggle. The
 * numbers are computed on the server and arrive finished — nothing here
 * scores, ranks or re-sorts anything.
 *
 * COLLAPSED IS THE DEFAULT, and what it shows is chosen team-wide rather
 * than per rep: every row gets the same two columns (the team's weakest
 * fields) so the view stays comparable down the column. Picking each rep's
 * own worst two would produce a table where no two cells mean the same
 * thing.
 *
 * ROW ORDER IS THE SERVER'S. This component never sorts — the rows arrive
 * in the order the scorecard assembled them, and the Team row is pinned
 * last in a `tfoot` because it is an aggregate, not a competitor.
 */

export type CompletenessTableRow = {
  userId: string;
  displayName: string;
  role: string | null;
  dealsScored: number;
  /** Overall fill across every applicable field for this rep. */
  overall: FieldFill;
  /** Per-field fills, in the same order as `fields`. */
  fills: FieldFill[];
};

export function CompletenessTable({
  fields,
  rows,
  team,
  collapsedKeys,
}: {
  fields: ScorecardField[];
  rows: CompletenessTableRow[];
  team: CompletenessTableRow;
  /** Field keys shown while collapsed — the team's weakest, server-picked. */
  collapsedKeys: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  const visibleKeys = expanded ? null : new Set(collapsedKeys);
  const visibleFields = expanded
    ? fields
    : fields.filter((f) => visibleKeys!.has(f.key));
  const hiddenCount = fields.length - visibleFields.length;

  // Group runs for the two-tier header — the span each group header claims
  // is derived from the very columns rendered beneath it, so the two cannot
  // disagree.
  const groups = groupRuns(visibleFields);

  const indexByKey = new Map(fields.map((f, i) => [f.key, i]));
  const fillFor = (row: CompletenessTableRow, key: string): FieldFill =>
    row.fills[indexByKey.get(key) ?? -1] ?? {
      key,
      label: key,
      applicable: 0,
      filled: 0,
      pct: 0,
    };

  const renderRow = (row: CompletenessTableRow, isTeam: boolean) => {
    const edge = isTeam
      ? 'border-t-2 border-t-slate-300 dark:border-t-[#3F3F46]'
      : undefined;
    return (
      <tr key={row.userId} className={cn(isTeam && 'font-medium')}>
        {isTeam ? (
          <Td sticky align="left" className={edge}>
            Team
          </Td>
        ) : (
          <RepCell name={row.displayName} role={row.role} />
        )}
        <Td muted className={edge}>
          {row.dealsScored}
        </Td>
        <HeatCell fill={row.overall} className={edge} emphasis />
        {visibleFields.map((f, i) => (
          <HeatCell
            key={f.key}
            fill={fillFor(row, f.key)}
            className={cn(edge, startsGroup(visibleFields, i) && GROUP_EDGE)}
          />
        ))}
      </tr>
    );
  };

  return (
    <>
      <div className="mb-2 flex items-center justify-end">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:bg-[#151515] dark:hover:text-[#FAFAFA]"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
          {expanded
            ? 'Show fewer fields'
            : `Show all fields${hiddenCount > 0 ? ` (+${hiddenCount})` : ''}`}
        </button>
      </div>

      {/* Only the expanded grid scrolls. Collapsed is four columns and has
          to fit a dashboard column without a scrollbar under it. */}
      <div className={cn(expanded && '-mx-1 overflow-x-auto px-1')}>
        <table
          className={cn(
            'w-full border-collapse text-[12px]',
            expanded && 'min-w-[860px]',
          )}
        >
          <thead>
            {expanded ? (
              <>
                <tr>
                  <Th align="left" sticky rowSpan={2}>
                    Rep
                  </Th>
                  <Th rowSpan={2} title="Open deals behind this row">
                    Deals
                  </Th>
                  <Th
                    rowSpan={2}
                    title="Every applicable field on every open deal they own"
                  >
                    Overall
                  </Th>
                  {groups.map((g) => (
                    <Th
                      key={g.key}
                      align="center"
                      colSpan={g.fields.length}
                      className={cn(GROUP_EDGE, 'text-slate-500 dark:text-[#A1A1AA]')}
                    >
                      {fieldGroupLabel(g.key)}
                    </Th>
                  ))}
                </tr>
                <tr>
                  {groups.map((g) =>
                    g.fields.map((f, i) => (
                      <Th
                        key={f.key}
                        align="center"
                        title={f.hint}
                        className={cn(i === 0 && GROUP_EDGE)}
                      >
                        {f.label}
                      </Th>
                    )),
                  )}
                </tr>
              </>
            ) : (
              <tr>
                <Th align="left" sticky>
                  Rep
                </Th>
                <Th title="Open deals behind this row">Deals</Th>
                <Th title="Every applicable field on every open deal they own">
                  Overall
                </Th>
                {visibleFields.map((f) => (
                  <Th
                    key={f.key}
                    align="center"
                    title={`${f.hint} — shown because it is one of the team’s weakest fields`}
                  >
                    {f.label}
                  </Th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>{rows.map((r) => renderRow(r, false))}</tbody>
          <tfoot>{renderRow(team, true)}</tfoot>
        </table>
      </div>
    </>
  );
}

/** Left rule marking where one header group ends and the next begins. */
const GROUP_EDGE = 'border-l border-slate-200 dark:border-[#1F1F1F]';

function startsGroup(fields: ScorecardField[], index: number): boolean {
  if (index === 0) return true;
  return fields[index].group !== fields[index - 1].group;
}

/**
 * ONE element per cell: a rounded fill whose colour and number come from
 * the same percentage. The previous version drew a bar AND printed a
 * number, which said the same thing twice and left the eye nothing to scan
 * across a row of eleven columns.
 *
 * A field no open deal owes reads "n/a" with no colour at all — scoring it
 * green would credit a rep for a column that was never in play.
 */
function HeatCell({
  fill,
  className,
  emphasis = false,
}: {
  fill: FieldFill;
  className?: string;
  /** The Overall column — same colours, slightly louder. */
  emphasis?: boolean;
}) {
  if (fill.applicable === 0) {
    return (
      <td
        title="Not owed by any open deal at its current stage"
        className={cn(
          'whitespace-nowrap border-b border-slate-100 px-1 py-1.5 text-center text-[11px] text-slate-400 dark:border-[#151515] dark:text-[#71717A]',
          className,
        )}
      >
        n/a
      </td>
    );
  }
  const { bg, fg } = ragStyle(fill.pct);
  return (
    <td
      className={cn(
        'whitespace-nowrap border-b border-slate-100 px-1 py-1.5 dark:border-[#151515]',
        className,
      )}
    >
      <span
        title={`${fill.filled} of ${fill.applicable} deals have this`}
        className={cn(
          'block min-w-[44px] rounded-md px-2 py-1 text-center tabular-nums',
          emphasis ? 'text-[12px] font-semibold' : 'text-[11.5px] font-medium',
          bg,
          fg,
        )}
      >
        {fill.pct}%
      </span>
    </td>
  );
}
