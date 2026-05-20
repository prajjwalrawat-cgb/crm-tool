'use client';

import { Bell } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { updateNotificationSettingsAction } from '../../actions';
import {
  SettingsForm,
  SettingsSection,
  ToggleRow,
} from '../../_components/settings-form';

type Values = {
  notifyAssignments: boolean;
  notifyRecommendations: boolean;
  notifyWorkflows: boolean;
  notifyEmailEvents: boolean;
  realtimeEnabled: boolean;
};

export function NotificationsForm({ initial }: { initial: Values }) {
  const formRef = useRef<HTMLDivElement>(null);

  const collect = useCallback((): Values => {
    const root = formRef.current;
    if (!root) return initial;
    const read = (name: keyof Values) =>
      (root.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)
        ?.checked ?? false;
    return {
      notifyAssignments: read('notifyAssignments'),
      notifyRecommendations: read('notifyRecommendations'),
      notifyWorkflows: read('notifyWorkflows'),
      notifyEmailEvents: read('notifyEmailEvents'),
      realtimeEnabled: read('realtimeEnabled'),
    };
  }, [initial]);

  return (
    <div ref={formRef}>
      <SettingsForm
        initial={initial}
        action={updateNotificationSettingsAction}
        collectChanges={collect}
      >
        <SettingsSection
          title="Notifications"
          description="Workspace-wide defaults. Per-user overrides ship in a follow-up release."
          icon={Bell}
        >
          <ToggleRow
            name="notifyAssignments"
            label="Task assignments"
            description="Email when someone assigns you a task or reassigns a deal you own."
            defaultChecked={initial.notifyAssignments}
          />
          <ToggleRow
            name="notifyRecommendations"
            label="AI recommendations"
            description="Surface accept/dismiss reminders when the recommendation set refreshes."
            defaultChecked={initial.notifyRecommendations}
          />
          <ToggleRow
            name="notifyWorkflows"
            label="Workflow notifications"
            description="Send a notification when an automation triggers, completes, or fails."
            defaultChecked={initial.notifyWorkflows}
          />
          <ToggleRow
            name="notifyEmailEvents"
            label="Email events"
            description="Send a notification when an outbound email is delivered, replied to, or bounces."
            defaultChecked={initial.notifyEmailEvents}
          />
          <ToggleRow
            name="realtimeEnabled"
            label="Realtime updates"
            description="Stream live updates (new comments, deal changes, recommendations) over SSE while the app is open."
            defaultChecked={initial.realtimeEnabled}
          />
        </SettingsSection>
      </SettingsForm>
    </div>
  );
}
