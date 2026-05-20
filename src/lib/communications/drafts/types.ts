import type {
  CommunicationDraft,
  DraftContextKind,
} from '@/db/schema';

/**
 * Public client-safe types for the drafts domain.
 *
 * The client never holds the full `CommunicationDraft` shape — the
 * subset below is what the composer mounts with.
 */
export type DraftSnapshot = Pick<
  CommunicationDraft,
  | 'id'
  | 'subject'
  | 'bodyHtml'
  | 'bodyText'
  | 'toRecipients'
  | 'ccRecipients'
  | 'bccRecipients'
  | 'version'
  | 'updatedAt'
>;

export type DraftLookupKey = {
  contextKind: DraftContextKind;
  threadId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
};

export type DraftSaveInput = DraftLookupKey & {
  subject?: string;
  bodyHtml?: string | null;
  bodyText?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  /**
   * Caller's last-seen version. The server rejects if the stored
   * version has advanced past this number.
   */
  expectedVersion: number;
};

/** Result of a save attempt. */
export type DraftSaveResult =
  | { ok: true; draft: DraftSnapshot }
  | { ok: false; reason: 'stale'; current: DraftSnapshot }
  | { ok: false; reason: 'invalid'; message: string };

/**
 * Autosave debounce window — single source of truth so the composer
 * and tests agree. 800 ms strikes the balance: feels instant to the
 * user; saves once between key bursts.
 */
export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 800;
