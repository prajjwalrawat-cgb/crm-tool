'use client';

import { Mail } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { updateEmailSettingsAction } from '../../actions';
import {
  InputRow,
  SettingsForm,
  SettingsSection,
  TextareaRow,
  ToggleRow,
} from '../../_components/settings-form';

type Values = {
  senderName: string;
  senderEmail: string;
  defaultSignature: string;
  replyTo: string;
  autoBcc: string;
  emailTracking: boolean;
};

export function EmailForm({ initial }: { initial: Values }) {
  const formRef = useRef<HTMLDivElement>(null);

  const collect = useCallback((): Values => {
    const root = formRef.current;
    if (!root) return initial;
    const readInput = (name: string) =>
      (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null)
        ?.value ?? '';
    const readCheck = (name: string) =>
      (root.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.checked ?? false;
    return {
      senderName: readInput('senderName'),
      senderEmail: readInput('senderEmail'),
      defaultSignature: readInput('defaultSignature'),
      replyTo: readInput('replyTo'),
      autoBcc: readInput('autoBcc'),
      emailTracking: readCheck('emailTracking'),
    };
  }, [initial]);

  return (
    <div ref={formRef}>
      <SettingsForm initial={initial} action={updateEmailSettingsAction} collectChanges={collect}>
        <SettingsSection
          title="Email"
          description="Outbound sender identity, signature, and delivery tracking preferences."
          icon={Mail}
        >
          <InputRow
            name="senderName"
            label="Sender name"
            description="Appears in the From field. Defaults to the workspace name if blank."
            defaultValue={initial.senderName}
            placeholder="Saleinx Team"
          />
          <InputRow
            name="senderEmail"
            label="Sender email"
            description="Address outgoing CRM mail is sent from."
            defaultValue={initial.senderEmail}
            type="email"
            placeholder="hello@example.com"
          />
          <InputRow
            name="replyTo"
            label="Reply-to address"
            description="Where replies should go. Leave blank to use the sender email."
            defaultValue={initial.replyTo}
            type="email"
            placeholder="replies@example.com"
          />
          <InputRow
            name="autoBcc"
            label="Auto-BCC"
            description="Comma-separated addresses BCC'd on every outbound send. Optional."
            defaultValue={initial.autoBcc}
            placeholder="archive@example.com"
          />
          <TextareaRow
            name="defaultSignature"
            label="Default signature"
            description="Appended to outgoing emails when the composer hasn't overridden it."
            defaultValue={initial.defaultSignature}
            rows={4}
            placeholder="Best, the team"
          />
          <ToggleRow
            name="emailTracking"
            label="Open tracking"
            description="Inject a 1×1 pixel into HTML emails so we record opens (CP#16C-D)."
            defaultChecked={initial.emailTracking}
          />
        </SettingsSection>
      </SettingsForm>
    </div>
  );
}
