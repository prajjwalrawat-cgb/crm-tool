/**
 * Chart Studio config shape. Kept client-safe (no `server-only`) so
 * the studio panel can validate + diff configs on the user's screen.
 *
 * Each chart key declares which variants are compatible. Trying to
 * save an incompatible variant is rejected at the action layer.
 */

export const CHART_KEY_REVENUE_TREND = 'revenue-trend' as const;
export const CHART_KEY_STAGE_CONVERSION = 'stage-conversion' as const;
export const CHART_KEY_STAGE_DONUT = 'stage-donut' as const;

export type ChartKey =
  | typeof CHART_KEY_REVENUE_TREND
  | typeof CHART_KEY_STAGE_CONVERSION
  | typeof CHART_KEY_STAGE_DONUT;

/* ============================================================ */
/* Variants — which chart shape to draw                          */
/* ============================================================ */

export type RevenueTrendVariant =
  | 'area'
  | 'line'
  | 'bar'
  | 'stacked-area'
  | 'flutter';

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
    value: 'flutter',
    label: 'Flutter',
    description: 'Animated flowing curves with a glowing trace.',
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

/* ============================================================ */
/* Metric — what the chart should be MEASURING                   */
/* ============================================================ */

export type RevenueTrendMetric =
  | 'revenue'
  | 'dealCount'
  | 'avgDealSize'
  | 'conversionRate';

export const REVENUE_TREND_METRICS: ReadonlyArray<{
  value: RevenueTrendMetric;
  label: string;
  description: string;
  /** Whether the values are currency (drives axis formatter). */
  isCurrency: boolean;
  /** Whether the values are a percentage (0-100 axis). */
  isPercentage: boolean;
}> = [
  {
    value: 'revenue',
    label: 'Revenue',
    description: 'Won · new pipeline · lost (currency)',
    isCurrency: true,
    isPercentage: false,
  },
  {
    value: 'dealCount',
    label: 'Deal count',
    description: 'How many deals moved each day',
    isCurrency: false,
    isPercentage: false,
  },
  {
    value: 'avgDealSize',
    label: 'Avg deal size',
    description: 'Won revenue ÷ won-deal count per day',
    isCurrency: true,
    isPercentage: false,
  },
  {
    value: 'conversionRate',
    label: 'Conversion rate',
    description: 'Cumulative won ÷ (won + lost), %',
    isCurrency: false,
    isPercentage: true,
  },
];

/* ============================================================ */
/* Display toggles                                               */
/* ============================================================ */

export type RevenueTrendDisplay = {
  /** Render the colored series-legend strip in the footer. */
  showLegend: boolean;
  /** Use monotone Bezier curves (vs straight lines). */
  smoothLines: boolean;
  /** Native Recharts enter animations (550-750ms per series). */
  animated: boolean;
  /** Show the Lost series (line / bar / area, depending on variant). */
  showLostLine: boolean;
  /** Compact KPI band — reduces title block height. */
  compact: boolean;
  /** Cumulative running-total view (sum-to-date). */
  cumulative: boolean;
};

export type RevenueTrendConfig = {
  variant: RevenueTrendVariant;
  metric: RevenueTrendMetric;
  display: RevenueTrendDisplay;
};

export const DEFAULT_REVENUE_TREND_CONFIG: RevenueTrendConfig = {
  variant: 'area',
  metric: 'revenue',
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

  const metricRaw = r.metric as RevenueTrendMetric | undefined;
  const validMetric = REVENUE_TREND_METRICS.some(
    (m) => m.value === metricRaw,
  );
  const metric = validMetric
    ? (metricRaw as RevenueTrendMetric)
    : DEFAULT_REVENUE_TREND_CONFIG.metric;

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
  return { variant, metric, display };
}

export type SavedChartView = {
  id: string;
  title: string | null;
  roleScope: 'user' | 'team' | 'tenant';
  config: RevenueTrendConfig;
  isDefault: boolean;
};

/* ============================================================ */
/* Stage Conversion chart (replaces the old static funnel)       */
/* ============================================================ */

export type StageConversionVariant = 'bars' | 'funnel' | 'donut' | 'pie';

export const STAGE_CONVERSION_VARIANTS: ReadonlyArray<{
  value: StageConversionVariant;
  label: string;
  description: string;
}> = [
  {
    value: 'bars',
    label: 'Horizontal bars',
    description: 'Compact revenue-weighted bars per stage.',
  },
  {
    value: 'funnel',
    label: 'Funnel',
    description: 'Trapezoidal stage segments — classic sales funnel.',
  },
  {
    value: 'donut',
    label: 'Donut',
    description: 'Stage share rendered as a centred ring.',
  },
  {
    value: 'pie',
    label: 'Pie',
    description: 'Stage share as a solid pie chart.',
  },
];

export type StageConversionMetric = 'revenue' | 'dealCount';

export const STAGE_CONVERSION_METRICS: ReadonlyArray<{
  value: StageConversionMetric;
  label: string;
  description: string;
}> = [
  {
    value: 'revenue',
    label: 'Revenue',
    description: 'Stage value in tenant currency.',
  },
  {
    value: 'dealCount',
    label: 'Deal count',
    description: 'How many deals sit in each stage.',
  },
];

export type StageConversionConfig = {
  variant: StageConversionVariant;
  metric: StageConversionMetric;
  display: {
    showConversionPct: boolean;
    showCloseProb: boolean;
    animated: boolean;
    compact: boolean;
  };
};

export const DEFAULT_STAGE_CONVERSION_CONFIG: StageConversionConfig = {
  variant: 'bars',
  metric: 'revenue',
  display: {
    showConversionPct: true,
    showCloseProb: true,
    animated: true,
    compact: false,
  },
};

export function parseStageConversionConfig(raw: unknown): StageConversionConfig {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_STAGE_CONVERSION_CONFIG;
  }
  const r = raw as Record<string, unknown>;
  const variant = STAGE_CONVERSION_VARIANTS.some((v) => v.value === r.variant)
    ? (r.variant as StageConversionVariant)
    : DEFAULT_STAGE_CONVERSION_CONFIG.variant;
  const metric = STAGE_CONVERSION_METRICS.some((m) => m.value === r.metric)
    ? (r.metric as StageConversionMetric)
    : DEFAULT_STAGE_CONVERSION_CONFIG.metric;
  const d = (r.display ?? {}) as Record<string, unknown>;
  return {
    variant,
    metric,
    display: {
      showConversionPct:
        typeof d.showConversionPct === 'boolean'
          ? d.showConversionPct
          : DEFAULT_STAGE_CONVERSION_CONFIG.display.showConversionPct,
      showCloseProb:
        typeof d.showCloseProb === 'boolean'
          ? d.showCloseProb
          : DEFAULT_STAGE_CONVERSION_CONFIG.display.showCloseProb,
      animated:
        typeof d.animated === 'boolean'
          ? d.animated
          : DEFAULT_STAGE_CONVERSION_CONFIG.display.animated,
      compact:
        typeof d.compact === 'boolean'
          ? d.compact
          : DEFAULT_STAGE_CONVERSION_CONFIG.display.compact,
    },
  };
}

/* ============================================================ */
/* Stage Donut chart                                             */
/* ============================================================ */

export type StageDonutVariant = 'donut' | 'pie' | 'bars';

export const STAGE_DONUT_VARIANTS: ReadonlyArray<{
  value: StageDonutVariant;
  label: string;
  description: string;
}> = [
  { value: 'donut', label: 'Donut', description: 'Hollow ring with centre total.' },
  { value: 'pie', label: 'Pie', description: 'Solid pie chart.' },
  { value: 'bars', label: 'Mini bars', description: 'Vertical stage bars.' },
];

export type StageDonutMetric = 'dealCount' | 'revenue';

export const STAGE_DONUT_METRICS: ReadonlyArray<{
  value: StageDonutMetric;
  label: string;
  description: string;
}> = [
  {
    value: 'dealCount',
    label: 'Deal count',
    description: 'How many deals per stage (counts).',
  },
  {
    value: 'revenue',
    label: 'Revenue',
    description: 'Stage value in tenant currency.',
  },
];

export type StageDonutConfig = {
  variant: StageDonutVariant;
  metric: StageDonutMetric;
  display: {
    showLegend: boolean;
    animated: boolean;
  };
};

export const DEFAULT_STAGE_DONUT_CONFIG: StageDonutConfig = {
  variant: 'donut',
  metric: 'dealCount',
  display: {
    showLegend: true,
    animated: true,
  },
};

export function parseStageDonutConfig(raw: unknown): StageDonutConfig {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_STAGE_DONUT_CONFIG;
  }
  const r = raw as Record<string, unknown>;
  const variant = STAGE_DONUT_VARIANTS.some((v) => v.value === r.variant)
    ? (r.variant as StageDonutVariant)
    : DEFAULT_STAGE_DONUT_CONFIG.variant;
  const metric = STAGE_DONUT_METRICS.some((m) => m.value === r.metric)
    ? (r.metric as StageDonutMetric)
    : DEFAULT_STAGE_DONUT_CONFIG.metric;
  const d = (r.display ?? {}) as Record<string, unknown>;
  return {
    variant,
    metric,
    display: {
      showLegend:
        typeof d.showLegend === 'boolean'
          ? d.showLegend
          : DEFAULT_STAGE_DONUT_CONFIG.display.showLegend,
      animated:
        typeof d.animated === 'boolean'
          ? d.animated
          : DEFAULT_STAGE_DONUT_CONFIG.display.animated,
    },
  };
}
