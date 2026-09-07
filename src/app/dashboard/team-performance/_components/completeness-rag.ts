import {
  completenessBand,
  ratioOf,
  type CompletenessBand,
  type FieldGroupKey,
} from '@/lib/deals/completeness';
import type { ScorecardField } from '@/lib/team-analytics/scorecard';

/**
 * The completeness heatmap's colour rule and the ranking that drives both
 * the weakest-field callout and the collapsed column set.
 *
 * A plain module (no `use client`), because the server section renders the
 * callout and the client table renders the cells, and both must colour a
 * given percentage identically. Duplicating a threshold across those two
 * files is exactly how a cell ends up green next to a chip calling the same
 * number a problem.
 */

export type RagStyle = {
  /** Tailwind classes for the cell fill. */
  bg: string;
  /** Tailwind classes for the number sitting on it. */
  fg: string;
};

/**
 * Red / amber / green for a completeness percentage.
 *
 * Takes a PERCENTAGE (0–100), not a ratio, and deliberately so: the caller
 * has already rounded the number it is about to display, and colouring off
 * the unrounded ratio is what makes a cell reading "80%" come out amber
 * because it was really 0.7996.
 *
 * Thresholds live in `@/lib/deals/completeness` (40 / 80) and are read
 * through `completenessBand` rather than repeated here — see the note there
 * about why they are flat across every field for now, and why per-field or
 * per-stage cut-offs belong on the spec rather than in this renderer.
 *
 * Classes rather than `var(--bg-success)`: this codebase has no CSS custom
 * property token layer — every surface expresses theming as Tailwind
 * utilities with explicit `dark:` variants, and inventing a parallel
 * variable system for one table would leave the page half in each scheme.
 */
export function ragStyle(pct: number): RagStyle {
  return RAG_STYLES[completenessBand(pct / 100)];
}

const RAG_STYLES: Record<CompletenessBand, RagStyle> = {
  good: {
    bg: 'bg-emerald-50 dark:bg-emerald-500/15',
    fg: 'text-emerald-700 dark:text-emerald-300',
  },
  patchy: {
    bg: 'bg-amber-50 dark:bg-amber-500/15',
    fg: 'text-amber-700 dark:text-amber-300',
  },
  poor: {
    bg: 'bg-rose-50 dark:bg-rose-500/15',
    fg: 'text-rose-700 dark:text-rose-300',
  },
};

/** One field's fill rate, ready to render or rank. */
export type FieldFill = {
  key: string;
  label: string;
  applicable: number;
  filled: number;
  /** Rounded percentage — the number shown, and the one `ragStyle` reads. */
  pct: number;
};

/**
 * Fill rate per field for one row's tallies, in the field order given.
 * Fields nothing owes (`applicable === 0`) come back with `pct: null`
 * semantics via `applicable === 0` — callers render those as "n/a" rather
 * than as a 100% nobody earned.
 */
export function fieldFills(
  fields: readonly ScorecardField[],
  byField: Record<string, { applicable: number; filled: number }>,
): FieldFill[] {
  return fields.map((f) => {
    const t = byField[f.key] ?? { applicable: 0, filled: 0 };
    return {
      key: f.key,
      label: f.label,
      applicable: t.applicable,
      filled: t.filled,
      pct: Math.round(ratioOf(t.filled, t.applicable) * 100),
    };
  });
}

/**
 * The weakest fields first. Only fields some deal actually owes are ranked
 * — a column no open deal owes is not the team's biggest data problem, it
 * is simply not in play. Ties keep the incoming field order, so the list is
 * stable between renders.
 */
export function weakestFirst(fills: readonly FieldFill[]): FieldFill[] {
  return fills.filter((f) => f.applicable > 0).sort((a, b) => a.pct - b.pct);
}

/**
 * Consecutive runs of fields sharing a group, for the two-tier header.
 *
 * Built by walking the list once and chunking on `group` rather than by
 * looking each group up, so a header cell's `colSpan` is always exactly the
 * number of columns rendered beneath it — the two cannot drift, and a field
 * whose group is unknown to the header simply starts its own run instead of
 * disappearing.
 *
 * Requires grouped fields to be adjacent, which `DEAL_FIELD_SPECS` states as
 * a property of its order.
 */
export function groupRuns<T extends { group: FieldGroupKey }>(
  fields: readonly T[],
): { key: FieldGroupKey; fields: T[] }[] {
  const runs: { key: FieldGroupKey; fields: T[] }[] = [];
  for (const f of fields) {
    const last = runs[runs.length - 1];
    if (last && last.key === f.group) last.fields.push(f);
    else runs.push({ key: f.group, fields: [f] });
  }
  return runs;
}
