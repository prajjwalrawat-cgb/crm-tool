'use client';

import { Eye } from 'lucide-react';

import { useEntityViewers } from '@/hooks/use-entity-viewers';
import { cn } from '@/lib/utils';

/**
 * "X is viewing this deal" indicator — a stacked-avatar strip plus a
 * short label. Renders nothing when there are no remote viewers, so
 * it's safe to drop into any entity detail header.
 *
 * Hook handles publishing the local user's viewing.started/stopped
 * and decaying remote peers — this component is purely presentational.
 */
export function EntityViewers({
  tenantId,
  currentUserId,
  entityType,
  entityId,
  className,
}: {
  tenantId: string;
  currentUserId: string;
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
  className?: string;
}) {
  const viewers = useEntityViewers({
    tenantId,
    currentUserId,
    entityType,
    entityId,
  });

  if (viewers.length === 0) return null;

  // Cap the stack at 3 visible avatars; show a "+N" pill for the rest.
  const visible = viewers.slice(0, 3);
  const overflow = viewers.length - visible.length;
  const label =
    viewers.length === 1
      ? `${viewers[0]?.displayName ?? 'Someone'} is viewing`
      : `${viewers.length} people viewing`;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] text-slate-600 backdrop-blur-sm dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]',
        className,
      )}
      title={viewers.map((v) => v.displayName ?? v.userId).join(', ')}
    >
      <Eye className="h-3 w-3 text-emerald-500" aria-hidden />
      <div className="-space-x-1.5">
        {visible.map((v) => (
          <Avatar
            key={v.userId}
            displayName={v.displayName}
            imageUrl={v.imageUrl}
          />
        ))}
        {overflow > 0 ? (
          <span
            className="relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-slate-700 ring-2 ring-white dark:bg-slate-700 dark:text-[#FAFAFA] dark:ring-black"
            aria-hidden
          >
            +{overflow}
          </span>
        ) : null}
      </div>
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}

function Avatar({
  displayName,
  imageUrl,
}: {
  displayName: string | null;
  imageUrl: string | null;
}) {
  const initial = (displayName ?? '?').slice(0, 1).toUpperCase();
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={displayName ?? ''}
        className="relative h-5 w-5 rounded-full object-cover ring-2 ring-white dark:ring-black"
      />
    );
  }
  return (
    <span
      className="relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-semibold text-white ring-2 ring-white dark:ring-black"
      aria-hidden
    >
      {initial}
    </span>
  );
}
