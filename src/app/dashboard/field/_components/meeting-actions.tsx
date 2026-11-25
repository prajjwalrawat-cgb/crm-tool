'use client';

import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import type { DayMeeting } from '@/lib/field/day';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import { editErrorText } from '../_lib/meeting-edit';
import { FieldSheet } from './field-sheet';
import { MeetingForm } from './meeting-form';

/** "Cancel meeting": confirm with an optional reason, then POST /meetings/:id/cancel. */
export function CancelMeetingSheet({
  meeting,
  onClose,
  onDone,
}: {
  meeting: Pick<DayMeeting, 'id' | 'title'>;
  onClose: () => void;
  onDone: () => void;
}) {
  const ids = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await fieldApi(`/meetings/${meeting.id}/cancel`, { body: reason.trim() ? { reason: reason.trim() } : {} });
    setBusy(false);
    if (!res.ok) return setError(editErrorText(res));
    toast.success('Meeting cancelled');
    onDone();
  }

  return (
    <FieldSheet
      title="Cancel meeting?"
      description={meeting.title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} className="min-h-10 px-4">
            Keep meeting
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy} className="min-h-10 px-4">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Cancel meeting
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        <label htmlFor={`${ids}-reason`} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
          Reason (optional)
        </label>
        <textarea
          id={`${ids}-reason`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="e.g. Client postponed"
          className={cn(inputCls, 'min-h-10 text-[14px] sm:text-[13px]')}
          disabled={busy}
        />
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-rose-600">
          {error}
        </p>
      ) : null}
    </FieldSheet>
  );
}

/** "Edit": MeetingForm in edit mode inside a sheet. */
export function EditMeetingSheet({
  meeting,
  ownersInScope,
  onClose,
  onSaved,
}: {
  meeting: DayMeeting;
  ownersInScope: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <FieldSheet title="Edit meeting" onClose={onClose}>
      <MeetingForm
        meeting={meeting}
        defaultOwnerId={meeting.ownerId}
        ownersInScope={ownersInScope}
        onSaved={() => {
          toast.success('Meeting updated');
          onSaved();
        }}
      />
    </FieldSheet>
  );
}
