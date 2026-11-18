'use client';

import { Loader2, Phone, PhoneOff } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { startCall } from '../../telephony/actions';
import { useTelephonyReady } from './telephony-ready';

export const CALL_STARTED_EVENT = 'saleinx:call-started';

/**
 * List-row variant: renders only when the current user can place calls
 * (telephony set up + phone mapped). DNC is enforced server-side on click.
 */
export function RowCallButton(props: { contactId?: string | null; leadId?: string | null; phone?: string | null }) {
  const ready = useTelephonyReady();
  if (!ready || !props.phone) return null;
  return <ClickToCallButton {...props} size="xs" />;
}

/**
 * Phone icon button: rings the rep's own phone first, then the customer
 * (provider click-to-call). Disabled with a tooltip when the number is on the
 * do-not-call list or there is no number. Managers outside calling hours get a
 * confirm prompt; reps are blocked.
 */
export function ClickToCallButton({
  leadId,
  contactId,
  phone,
  dnc = false,
  disabledReason,
  label,
  size = 'sm',
  className,
}: {
  leadId?: string | null;
  contactId?: string | null;
  phone?: string | null;
  dnc?: boolean;
  /** Overrides the tooltip when the button can't be used for another reason. */
  disabledReason?: string | null;
  label?: string;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const reason = dnc ? 'On the do-not-call list' : disabledReason ?? (!leadId && !contactId && !phone ? 'No phone number' : null);

  function call(overrideHours = false) {
    startTransition(async () => {
      const r = await startCall({ leadId: leadId ?? null, contactId: contactId ?? null, phone: phone ?? null, overrideHours });
      if (r.ok) {
        toast.success('Calling… your phone will ring first.');
        window.dispatchEvent(new CustomEvent(CALL_STARTED_EVENT, { detail: { callId: r.callId } }));
        return;
      }
      if (r.code === 'outside_hours' && !overrideHours && r.message.includes('Confirm')) {
        if (window.confirm('This is outside the workspace calling hours. Call anyway?')) call(true);
        return;
      }
      toast.error(r.message);
    });
  }

  const Icon = dnc ? PhoneOff : pending ? Loader2 : Phone;
  return (
    <button
      type="button"
      onClick={() => call()}
      disabled={!!reason || pending}
      title={reason ?? 'Call (rings your phone first)'}
      aria-label={reason ? `Call unavailable: ${reason}` : label ?? 'Call'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]',
        'border-slate-200 bg-white text-slate-700 hover:border-emerald-300 hover:text-emerald-700 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#E4E4E7] dark:hover:border-emerald-500/40 dark:hover:text-emerald-300',
        className,
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', pending && 'animate-spin')} aria-hidden />
      {label ? <span>{label}</span> : null}
    </button>
  );
}
