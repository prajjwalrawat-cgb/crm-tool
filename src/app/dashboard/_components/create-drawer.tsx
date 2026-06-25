'use client';

import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Drawer } from './drawer';

/**
 * Trigger button + Drawer wrapper used by entity index pages to host
 * their create-X forms. Replaces the old 360px side rail — main content
 * gets the full width back, and the create form opens on demand.
 *
 * The drawer body just renders whatever `children` it's given (the
 * existing CreateXForm components, with their card chrome stripped).
 * `closeOnSuccessKey` lets the parent close the drawer after a
 * successful submit by bumping a counter — this matches the pattern
 * the create forms already use to reset themselves.
 */
type Props = {
  /** Visible label on the trigger ("New deal", "New contact", …). */
  label: string;
  /** Drawer title once opened. */
  drawerTitle: string;
  /** Optional one-line description rendered under the drawer title. */
  description?: string;
  /** Bumped on successful submit by the parent — closes the drawer. */
  closeOnSuccessKey?: number;
  /** Disables the trigger when the user lacks the relevant permission. */
  disabled?: boolean;
  /** Max-width Tailwind class for the drawer panel. */
  widthClass?: string;
  children: (close: () => void) => ReactNode;
};

export function CreateDrawer({
  label,
  drawerTitle,
  description,
  closeOnSuccessKey,
  disabled,
  widthClass,
  children,
}: Props) {
  const [open, setOpen] = useState(false);

  // Close after the parent reports a successful submit (resetKey
  // increments on the create-form contract). We track the latest seen
  // value and close exactly once when it changes while the drawer is
  // open.
  const [lastSeenKey, setLastSeenKey] = useState<number | undefined>(
    closeOnSuccessKey,
  );
  if (closeOnSuccessKey !== lastSeenKey) {
    setLastSeenKey(closeOnSuccessKey);
    if (open) setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition',
          'hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          '',
        )}
      >
        <Plus className="h-4 w-4" aria-hidden />
        {label}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={drawerTitle}
        description={description}
        widthClass={widthClass}
      >
        {children(() => setOpen(false))}
      </Drawer>
    </>
  );
}
