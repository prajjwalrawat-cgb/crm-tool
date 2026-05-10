import 'server-only';

/**
 * Bounded ring buffer for "recent X" surfaces on the ops dashboard.
 *
 * Keeps the last N entries — when full, the oldest is dropped. We don't
 * persist; the dashboard shows what the *current Node process* has seen.
 * For multi-instance deploys you'd page through `ai_invocations` /
 * `workflow_runs` directly; this ring is the cheap "live tail" view.
 */
export class RingBuffer<T> {
  private buffer: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  recent(limit?: number): T[] {
    const arr = this.buffer.slice().reverse();
    return typeof limit === 'number' ? arr.slice(0, limit) : arr;
  }

  size(): number {
    return this.buffer.length;
  }
}

export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  userId?: string;
  fields?: Record<string, unknown>;
};

export type ErrorEntry = {
  message: string;
  stack?: string;
  severity: 'low' | 'medium' | 'high' | 'fatal';
  category: string;
  retryable: boolean;
  capturedAt: string;
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  userId?: string;
  fields?: Record<string, unknown>;
};

/** Singletons. The ops dashboard reads from these. */
export const recentLogs = new RingBuffer<LogEntry>(500);
export const recentErrors = new RingBuffer<ErrorEntry>(200);
