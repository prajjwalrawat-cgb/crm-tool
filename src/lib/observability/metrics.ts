import 'server-only';

/**
 * Tiny in-process metrics store. Single-instance only — no Redis, no
 * Prometheus, no external aggregator. Good enough for an ops dashboard
 * inside the same Node process; for multi-instance deploys you'd swap
 * the backend out behind these helpers.
 *
 * Three shapes:
 *   - counter: monotonic count, labelled. Total invocations, retries,
 *     skipped jobs, errors.
 *   - histogram: bounded ring of recent samples. Returns p50/p95 on
 *     read. Used for latencies (AI call, span duration, query).
 *   - gauge: instantaneous value. Used for "currently open SSE streams",
 *     "active workflow runs in last minute".
 *
 * All three modules survive across requests within one Node process, so
 * the ops page reads back exactly what the latest requests wrote.
 */

type LabelKey = string;

const counters = new Map<LabelKey, number>();
const gauges = new Map<LabelKey, number>();
const histograms = new Map<LabelKey, number[]>();

const HISTOGRAM_CAP = 256;

function labelKey(name: string, labels?: Record<string, string | number>): LabelKey {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`);
  return `${name}{${parts.join(',')}}`;
}

/* -------- Counters -------- */

export function incr(
  name: string,
  delta = 1,
  labels?: Record<string, string | number>,
): void {
  const key = labelKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + delta);
}

/* -------- Gauges -------- */

export function setGauge(
  name: string,
  value: number,
  labels?: Record<string, string | number>,
): void {
  gauges.set(labelKey(name, labels), value);
}

export function adjustGauge(
  name: string,
  delta: number,
  labels?: Record<string, string | number>,
): void {
  const key = labelKey(name, labels);
  gauges.set(key, (gauges.get(key) ?? 0) + delta);
}

/* -------- Histograms -------- */

export function observe(
  name: string,
  value: number,
  labels?: Record<string, string | number>,
): void {
  const key = labelKey(name, labels);
  const arr = histograms.get(key);
  if (!arr) {
    histograms.set(key, [value]);
    return;
  }
  arr.push(value);
  if (arr.length > HISTOGRAM_CAP) {
    // Drop the oldest half — keeps the most recent window without
    // recopying on every push.
    arr.splice(0, arr.length - HISTOGRAM_CAP);
  }
}

/** Span helper hook called by `withSpan`. Routed here to keep the API flat. */
export function recordSpan(name: string, durationMs: number): void {
  observe('span.duration_ms', durationMs, { span: name });
  incr('span.count', 1, { span: name });
}

/* -------- Snapshot (for /dashboard/ops) -------- */

export type HistogramSummary = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
};

function summarize(values: readonly number[]): HistogramSummary {
  if (values.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1]!,
    avg: sum / sorted.length,
  };
}

export type MetricsSnapshot = {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSummary>;
};

export function snapshotMetrics(): MetricsSnapshot {
  return {
    counters: Object.fromEntries(counters.entries()),
    gauges: Object.fromEntries(gauges.entries()),
    histograms: Object.fromEntries(
      Array.from(histograms.entries()).map(([k, v]) => [k, summarize(v)]),
    ),
  };
}

/** Reset — used by tests. Not exposed on any UI path. */
export function _resetMetricsForTests(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}
