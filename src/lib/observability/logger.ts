import 'server-only';

import { getTenantContext } from '@/lib/db-context';

import { recentLogs, type LogEntry } from './events';
import { incr } from './metrics';
import { getTraceContext } from './trace';

/**
 * Structured logger. Every log line is also pushed to the in-memory
 * ring buffer for the ops dashboard, and every line auto-attaches the
 * active trace + tenant context.
 *
 * Output:
 *   - Console JSON in production (so platform log collectors parse it).
 *   - Pretty single-line in development (so it's grep-able).
 *
 * Logs do not throw. A buggy log call must never break the request.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ENABLED_LEVEL: Level =
  (process.env.LOG_LEVEL as Level | undefined) ??
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function levelEnabled(level: Level): boolean {
  return ORDER[level] >= ORDER[ENABLED_LEVEL];
}

function buildEntry(
  level: Level,
  message: string,
  fields?: Record<string, unknown>,
): LogEntry {
  const trace = getTraceContext();
  const tenant = getTenantContext();
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    traceId: trace?.traceId,
    spanId: trace?.spanId,
    tenantId: tenant?.tenantId,
    userId: tenant?.userId,
    fields,
  };
}

function emit(entry: LogEntry): void {
  try {
    recentLogs.push(entry);
    incr('log.count', 1, { level: entry.level });
  } catch {
    // Never let the ring/metrics break the actual log emission.
  }

  // Console writes: JSON in prod, pretty in dev.
  if (process.env.NODE_ENV === 'production') {
    const sink =
      entry.level === 'error'
        ? console.error
        : entry.level === 'warn'
          ? console.warn
          : console.log;
    sink(JSON.stringify(entry));
    return;
  }

  const tail = entry.fields && Object.keys(entry.fields).length
    ? ` ${JSON.stringify(entry.fields)}`
    : '';
  const tag = entry.traceId ? ` trace=${entry.traceId.slice(0, 8)}` : '';
  const tenant = entry.tenantId ? ` tenant=${entry.tenantId.slice(0, 8)}` : '';
  const line = `[${entry.level}]${tag}${tenant} ${entry.message}${tail}`;
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.log(line);
}

function log(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (!levelEnabled(level)) return;
  emit(buildEntry(level, message, fields));
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) =>
    log('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) =>
    log('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    log('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) =>
    log('error', message, fields),
};
