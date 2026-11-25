import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { meetingOutcomes, meetings, type MeetingNextStep, type MeetingOutcome } from '@/db/schema';
import type { MeetingSentiment } from '@/db/schema/enums';
import { tenantTransaction } from '@/lib/db-context';

import { checkOutTx } from './checkins';
import { asActor, nowOf, optText, publishMeetingUpdated, type FieldDeps, type Position } from './internal';
import { lockOwnedMeeting } from './scope';
import { assertTransition } from './state-machine';
import { FieldError, type FieldActor } from './types';

export type SaveOutcomeInput = {
  momText: string;
  sentiment?: MeetingSentiment | null;
  nextSteps?: Array<{ action: string; dueDate?: string | null }>;
  /** "Check out & log MOM": given while the meeting is checked_in → check out first, same transaction. */
  checkOutAt?: Position;
};

const SENTIMENTS: MeetingSentiment[] = ['positive', 'neutral', 'negative'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STEPS = 20;

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseInput(input: SaveOutcomeInput): { momText: string; sentiment: MeetingSentiment | null; nextSteps: MeetingNextStep[] } {
  const momText = optText(input.momText, 'MOM', 20_000);
  if (!momText) throw new FieldError('validation', 'Minutes of meeting are required');
  const sentiment = input.sentiment ?? null;
  if (sentiment !== null && !SENTIMENTS.includes(sentiment)) throw new FieldError('validation', 'Unknown sentiment');
  const steps = input.nextSteps ?? [];
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) {
    throw new FieldError('validation', `Up to ${MAX_STEPS} next steps`);
  }
  const nextSteps = steps.map((s, i): MeetingNextStep => {
    const text = optText(s?.action, `Next step ${i + 1}`, 500);
    if (!text) throw new FieldError('validation', `Next step ${i + 1} needs an action`);
    const dueDate = s.dueDate ?? null;
    if (dueDate !== null && !validDate(dueDate)) throw new FieldError('validation', `Next step ${i + 1}: due date must be YYYY-MM-DD`);
    return { text, dueDate };
  });
  return { momText, sentiment, nextSteps };
}

/**
 * Save (or replace) the meeting's MOM and move it to `mom_logged`. Clears the
 * `mom_missing` risk reason. Owner only.
 */
export function saveOutcome(
  actor: FieldActor,
  id: string,
  input: SaveOutcomeInput,
  deps?: FieldDeps,
): Promise<MeetingOutcome> {
  return asActor(actor, async () => {
    const values = parseInput(input);
    const now = nowOf(deps);
    return tenantTransaction(async (tx) => {
      let cur = await lockOwnedMeeting(tx, actor, id);
      if (input.checkOutAt && cur.status === 'checked_in') {
        cur = (await checkOutTx(tx, actor, cur, input.checkOutAt, now)).meeting;
      }
      // Editing an existing MOM replaces it without another transition.
      if (cur.status !== 'mom_logged') assertTransition(cur.status, 'mom_logged', cur.type);

      const [outcome] = await tx
        .insert(meetingOutcomes)
        .values({ tenantId: actor.tenantId, meetingId: cur.id, ...values, createdBy: actor.userId })
        .onConflictDoUpdate({ target: meetingOutcomes.meetingId, set: { ...values, updatedAt: now } })
        .returning();
      const [row] = await tx
        .update(meetings)
        .set({
          status: 'mom_logged',
          atRiskReasons: sql`array_remove(${meetings.atRiskReasons}, 'mom_missing')`,
          updatedAt: now,
        })
        .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, cur.id)))
        .returning();
      await publishMeetingUpdated(tx, row!);
      return outcome!;
    });
  });
}
