'use client';

import { Copy, GripVertical, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import { useEditMode } from './edit-mode-context';

/**
 * Edit-mode chrome attached to every editable chart. Renders nothing
 * in view mode — the dashboard looks identical to before. When edit
 * mode toggles on (Cmd/Ctrl+Shift+E), it surfaces:
 *
 *   - a drag handle (top-left corner of the chart frame)
 *   - duplicate + delete buttons (top-right)
 *   - a dashed indigo outline so the widget feels "selectable"
 *
 * `kind` distinguishes built-in charts (composed into the page) from
 * user-created widget instances:
 *   - 'builtin' → duplicate/delete are visible but disabled with a
 *     tooltip ("Built-in widget — can't be removed in this phase")
 *   - 'instance' → duplicate/delete will be wired to the
 *     dashboard_widgets table in the next phase
 *
 * Actual drag/drop + persistence land alongside the
 * `react-grid-layout` integration in the next phase. This component
 * provides the *visual* edit affordance so the keyboard toggle has
 * something to do today.
 */
export function ChartEditChrome({
  kind = 'builtin',
}: {
  kind?: 'builtin' | 'instance';
}) {
  const { editMode } = useEditMode();
  if (!editMode) return null;

  return (
    <>
      {/* Dashed outline — purely visual, doesn't block clicks */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl border border-dashed border-indigo-400/60 dark:border-indigo-400/50"
      />

      {/* Top-left drag handle (visual only — drag wiring comes with
          react-grid-layout in next phase) */}
      <div className="absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 shadow-sm backdrop-blur-sm dark:border-indigo-500/40 dark:bg-[#0A0A0A]/90 dark:text-indigo-200">
        <GripVertical className="h-3 w-3" aria-hidden />
        Drag
      </div>

      {/* Top-right actions */}
      <div className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white/90 px-1 py-0.5 shadow-sm backdrop-blur-sm dark:border-indigo-500/40 dark:bg-[#0A0A0A]/90">
        <ChromeButton
          icon={Copy}
          label="Duplicate"
          disabled={kind === 'builtin'}
          tooltip={
            kind === 'builtin'
              ? "Built-in widget — duplicate lands with the widget builder phase"
              : 'Duplicate widget'
          }
        />
        <ChromeButton
          icon={Trash2}
          label="Remove"
          danger
          disabled={kind === 'builtin'}
          tooltip={
            kind === 'builtin'
              ? "Built-in widget — can't be removed"
              : 'Remove widget'
          }
        />
      </div>
    </>
  );
}

function ChromeButton({
  icon: Icon,
  label,
  danger,
  disabled,
  tooltip,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  tooltip?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tooltip ?? label}
      aria-label={label}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded transition',
        disabled
          ? 'cursor-not-allowed text-slate-300 dark:text-[#3F3F46]'
          : danger
            ? 'text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/15 dark:hover:text-rose-200'
            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-[#A1A1AA] dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]',
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
    </button>
  );
}
