import type { ActivityAction, ActivityEntityType } from '@/db/schema';

import type { ActivityRow } from './queries';

const ENTITY_LABEL: Record<ActivityEntityType, string> = {
  company: 'company',
  contact: 'contact',
  deal: 'deal',
  membership: 'member',
  invitation: 'invitation',
  task: 'task',
  note: 'note',
};

type FormattedActivity = {
  /** "Varad created Acme Corp" */
  sentence: string;
  /** Optional sub-line, e.g. stage transition. */
  detail?: string;
};

/**
 * Render an activity row into a human-readable sentence. Falls back to a
 * generic "<actor> <action> <entity>" form if the metadata doesn't carry
 * the named field for that action — keeps the timeline rendering total
 * even on legacy / future event shapes.
 */
export function formatActivity(row: ActivityRow): FormattedActivity {
  const actor = row.actor?.displayName ?? 'Someone';
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const entityLabel = ENTITY_LABEL[row.entityType as ActivityEntityType] ?? row.entityType;
  const name =
    typeof meta.name === 'string'
      ? meta.name
      : typeof meta.email === 'string'
        ? meta.email
        : null;

  const action = row.action as ActivityAction;

  switch (action) {
    case 'created':
      return {
        sentence: name
          ? `${actor} created ${entityLabel} ${name}`
          : `${actor} created a ${entityLabel}`,
      };
    case 'updated':
      return {
        sentence: name
          ? `${actor} updated ${entityLabel} ${name}`
          : `${actor} updated a ${entityLabel}`,
      };
    case 'deleted':
      return {
        sentence: name
          ? `${actor} deleted ${entityLabel} ${name}`
          : `${actor} deleted a ${entityLabel}`,
      };
    case 'restored':
      return {
        sentence: name
          ? `${actor} restored ${entityLabel} ${name}`
          : `${actor} restored a ${entityLabel}`,
      };
    case 'stage_changed': {
      const from = typeof meta.from === 'string' ? meta.from : null;
      const to = typeof meta.to === 'string' ? meta.to : null;
      const base = name
        ? `${actor} moved deal ${name}`
        : `${actor} moved a deal`;
      if (from && to) {
        return {
          sentence: `${base} from ${from} to ${to}`,
        };
      }
      if (to) {
        return { sentence: `${base} to ${to}` };
      }
      return { sentence: `${base}` };
    }
    case 'invited': {
      const email = typeof meta.email === 'string' ? meta.email : 'a teammate';
      const role = typeof meta.role === 'string' ? meta.role : null;
      return {
        sentence: role
          ? `${actor} invited ${email} as ${role}`
          : `${actor} invited ${email}`,
      };
    }
    case 'invitation_revoked': {
      const email = typeof meta.email === 'string' ? meta.email : 'a teammate';
      return { sentence: `${actor} revoked invitation to ${email}` };
    }
    case 'member_removed': {
      const target = typeof meta.targetName === 'string'
        ? meta.targetName
        : typeof meta.targetUserId === 'string'
          ? meta.targetUserId
          : 'a member';
      return { sentence: `${actor} removed ${target}` };
    }
    case 'task_completed': {
      const taskTitle =
        typeof meta.taskTitle === 'string' ? meta.taskTitle : name;
      return {
        sentence: taskTitle
          ? `${actor} completed task ${taskTitle}`
          : `${actor} completed a task`,
      };
    }
    case 'owner_changed': {
      const toName =
        typeof meta.toName === 'string' ? meta.toName : null;
      const target = name ?? entityLabel;
      return {
        sentence: toName
          ? `${actor} reassigned ${target} to ${toName}`
          : `${actor} changed the owner on ${target}`,
      };
    }
    case 'automation_note': {
      // Workflows write a structured payload; the message is human-ready
      // and the actor display ("Someone") is replaced with "Automation".
      const message =
        typeof meta.message === 'string'
          ? meta.message
          : `Automation event on ${entityLabel}`;
      const workflow =
        typeof meta.workflow === 'string' ? meta.workflow : undefined;
      return {
        sentence: `Automation: ${message}`,
        detail: workflow ? `Workflow: ${workflow}` : undefined,
      };
    }
    case 'role_changed': {
      const target = typeof meta.targetName === 'string'
        ? meta.targetName
        : typeof meta.targetUserId === 'string'
          ? meta.targetUserId
          : 'a member';
      const to = typeof meta.to === 'string' ? meta.to : null;
      return {
        sentence: to
          ? `${actor} changed ${target}'s role to ${to}`
          : `${actor} changed ${target}'s role`,
      };
    }
    default: {
      // Defense in depth: a webhook event later adds a new action and we
      // forget to update this switch — render something readable instead
      // of crashing the timeline render.
      const fallback = String(action).replace(/_/g, ' ');
      return {
        sentence: `${actor} ${fallback} a ${entityLabel}`,
      };
    }
  }
}

/**
 * Locale-stable relative time, e.g. "5m ago" / "2h ago" / "May 7".
 * Avoids hydration mismatches by using only static comparisons + a fixed
 * formatter for older dates.
 */
const absoluteFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export function formatRelativeTime(date: Date | string, now: Date = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Math.max(0, now.getTime() - d.getTime());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return absoluteFormatter.format(d);
}
