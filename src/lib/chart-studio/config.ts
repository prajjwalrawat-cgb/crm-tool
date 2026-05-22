/**
 * Chart Studio config shape. Kept client-safe (no `server-only`) so
 * the studio panel can validate + diff configs on the user's screen.
 *
 * Each chart key declares which variants are compatible. Trying to
 * save an incompatible variant is rejected at the action layer.
 */

export const CHART_KEY_REVENUE_TREND = 'revenue-trend' as const;
export type ChartKey = typeof CHART_KEY_REVENUE_TREND;

export type RevenueTrendVariant = 'area' | 'line' | 'bar' | 'stacked-area';

export const REVENUE_TREND_VARIANTS: ReadonlyArray<{
  value: RevenueTrendVariant;
  label: string;
  description: string;
}> = [
  {
    value: 'area',
    label: 'Area chart',
    description: 'Smooth filled curves — the default analytics look.',
  },
  {
    value: 'stacked-area',
    label: 'Stacked area',
    description: 'Stacked won + new pipeline as cumulative bands.',
  },
  {
    value: 'line',
    label: 'Line chart',
    description: 'Clean unfilled lines — best for direct comparison.',
  },
  {
    value: 'bar',
    label: 'Bar chart',
    description: 'Daily bars — emphasizes discrete activity.',
  },
];

/** Display toggles available across all revenue-trend variants. */
export type RevenueTrendDisplay = {
  /** Render the colored series-legend strip in the footer. */
  showLegend: boolean;
  /** Use monotone Bezier curves (vs straight lines). */
  smoothLines: boolean;
  /** Native Recharts enter animations (550-750ms per series). */
  animated: boolean;
  /** Show the Lost-revenue dashed line. */
  showLostLine: boolean;
  /** Compact KPI band — reduces title block height. */
  compact: boolean;
  /** Cumulative running-total view (sum-to-date). */
  cumulative: boolean;
};

export type RevenueTrendConfig = {
  variant: RevenueTrendVariant;
  display: RevenueTrendDisplay;
};

export const DEFAULT_REVENUE_TREND_CONFIG: RevenueTrendConfig = {
  variant: 'area',
  display: {
    showLegend: true,
    smoothLines: true,
    animated: true,
    showLostLine: true,
    compact: false,
    cumulative: false,
  },
};

/**
 * Safe parser — anything unrecognized falls back to the default. The
 * studio panel writes the full shape every time, so this is mainly
 * defensive against stale rows after schema evolution.
 */
export function parseRevenueTrendConfig(
  raw: unknown,
): RevenueTrendConfig {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_REVENUE_TREND_CONFIG;
  }
  const r = raw as Record<string, unknown>;
  const variantRaw = r.variant as RevenueTrendVariant | undefined;
  const validVariant = REVENUE_TREND_VARIANTS.some(
    (v) => v.value === variantRaw,
  );
  const variant = validVariant
    ? (variantRaw as RevenueTrendVariant)
    : DEFAULT_REVENUE_TREND_CONFIG.variant;
  const dispRaw = (r.display ?? {}) as Record<string, unknown>;
  const display: RevenueTrendDisplay = {
    showLegend:
      typeof dispRaw.showLegend === 'boolean'
        ? dispRaw.showLegend
        : DEFAULT_REVENUE_TREND_CONFIG.display.showLegend,
    smoothLines:
      typeof dispRaw.smoothLines === 'boolean'
        ? dispRaw.smoothLines
        : DEFAULT_REVENUE_TREND_CONFIG.display.smoothLines,
    animated:
      typeof dispRaw.animated === 'boolean'
        ? dispRaw.animated
        : DEFAULT_REVENUE_TREND_CONFIG.display.animated,
    showLostLine:
      typeof dispRaw.showLostLine === 'boolean'
        ? dispRaw.showLostLine
        : DEFAULT_REVENUE_TREND_CONFIG.display.showLostLine,
    compact:
      typeof dispRaw.compact === 'boolean'
        ? dispRaw.compact
        : DEFAULT_REVENUE_TREND_CONFIG.display.compact,
    cumulative:
      typeof dispRaw.cumulative === 'boolean'
        ? dispRaw.cumulative
        : DEFAULT_REVENUE_TREND_CONFIG.display.cumulative,
  };
  return { variant, display };
}

export type SavedChartView = {
  id: string;
  title: string | null;
  roleScope: 'user' | 'team' | 'tenant';
  config: RevenueTrendConfig;
  isDefault: boolean;
};
