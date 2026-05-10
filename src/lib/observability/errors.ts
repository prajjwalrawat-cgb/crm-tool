import 'server-only';

import { getTenantContext } from '@/lib/db-context';

import { recentErrors, type ErrorEntry } from './events';
import { logger } from './logger';
import { incr } from './metrics';
import { getTraceContext } from './trace';

/**
 * Centralized error capture.
 *
 * Goals:
 *   - normalize random `unknown` into a stable `ErrorEntry` shape so the
 *     ops dashboard can render any failure path uniformly.
 *   - classify severity + retryable so triage is "scan the high/fatal
 *     entries first" rather than a wall of stacktraces.
 *   - increment per-category counters so retry spikes and category-level
 *     trends are visible without parsing log lines.
 *
 * NOT a Sentry replacement. There's no shipping to a remote backend yet —
 * just an in-process log + ring + counter set. The entry shape is
 * intentionally compatible with what a future Sentry/Datadog client
 * would want.
 */

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'fatal';

export type CaptureInput = {
  /** Human-readable category — keeps related failures grouped on /ops. */
  category: string;
  /** Default 'medium'. Use 'fatal' only for invariant breaches. */
  severity?: ErrorSeverity;
  /**
   * Marks errors expected to recover via retry (transient OpenAI 5xx,
   * NOTIFY blip). Used by the ops dashboard to suppress noisy categories
   * from the "needs attention" list.
   */
  retryable?: boolean;
  /** Free-form structured fields. Anything safe-to-log. */
  fields?: Record<string, unknown>;
};

function normalize(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: 'Unserializable error' };
  }
}

export function captureError(err: unknown, input: CaptureInput): ErrorEntry {
  const { message, stack } = normalize(err);
  const trace = getTraceContext();
  const tenant = getTenantContext();
  const entry: ErrorEntry = {
    message,
    stack,
    severity: input.severity ?? 'medium',
    category: input.category,
    retryable: input.retryable ?? false,
    capturedAt: new Date().toISOString(),
    traceId: trace?.traceId,
    spanId: trace?.spanId,
    tenantId: tenant?.tenantId,
    userId: tenant?.userId,
    fields: input.fields,
  };

  recentErrors.push(entry);
  incr('error.count', 1, {
    category: input.category,
    severity: entry.severity,
    retryable: entry.retryable ? 'true' : 'false',
  });

  logger.error(`${entry.category}: ${message}`, {
    severity: entry.severity,
    retryable: entry.retryable,
    ...(input.fields ?? {}),
    stack,
  });
  return entry;
}
