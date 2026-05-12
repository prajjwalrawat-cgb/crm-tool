/**
 * Client- and server-safe mention helpers.
 *
 * On-wire format for mentions inside a comment body:
 *   @[Display Name](user-id)
 *
 * It's markdown-link-ish — easy to parse, easy to type, survives
 * round-tripping through JSON and DB text columns. The renderer
 * splits the body into plain-text and mention runs; the picker
 * inserts the same shape.
 *
 * Why store inline AND in a separate `mentioned_user_ids` array:
 *   - Inline preserves the exact display context so renaming a user
 *     downstream doesn't rewrite history.
 *   - Array form makes notification fan-out O(1) lookup per comment
 *     instead of re-parsing the body on every list query.
 */

const MENTION_PATTERN = /@\[([^\]]+)\]\(([^)]+)\)/g;

export type MentionRun = {
  kind: 'mention';
  displayName: string;
  userId: string;
};

export type TextRun = {
  kind: 'text';
  text: string;
};

export type CommentRun = TextRun | MentionRun;

export function extractMentionUserIds(body: string): string[] {
  const ids = new Set<string>();
  const matches = body.matchAll(MENTION_PATTERN);
  for (const m of matches) {
    const id = m[2];
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * Tokenize a comment body into a sequence of text and mention runs
 * for rendering. Preserves order; collapses adjacent text but
 * doesn't trim — whitespace at the seam between a mention and
 * surrounding text is significant.
 */
export function parseMentions(body: string): CommentRun[] {
  const runs: CommentRun[] = [];
  let cursor = 0;
  MENTION_PATTERN.lastIndex = 0; // global regex; reset between calls.
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATTERN.exec(body)) !== null) {
    if (match.index > cursor) {
      runs.push({ kind: 'text', text: body.slice(cursor, match.index) });
    }
    runs.push({
      kind: 'mention',
      displayName: match[1] ?? '',
      userId: match[2] ?? '',
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) {
    runs.push({ kind: 'text', text: body.slice(cursor) });
  }
  return runs;
}

/** Plain-text preview for notifications, search, and recent-comment chrome. */
export function commentPreview(body: string, max = 120): string {
  const plain = parseMentions(body)
    .map((r) => (r.kind === 'mention' ? `@${r.displayName}` : r.text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}

export function formatMentionToken(
  displayName: string,
  userId: string,
): string {
  return `@[${displayName}](${userId})`;
}
