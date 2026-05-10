/**
 * Public surface of the observability layer. Boundary code (route
 * handlers, server actions, Inngest functions) imports from here; the
 * underlying split (trace, logger, metrics, errors) is an internal
 * implementation detail.
 */
export {
  runWithTrace,
  withSpan,
  getTraceContext,
  currentTraceId,
  currentSpanId,
  newTraceId,
  type TraceOrigin,
  type TraceContext,
} from './trace';
export { logger } from './logger';
export { captureError, type ErrorSeverity } from './errors';
export {
  incr,
  observe,
  setGauge,
  adjustGauge,
  snapshotMetrics,
  type MetricsSnapshot,
  type HistogramSummary,
} from './metrics';
export {
  recentLogs,
  recentErrors,
  type LogEntry,
  type ErrorEntry,
} from './events';
