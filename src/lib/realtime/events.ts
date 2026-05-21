import type {
  ActivityAction,
  ActivityEntityType,
  Company,
  Contact,
  Deal,
  MembershipRole,
} from '@/db/schema';
import type { ActorSummary } from '@/lib/activity/queries';

/**
 * Discriminated union of every realtime event the app publishes.
 *
 * Naming convention: `<entity>.<verb>` — e.g. `deal.stage_changed`. Verbs
 * mirror the activity-log action vocabulary so the audit trail and the
 * realtime stream stay in lockstep; if you add a new action, add the
 * matching event here.
 *
 * Each event carries the `tenantId` so client code can defensively reject
 * cross-tenant noise even if the server-side channel isolation ever fails.
 */
export type RealtimeEvent =
  /* ----- deals ----- */
  | { type: 'deal.created'; tenantId: string; deal: SerializedDeal }
  | { type: 'deal.updated'; tenantId: string; deal: SerializedDeal }
  | {
      type: 'deal.stage_changed';
      tenantId: string;
      deal: SerializedDeal;
      from: Deal['stage'];
      to: Deal['stage'];
    }
  | { type: 'deal.deleted'; tenantId: string; dealId: string; name: string }
  | { type: 'deal.restored'; tenantId: string; deal: SerializedDeal }
  /* ----- companies ----- */
  | { type: 'company.created'; tenantId: string; company: SerializedCompany }
  | { type: 'company.updated'; tenantId: string; company: SerializedCompany }
  | {
      type: 'company.deleted';
      tenantId: string;
      companyId: string;
      name: string;
    }
  | { type: 'company.restored'; tenantId: string; company: SerializedCompany }
  /* ----- contacts ----- */
  | { type: 'contact.created'; tenantId: string; contact: SerializedContact }
  | { type: 'contact.updated'; tenantId: string; contact: SerializedContact }
  | {
      type: 'contact.deleted';
      tenantId: string;
      contactId: string;
      name: string;
    }
  | { type: 'contact.restored'; tenantId: string; contact: SerializedContact }
  /* ----- team ----- */
  | {
      type: 'member.invited';
      tenantId: string;
      email: string;
      role: 'admin' | 'manager' | 'member';
      invitationId: string;
    }
  | {
      type: 'member.invitation_revoked';
      tenantId: string;
      invitationId: string;
    }
  | {
      type: 'member.removed';
      tenantId: string;
      userId: string;
      targetName: string | null;
    }
  | {
      type: 'member.role_changed';
      tenantId: string;
      userId: string;
      role: MembershipRole;
      targetName: string | null;
    }
  /* ----- activity ----- */
  | {
      type: 'activity.recorded';
      tenantId: string;
      entry: SerializedActivity;
    }
  /* ----- presence ----- */
  | {
      type: 'presence.snapshot';
      tenantId: string;
      members: PresenceMember[];
    }
  /* ----- notifications -----
   *
   * Per-recipient. Published on the tenant channel and filtered by
   * recipientUserId on the client — simpler than per-user channels
   * and reuses existing infra.
   */
  | {
      type: 'notification.created';
      tenantId: string;
      recipientUserId: string;
      notification: SerializedNotification;
    }
  /* ----- comments -----
   *
   * Published on the tenant channel. The thread component filters by
   * `(entityType, entityId)` so unrelated rooms don't reshuffle when
   * a comment fires on a different deal.
   */
  | {
      type: 'comment.created';
      tenantId: string;
      entityType: 'deal' | 'company' | 'contact';
      entityId: string;
      comment: SerializedComment;
    }
  /* ----- intelligence -----
   *
   * Fires after an Inngest job UPSERTs a row in `ai_summaries`. The
   * client uses `(entityType, entityId)` to swap the matching card
   * from stale → cached without a page reload.
   */
  | {
      type: 'ai.summary.updated';
      tenantId: string;
      /** Insight type from src/lib/intelligence/types.ts. */
      entityType: string;
      entityId: string;
      generatedAt: string;
    }
  | {
      type: 'intelligence.risk.updated';
      tenantId: string;
      /** Count of currently-open risks at info/warning/danger. */
      counts: { info: number; warning: number; danger: number };
    }
  | {
      type: 'intelligence.recommendation.updated';
      tenantId: string;
      /** Number of open recommendations across the workspace. */
      count: number;
    }
  /* ----- entity presence + typing -----
   *
   * Ephemeral, no DB writes. Clients emit `viewing.started`/`viewing.stopped`
   * when mounting/unmounting an entity detail view; `typing.started`/
   * `typing.stopped` when typing in a comment / note / email composer.
   *
   * The SSE bus relays them to every listener on the tenant channel; UI
   * components filter by `(entityType, entityId)` for the room they care
   * about. Both event families auto-expire client-side so a missed
   * `stopped` event doesn't leave a ghost in the indicator strip.
   */
  | {
      type: 'viewing.started';
      tenantId: string;
      userId: string;
      displayName: string | null;
      imageUrl: string | null;
      entity: { type: 'deal' | 'company' | 'contact'; id: string };
    }
  | {
      type: 'viewing.stopped';
      tenantId: string;
      userId: string;
      entity: { type: 'deal' | 'company' | 'contact'; id: string };
    }
  | {
      type: 'typing.started';
      tenantId: string;
      userId: string;
      displayName: string | null;
      thread: { type: 'comment' | 'note' | 'email'; entityType: string; entityId: string };
    }
  | {
      type: 'typing.stopped';
      tenantId: string;
      userId: string;
      thread: { type: 'comment' | 'note' | 'email'; entityType: string; entityId: string };
    }
  /* ----- communications -----
   *
   * Inbox + composer realtime taxonomy (CP#16C-A). The shape mirrors
   * the existing `comment.created` style: server actions emit these
   * inside the same transaction as the row write, the inbox client
   * applies them via the SSE bus, and component-level handlers
   * filter by `(threadId, messageId, draftId)` for the room they
   * care about.
   *
   * `thread.updated` is a generic "something about this thread
   * changed" — message count, status, preview, unread. The client
   * re-fetches the thread row on receipt rather than carrying the
   * full delta on the wire.
   *
   * `draft.updated` fires when the same user has multiple tabs open;
   * the other tabs re-fetch from the server to converge on the
   * authoritative version.
   */
  | {
      type: 'communication.thread.updated';
      tenantId: string;
      threadId: string;
      lastMessageAt: string;
    }
  | {
      type: 'communication.message.sent';
      tenantId: string;
      threadId: string;
      messageId: string;
    }
  | {
      type: 'communication.message.failed';
      tenantId: string;
      threadId: string;
      messageId: string;
      reason: string | null;
    }
  | {
      type: 'communication.draft.updated';
      tenantId: string;
      /** Owner of the draft — clients filter by this so other users don't react. */
      userId: string;
      draftId: string;
      version: number;
    }
  | {
      type: 'communication.typing.started';
      tenantId: string;
      userId: string;
      displayName: string | null;
      threadId: string;
    }
  | {
      type: 'communication.typing.stopped';
      tenantId: string;
      userId: string;
      threadId: string;
    };

export type EventKind = RealtimeEvent['type'];

/**
 * Wire envelope. Each event is wrapped with an id (for client-side dedup)
 * and an emit timestamp (for stale-event handling on reconnect).
 */
export type RealtimeEnvelope<T extends RealtimeEvent = RealtimeEvent> = {
  id: string;
  emittedAt: string;
  event: T;
};

/* -------- presence -------- */

export type PresenceMember = {
  userId: string;
  /** Display name — pre-resolved server-side so the UI never re-fetches Clerk. */
  displayName: string | null;
  imageUrl: string | null;
};

/* -------- serialized payloads --------
 *
 * Drizzle returns Date objects on row reads; we ship ISO strings on the wire
 * because EventSource only delivers strings and JSON has no Date type. The
 * client converts back when it actually needs a Date.
 */

// Tuple-wrap disables distributive matching: `Date` distributes over
// `Date | null` and would otherwise collapse non-null Date fields to
// `string | null`. With `[T[K]] extends [Date]`, only the exact Date type
// matches the first branch.
type DateToString<T> = {
  [K in keyof T]: [T[K]] extends [Date]
    ? string
    : [T[K]] extends [Date | null]
      ? string | null
      : T[K];
};

export type SerializedDeal = DateToString<Deal> & {
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
};

export type SerializedCompany = DateToString<Company>;
export type SerializedContact = DateToString<Contact>;

export type SerializedActivity = {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: ActivityAction;
  metadata: Record<string, unknown>;
  createdAt: string;
  actor: ActorSummary | null;
};

export type SerializedNotification = {
  id: string;
  tenantId: string;
  recipientUserId: string;
  actorUserId: string | null;
  type: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  subtitle: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export type SerializedComment = {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  authorUserId: string;
  authorDisplayName: string | null;
  parentCommentId: string | null;
  body: string;
  mentionedUserIds: string[];
  editedAt: string | null;
  createdAt: string;
};

/* -------- channel + helper utilities -------- */

/**
 * Postgres NOTIFY channel names: `tenant:<uuid>`. Keep the prefix in one
 * place so the listener and the publisher can't drift.
 */
export function tenantChannel(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/* -------- date serialization helpers -------- */

export function serializeDates<T extends Record<string, unknown>>(
  row: T,
): DateToString<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out as DateToString<T>;
}

/**
 * Inverse of `serializeDates` for deal payloads. Used by the kanban board
 * client to fold incoming SSE events back into its `DealRow`-shaped state.
 * `expectedCloseDate` stays a string ('YYYY-MM-DD') — that's how the DB's
 * `date` column round-trips through Drizzle anyway.
 */
export type DeserializedDeal = Omit<
  SerializedDeal,
  'createdAt' | 'updatedAt' | 'closedAt' | 'deletedAt'
> & {
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  deletedAt: Date | null;
};

export function deserializeDeal(d: SerializedDeal): DeserializedDeal {
  return {
    ...d,
    createdAt: new Date(d.createdAt),
    updatedAt: new Date(d.updatedAt),
    closedAt: d.closedAt ? new Date(d.closedAt) : null,
    deletedAt: d.deletedAt ? new Date(d.deletedAt) : null,
  };
}
