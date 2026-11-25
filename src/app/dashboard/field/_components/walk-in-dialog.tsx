'use client';

import { Loader2, MapPinned } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import type { GeoPosition } from '../_lib/geolocate';
import { usePosition } from '../_lib/use-position';
import { EntitySearchSelect, type EntityChoice } from './entity-search-select';
import { FieldSheet } from './field-sheet';
import { PositionPrompt } from './position-prompt';

const fieldCls = cn(inputCls, 'min-h-10 text-[14px] sm:text-[13px]');

/**
 * Unplanned visit: creates a meeting at the rep's current position and checks
 * them in, in one step. Links are optional (an unlinked walk-in is flagged for
 * linking later). A failed send keeps the fix so Retry does not re-locate.
 */
export function WalkInDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (meetingId: string) => void }) {
  const ids = useId();
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState<EntityChoice | null>(null);
  const [deal, setDeal] = useState<EntityChoice | null>(null);
  const [contact, setContact] = useState<EntityChoice | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ pos: GeoPosition; message: string } | null>(null);
  const position = usePosition((pos) => void send(pos));

  async function send(pos: GeoPosition) {
    setBusy(true);
    setFailed(null);
    const res = await fieldApi<{ id: string }>('/meetings/walk-in', {
      body: {
        lat: pos.lat,
        lng: pos.lng,
        accuracyM: pos.accuracyM,
        title: title.trim() || (company ? `Walk-in: ${company.label}` : undefined),
        companyId: company?.id ?? null,
        dealId: deal?.id ?? null,
        contactId: contact?.id ?? null,
        notes: notes.trim() || null,
      },
    });
    setBusy(false);
    if (!res.ok) return setFailed({ pos, message: res.error });
    toast.success('Walk-in logged and checked in');
    onSaved(res.data.id);
  }

  const working = busy || position.state.kind === 'locating';

  return (
    <FieldSheet
      title="Log walk-in"
      description="An unplanned visit. You will be checked in where you are now."
      onClose={onClose}
      busy={working}
      footer={
        <>
          <Button onClick={onClose} disabled={working} className="min-h-11 px-4">
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={working}
            onClick={() => (failed ? void send(failed.pos) : void position.locate())}
            className="min-h-11 px-4 text-[14px]"
          >
            {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MapPinned className="h-4 w-4" aria-hidden />}
            {failed ? 'Retry' : 'Check in here'}
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        <label htmlFor={`${ids}-title`} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
          Title (optional)
        </label>
        <input
          id={`${ids}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={300}
          placeholder="Walk-in"
          className={fieldCls}
          disabled={working}
        />
      </div>
      <EntitySearchSelect kind="company" label="Company (optional)" value={company} onChange={setCompany} disabled={working} />
      <EntitySearchSelect kind="deal" label="Deal (optional)" value={deal} onChange={setDeal} disabled={working} />
      <EntitySearchSelect kind="contact" label="Contact (optional)" value={contact} onChange={setContact} disabled={working} />
      <div className="space-y-1">
        <label htmlFor={`${ids}-notes`} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
          Notes (optional)
        </label>
        <textarea
          id={`${ids}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={fieldCls}
          disabled={working}
        />
      </div>

      <p className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">Your location is saved with this check-in</p>
      <PositionPrompt state={position.state} onRetry={() => void position.locate()} onContinue={position.accept} />
      {failed ? (
        <p role="alert" className="text-[12.5px] text-rose-600">
          {failed.message}
        </p>
      ) : null}
    </FieldSheet>
  );
}
