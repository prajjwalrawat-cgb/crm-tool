import type {
  CommunicationThread,
  ParticipantRole,
  ThreadStatus,
} from '@/db/schema';

/**
 * Public-facing types for the threads domain. Kept client-safe (no
 * `server-only` import) so inbox cards can consume the row shape
 * without dragging server code into the bundle.
 */

export type InboxThreadRow = CommunicationThread & {
  /** Up to 3 participants, role='from' first then to/cc. */
  participants: {
    emailAddress: string;
    participantRole: ParticipantRole;
    contactId: string | null;
  }[];
};

/** Filter for the inbox list query. Status defaults to 'active'. */
export type InboxFilter = {
  status?: ThreadStatus;
  /** Only threads with `unread_count > 0`. */
  unreadOnly?: boolean;
  /** Only threads with at least one failed delivery. */
  failedOnly?: boolean;
  /** Restrict to a single CRM entity. */
  entityType?: string;
  entityId?: string;
};

export type InboxCursor = {
  /** ISO of last_message_at on the last visible row. */
  ts: string;
  /** Thread id on the last visible row (tie-breaker). */
  id: string;
};
