import type { CallStatus } from '@/db/schema/telephony';

/**
 * Call status ordering. Pure.
 *
 * Status only moves forward: initiated < ringing < answered < terminal.
 * Terminal states (completed, no_answer, busy, failed, missed) never regress
 * and never change into another terminal state, so an out-of-order or
 * duplicate webhook can't undo what we already know.
 */
const RANK: Record<CallStatus, number> = {
  initiated: 0,
  ringing: 1,
  answered: 2,
  completed: 3,
  no_answer: 3,
  busy: 3,
  failed: 3,
  missed: 3,
};

export const TERMINAL_STATUSES: readonly CallStatus[] = ['completed', 'no_answer', 'busy', 'failed', 'missed'];

export function isTerminal(s: CallStatus): boolean {
  return RANK[s] === 3;
}

/** The status to store after seeing `incoming` while holding `current`. */
export function mergeStatus(current: CallStatus | null, incoming: CallStatus): CallStatus {
  if (!current) return incoming;
  if (isTerminal(current)) return current;
  return RANK[incoming] >= RANK[current] ? incoming : current;
}

/** Statuses after which the call reached a human on the customer side. */
export function wasConnected(s: CallStatus, talkTimeSec: number | null): boolean {
  return s === 'answered' || (s === 'completed' && (talkTimeSec ?? 0) > 0);
}

/** Merge a nullable field: keep what we have unless the event brings a value. */
export function keep<T>(current: T | null | undefined, incoming: T | null | undefined): T | null {
  return incoming ?? current ?? null;
}
